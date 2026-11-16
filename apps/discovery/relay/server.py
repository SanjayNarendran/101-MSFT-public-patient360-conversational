"""Cohort Discovery chat relay: GitHub Copilot for the Discovery tab of the cohort-approval Fabric app.

Browser (Fabric app) --chat + ticket--> this server --Copilot SDK--> Copilot runtime --> Copilot models
        ^                                    |
        +----- tool_request / tool-result <--+   the page runs each tool through the app's Rayfin Functions

- Every call carries a chat ticket: a short-lived token signed (HMAC-SHA256) by the app's chatTicket function with a
  key this server shares, naming the signed-in Fabric user. Nothing is served without a valid ticket.
- Each Fabric user signs in to GitHub once (OAuth popup). The token stays in this process's memory, keyed to the
  Fabric user, and their chat sessions run on it, so questions use the user's own Copilot plan.
- The SDK runs in mode "empty": no shell, file or other built-in tools, only the cohort tools, and those are executed
  by the page. This server has no access to Fabric data.

The local app (apps/discovery/app.py) is the single-user version of the same chat; tools.json holds its tool
definitions and rules (written by scripts/23_discovery_chat.py).

Environment: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, CHAT_TICKET_KEY, ALLOWED_ORIGIN (comma-separated app origins),
PUBLIC_URL (this server's address), PORT (default 8080), LOCAL_CORS=1 when not behind Container Apps ingress.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode

import httpx
import uvicorn
from copilot import CopilotClient
from copilot.generated.rpc import ModelsListRequest
from copilot.generated.session_events import AssistantReasoningDeltaData, AssistantStreamingDeltaData
from copilot.session import PermissionHandler
from copilot.session_events import (AssistantMessageData, AssistantMessageDeltaData, SessionErrorData,
                                    SessionIdleData, ToolExecutionCompleteData, ToolExecutionStartData)
from copilot.tools import Tool, ToolInvocation, ToolResult
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.routing import Route

HERE = Path(__file__).resolve().parent
SPEC = json.loads((HERE / "tools.json").read_text())
CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
TICKET_KEY = os.environ.get("CHAT_TICKET_KEY", "").encode()
ORIGINS = [o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGIN", "").split(",") if o.strip()]
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")
DEFAULT_MODEL = os.environ.get("COHORT_MODEL", SPEC.get("default_model", "claude-sonnet-5.5"))
DEFAULT_EFFORT = os.environ.get("COHORT_EFFORT", "medium")
SCOPE = "read:user"
TOOL_TIMEOUT = 300        # seconds the page has to run one tool
CHAT_IDLE = 45 * 60       # chats unused this long are closed
KEEPALIVE = 15            # seconds between pings on a quiet stream (ingress drops idle connections)
WORK_DIR = Path(os.environ.get("COPILOT_WORK_DIR") or Path(tempfile.gettempdir()) / "cohort-chat")

client: CopilotClient | None = None


# --- chat tickets (issued by the app's chatTicket function) -----------------------------------------------------------
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def verify_ticket(raw: str | None) -> dict | None:
    """{'oid', 'upn', 'exp'} of a valid ticket, else None. A ticket is base64url(JSON) + '.' + base64url(HMAC)."""
    if not raw or not TICKET_KEY or raw.count(".") != 1:
        return None
    body, sig = raw.split(".")
    if not hmac.compare_digest(sig, _b64(hmac.new(TICKET_KEY, body.encode(), hashlib.sha256).digest())):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except ValueError:
        return None
    now = time.time()
    if not isinstance(data, dict) or not (now < float(data.get("exp", 0)) <= now + 3700):
        return None
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", str(data.get("oid", ""))):
        return None
    return data


# --- GitHub sign-in (OAuth web flow; one token per Fabric user, in memory only) ---------------------------------------
@dataclass
class GitHubUser:
    login: str
    token: str
    refresh_token: str | None
    expires_at: float | None
    refresh_expires_at: float | None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


users: dict[str, GitHubUser] = {}       # by Fabric object ID
pending: dict[str, dict] = {}           # OAuth state -> {oid, origin, at}


def _expiry(payload: dict, key: str) -> float | None:
    return time.time() + int(payload[key]) if payload.get(key) else None


async def github_token(oid: str) -> GitHubUser | None:
    """The user's GitHub sign-in, refreshed when the access token is about to expire."""
    user = users.get(oid)
    if not user or not user.expires_at or user.expires_at - 300 > time.time():
        return user
    async with user.lock:
        if user.expires_at and user.expires_at - 300 > time.time():
            return user
        if not user.refresh_token or (user.refresh_expires_at and user.refresh_expires_at < time.time()):
            users.pop(oid, None)
            return None
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
                                data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                                      "grant_type": "refresh_token", "refresh_token": user.refresh_token})
        payload = r.json() if r.status_code == 200 else {}
        if "access_token" not in payload:
            users.pop(oid, None)
            return None
        user.token, user.refresh_token = payload["access_token"], payload.get("refresh_token", user.refresh_token)
        user.expires_at = _expiry(payload, "expires_in")
        user.refresh_expires_at = _expiry(payload, "refresh_token_expires_in") or user.refresh_expires_at
        return user


def public_url(req: Request) -> str:
    return PUBLIC_URL or str(req.base_url).rstrip("/")


def allowed_origin(origin: str | None) -> str | None:
    origin = (origin or "").rstrip("/")
    return origin if origin in ORIGINS else (ORIGINS[0] if ORIGINS else None)


async def auth_start(req: Request):
    ticket = verify_ticket(req.query_params.get("ticket"))
    if not ticket:
        return popup_page("This sign-in link has expired. Close this window and select Sign in with GitHub again.")
    state = secrets.token_urlsafe(24)
    pending[state] = {"oid": ticket["oid"], "origin": allowed_origin(req.query_params.get("origin")), "at": time.time()}
    query = urlencode({"client_id": CLIENT_ID, "redirect_uri": f"{public_url(req)}/auth/github/callback",
                       "state": state, "scope": SCOPE, "allow_signup": "false", "prompt": "select_account"})
    return RedirectResponse(f"https://github.com/login/oauth/authorize?{query}", status_code=302)


async def auth_callback(req: Request):
    started = pending.pop(req.query_params.get("state", ""), None)
    if not started or time.time() - started["at"] > 600:
        return popup_page("This sign-in has expired. Close this window and try again.")
    if req.query_params.get("error"):
        return popup_page(f"GitHub sign-in was cancelled ({req.query_params['error']}).", origin=started["origin"])
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
                            data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                                  "code": req.query_params.get("code", ""),
                                  "redirect_uri": f"{public_url(req)}/auth/github/callback"})
        payload = r.json() if r.status_code == 200 else {}
        if "access_token" not in payload:
            return popup_page(f"GitHub didn't issue a token ({payload.get('error_description') or r.status_code}).",
                              origin=started["origin"])
        me = await http.get("https://api.github.com/user", headers={
            "Authorization": f"Bearer {payload['access_token']}", "Accept": "application/vnd.github+json"})
    login = me.json().get("login", "?") if me.status_code == 200 else "?"
    users[started["oid"]] = GitHubUser(login, payload["access_token"], payload.get("refresh_token"),
                                       _expiry(payload, "expires_in"), _expiry(payload, "refresh_token_expires_in"))
    return popup_page(f"Signed in to GitHub as {login}. You can close this window.", ok=True,
                      origin=started["origin"], login=login)


def popup_page(text: str, ok: bool = False, origin: str | None = None, login: str | None = None) -> HTMLResponse:
    message = json.dumps({"type": "cohort-github", "ok": ok, "login": login})
    script = (f"<script>try{{window.opener&&window.opener.postMessage({message},{json.dumps(origin)});}}catch(e){{}}"
              f"{'setTimeout(function(){window.close()},700);' if ok else ''}</script>") if origin else ""
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>GitHub sign-in</title>"
        "<body style=\"font:15px/1.5 system-ui,sans-serif;color:#1c1b19;background:#fbfaf7;margin:0;display:grid;"
        "place-items:center;height:100vh\"><p style=\"max-width:380px;padding:0 24px\">"
        f"{html.escape(text)}</p>{script}</body>", headers={"Cache-Control": "no-store"})


# --- chats ----------------------------------------------------------------------------------------------------------
@dataclass
class Chat:
    oid: str
    mode: str
    model: str
    effort: str | None
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    session: object = None
    queue: asyncio.Queue | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    last_ping: float = 0.0
    used: float = field(default_factory=time.time)

    def emit(self, event: dict) -> None:
        if self.queue:
            self.queue.put_nowait(event)


chats: dict[str, Chat] = {}
by_session: dict[str, Chat] = {}


async def relay_tool(inv: ToolInvocation) -> ToolResult:
    """Hands the call to the page (which runs it through the app's functions) and waits for its answer."""
    chat = by_session.get(inv.session_id)
    if not chat or not chat.queue:
        return ToolResult(text_result_for_llm="The page that asked this question is no longer open.", result_type="failure")
    future = asyncio.get_running_loop().create_future()
    chat.pending[inv.tool_call_id] = future
    chat.emit({"type": "tool_request", "id": inv.tool_call_id, "name": inv.tool_name, "arguments": inv.arguments or {}})
    try:
        result = await asyncio.wait_for(future, TOOL_TIMEOUT)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        return ToolResult(text_result_for_llm=f"{inv.tool_name} did not finish.", result_type="failure")
    finally:
        chat.pending.pop(inv.tool_call_id, None)
    return ToolResult(text_result_for_llm=str(result.get("text", ""))[:200_000],
                      result_type="success" if result.get("ok") else "failure")


TOOLS = {mode: [Tool(name=t["name"], description=t["description"], parameters=t["parameters"], handler=relay_tool,
                     skip_permission=True) for t in SPEC[mode]["tools"]] for mode in ("i2b2", "dax")}


def token_provider(oid: str):
    async def provide(_args):
        user = await github_token(oid)
        if not user:
            return {"kind": "cancelled"}
        return {"kind": "token", "accessToken": user.token,
                "expiresIn": max(60, int((user.expires_at or time.time() + 8 * 3600) - time.time()))}
    return provide


async def new_chat(oid: str, mode: str, model: str, effort: str | None) -> Chat:
    chat = Chat(oid, mode, model, effort)
    loop = asyncio.get_running_loop()
    tools = TOOLS[mode]
    chat.session = await client.create_session(
        model=model, reasoning_effort=effort, github_token_provider=token_provider(oid), streaming=True,
        tools=tools, available_tools=[f"custom:{t.name}" for t in tools],
        on_permission_request=PermissionHandler.approve_all, working_directory=str(WORK_DIR),
        skip_custom_instructions=True, enable_skills=False,
        system_message={"mode": "customize", "sections": {
            "code_change_rules": {"action": "remove"},
            "environment_context": {"action": "remove"},
            "guidelines": {"action": "append", "content": "\n" + SPEC[mode]["rules"]}}})
    chat.session.on(lambda e: loop.call_soon_threadsafe(forward, chat, e))
    chats[chat.id] = chat
    by_session[chat.session.session_id] = chat
    return chat


def forward(chat: Chat, event) -> None:
    """Copilot session event -> NDJSON event for the page (the same events as the local app)."""
    match event.data:
        case AssistantMessageDeltaData() as d if not d.parent_tool_call_id:
            chat.emit({"type": "delta", "id": d.message_id, "text": d.delta_content})
        case AssistantMessageData() as d if not d.parent_tool_call_id:
            chat.emit({"type": "message", "id": d.message_id, "text": d.content})
        case AssistantReasoningDeltaData() | AssistantStreamingDeltaData():
            now = time.monotonic()
            if now - chat.last_ping >= 1.0:
                chat.last_ping = now
                chat.emit({"type": "thinking"})
        case ToolExecutionStartData() as d:
            chat.emit({"type": "tool", "id": d.tool_call_id, "name": d.tool_name})
        case ToolExecutionCompleteData() as d:
            chat.emit({"type": "tool_done", "id": d.tool_call_id, "ok": d.success})
        case SessionErrorData() as d:
            chat.emit({"type": "error", "text": d.message})
        case SessionIdleData():
            chat.emit({"type": "done"})


async def close_chat(chat: Chat) -> None:
    chats.pop(chat.id, None)
    by_session.pop(getattr(chat.session, "session_id", ""), None)
    for future in chat.pending.values():
        future.cancel()
    with contextlib.suppress(Exception):
        await chat.session.disconnect()


async def janitor() -> None:
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for chat in [c for c in chats.values() if now - c.used > CHAT_IDLE and not c.pending]:
            await close_chat(chat)
        for state in [s for s, p in pending.items() if now - p["at"] > 600]:
            pending.pop(state, None)


# --- API ------------------------------------------------------------------------------------------------------------
def fail(text: str, status: int, code: str | None = None) -> JSONResponse:
    return JSONResponse({"error": text, **({"code": code} if code else {})}, status_code=status)


def ticket_of(req: Request) -> dict | None:
    return verify_ticket(req.headers.get("x-chat-ticket"))


NO_TICKET = "The chat ticket is missing or has expired; reload the page."


async def api_me(req: Request):
    ticket = ticket_of(req)
    if not ticket:
        return fail(NO_TICKET, 401, "ticket")
    user = await github_token(ticket["oid"])
    return JSONResponse({"user": ticket.get("upn"), "github": {"login": user.login} if user else None})


async def api_signout(req: Request):
    ticket = ticket_of(req)
    if not ticket:
        return fail(NO_TICKET, 401, "ticket")
    users.pop(ticket["oid"], None)
    for chat in [c for c in chats.values() if c.oid == ticket["oid"]]:
        await close_chat(chat)
    return JSONResponse({"ok": True})


async def api_models(req: Request):
    ticket = ticket_of(req)
    if not ticket:
        return fail(NO_TICKET, 401, "ticket")
    user = await github_token(ticket["oid"])
    if not user:
        return fail("Sign in to GitHub first.", 401, "github")
    seen, out = set(), []
    for m in (await client.rpc.models.list(ModelsListRequest(git_hub_token=user.token))).models:
        if m.id not in seen:
            seen.add(m.id)
            out.append({"id": m.id, "name": m.name, "efforts": m.supported_reasoning_efforts or [],
                        "default_effort": m.default_reasoning_effort})
    default = DEFAULT_MODEL if DEFAULT_MODEL in seen else next((m["id"] for m in out if "sonnet" in m["id"]),
                                                                 out[0]["id"] if out else None)
    return JSONResponse({"models": out, "default": default, "default_effort": DEFAULT_EFFORT})


async def api_chat(req: Request):
    ticket = ticket_of(req)
    if not ticket:
        return fail(NO_TICKET, 401, "ticket")
    oid = ticket["oid"]
    if not await github_token(oid):
        return fail("Sign in to GitHub first.", 401, "github")
    body = await req.json()
    prompt = (body.get("message") or "").strip()
    if not prompt:
        return fail("Ask a question.", 400)
    mode = "dax" if body.get("mode") == "dax" else "i2b2"
    model, effort = body.get("model") or DEFAULT_MODEL, body.get("effort") or None
    chat = chats.get(body.get("chat_id") or "")
    if chat and chat.oid != oid:
        chat = None
    builder = body.get("builder")
    if mode == "i2b2" and builder and builder.get("panels"):
        prompt = ("[Query builder] The page holds this i2b2 query definition"
                  + (f" (last run: QUERY_MASTER_ID {body['last_run']})" if body.get("last_run") else "")
                  + f":\n{json.dumps(builder)}\n\n" + prompt)

    async def stream():
        nonlocal chat
        finished = False
        try:
            if chat is None or (chat.mode, chat.model, chat.effort) != (mode, model, effort):
                if chat:
                    await close_chat(chat)
                chat = await new_chat(oid, mode, model, effort)
            chat.queue, chat.used = asyncio.Queue(), time.time()
            yield json.dumps({"type": "chat", "chat_id": chat.id, "mode": mode, "model": model}) + "\n"
            await chat.session.send(prompt)
            while True:
                try:
                    ev = await asyncio.wait_for(chat.queue.get(), KEEPALIVE)
                except asyncio.TimeoutError:
                    yield '{"type": "ping"}\n'
                    continue
                yield json.dumps(ev, default=str) + "\n"
                if ev["type"] in ("done", "error"):
                    finished = True
                    break
        except Exception as e:  # SDK or sign-in problems, shown in the chat
            finished = True
            yield json.dumps({"type": "error", "text": f"{type(e).__name__}: {e}"}) + "\n"
        finally:
            if chat:
                chat.used = time.time()
                if not finished:  # the page went away mid-answer
                    with contextlib.suppress(Exception):
                        await chat.session.abort()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


async def api_tool_result(req: Request):
    ticket = ticket_of(req)
    if not ticket:
        return fail(NO_TICKET, 401, "ticket")
    body = await req.json()
    chat = chats.get(body.get("chat_id") or "")
    if not chat or chat.oid != ticket["oid"]:
        return fail("Unknown chat.", 404)
    future = chat.pending.get(body.get("id") or "")
    if future and not future.done():
        future.set_result({"ok": bool(body.get("ok")), "text": body.get("text") or ""})
    return JSONResponse({"ok": True})


async def api_stop(req: Request):
    ticket = ticket_of(req)
    if not ticket:
        return fail(NO_TICKET, 401, "ticket")
    chat = chats.get((await req.json()).get("chat_id") or "")
    if chat and chat.oid == ticket["oid"]:
        with contextlib.suppress(Exception):
            await chat.session.abort()
        for future in chat.pending.values():
            future.cancel()
        chat.emit({"type": "done", "aborted": True})
    return JSONResponse({"ok": True})


async def healthz(_):
    return JSONResponse({"ok": True, "users": len(users), "chats": len(chats)})


@contextlib.asynccontextmanager
async def lifespan(_):
    global client
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    client = CopilotClient(mode="empty", base_directory=str(WORK_DIR / "home"), use_logged_in_user=False,
                           session_idle_timeout_seconds=CHAT_IDLE)
    await client.start()
    task = asyncio.create_task(janitor())
    yield
    task.cancel()
    for chat in list(chats.values()):
        await close_chat(chat)
    await client.stop()


middleware = [Middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST", "OPTIONS"],
                         allow_headers=["content-type", "x-chat-ticket"], max_age=3600)] \
    if os.environ.get("LOCAL_CORS") == "1" else []

app = Starlette(lifespan=lifespan, middleware=middleware, routes=[
    Route("/healthz", healthz),
    Route("/auth/github/start", auth_start), Route("/auth/github/callback", auth_callback),
    Route("/api/me", api_me), Route("/api/signout", api_signout, methods=["POST"]),
    Route("/api/models", api_models),
    Route("/api/chat", api_chat, methods=["POST"]), Route("/api/tool-result", api_tool_result, methods=["POST"]),
    Route("/api/stop", api_stop, methods=["POST"]),
])

if __name__ == "__main__":
    for name in ("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "CHAT_TICKET_KEY", "ALLOWED_ORIGIN"):
        if not os.environ.get(name):
            raise SystemExit(f"Set {name}.")
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 8080)),
                log_level="warning", access_log=False, proxy_headers=True, forwarded_allow_ips="*")
