"""Cohort Discovery: a local web app for cohort feasibility questions, answered by GitHub Copilot.

Browser  --POST /api/chat-->  this server  --Copilot SDK (JSON-RPC)-->  Copilot CLI runtime  -->  Copilot models
                                   ^                                          |
                                   +---- tool calls (run in-process) <--------+
                                         the cohort-discovery MCP tools (scripts/cohort_mcp.py), plus two DAX tools
                                         for the exploration mode; they query the Cohort Discovery semantic model

Two modes:
- i2b2 (default): Copilot maps the question to ontology terms, builds an i2b2 query and runs it; each run gets an i2b2
  QUERY_MASTER_ID with obfuscated counts and is recorded in the CRC store. The page shows the query as panels of
  chips, the counts with breakdown charts and the query history; the query can also be edited and run by hand.
- DAX: Copilot writes free DAX against the model; only obfuscated patient counts come back and nothing is recorded.

Submitting a query creates a data request, reviewed and approved in the approval app (apps/approval).

Run:  .venv/bin/python apps/discovery/app.py   then open http://127.0.0.1:8766
Needs: GitHub Copilot sign-in (`copilot login` or `gh auth login`), `az login`, and the Fabric capacity running.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from common import ensure_openssl  # noqa: E402

ensure_openssl()

import uvicorn  # noqa: E402
from copilot import CopilotClient  # noqa: E402
from copilot.generated.rpc import ModelsListRequest  # noqa: E402
from copilot.generated.session_events import AssistantReasoningDeltaData, AssistantStreamingDeltaData  # noqa: E402
from copilot.session import PermissionHandler  # noqa: E402
from copilot.session_events import (AssistantMessageData, AssistantMessageDeltaData, SessionErrorData,  # noqa: E402
                                    SessionIdleData, ToolExecutionCompleteData, ToolExecutionStartData)
from copilot.tools import Tool, ToolInvocation, ToolResult  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import FileResponse, JSONResponse, StreamingResponse  # noqa: E402
from starlette.routing import Route  # noqa: E402

import cohort_mcp  # noqa: E402  (the MCP server: tools, instructions and the shared CohortService)
from common import load_state  # noqa: E402

DEFAULT_MODEL = os.environ.get("COHORT_MODEL", "claude-sonnet-5.5")
DEFAULT_EFFORT = os.environ.get("COHORT_EFFORT", "medium")
COOKIE = "cohort_account"

I2B2_RULES = """
You are answering inside the Cohort Discovery app, beside the chat the researcher sees:
- the i2b2 query you build, drawn as panels of chips (it updates when you preview or run a query);
- after a run, the obfuscated patient count, breakdown charts (age, gender, race, vital status) and the query history.
So keep replies short and don't repeat what the page shows:
- After a run, give the QUERY_MASTER_ID and the count as "about N (±3)" (or "fewer than 4"), then 1-3 sentences on
  how you read the question: which folders or codes, which age bands, units and dates. Don't list the breakdowns.
- If a message starts with a [Query builder] block, that is the query on the page now; the researcher may have edited
  it by hand. Start from it when asked to refine or explain.
- Only submit a data request when the researcher asks; the page also has a Submit button.
- Don't mention tool names, JSON or DAX unless asked how you got the answer. Use light markdown."""

DAX_RULES = """
You are in the exploration mode of the Cohort Discovery app. Answer cohort-count questions by writing DAX against the
Cohort Discovery (i2b2) semantic model with explore_dax; read the model with describe_model first (tables, columns,
measures and its AI instructions on how to count a cohort), and use search_ontology to find terms.
- explore_dax returns only patient counts, obfuscated as for an i2b2 DATA_OBFSC user; patient-level columns, other
  numbers and more than 100 rows are refused, so always aggregate to counts.
- Count distinct patients: COUNTROWS(patient_dimension) for demographics, DISTINCTCOUNT(observation_fact[patient_num])
  or COUNTROWS of a VALUES(...) patient set for facts.
- A column added with ADDCOLUMNS or SELECTCOLUMNS is not a filter: grouping by it and then counting with CALCULATE
  repeats the whole total in every group. For bands or other computed groups, write one filtered count per group, e.g.
  UNION(ROW("Band", "50-64", "Patients", CALCULATE(COUNTROWS(patient_dimension),
  patient_dimension[age_in_years_num] >= 50, patient_dimension[age_in_years_num] <= 64)), ROW(...)), or group by model
  columns with SUMMARIZECOLUMNS(..., "Patients", <count>).
- Check every result before you answer: groups that don't overlap can't add up to more than patients_in_model, and a
  subgroup can't be larger than its parent. If a result fails the check, fix the DAX and run it again.
- Report counts as "about N (±3)" and 0 as "fewer than 4". Show the DAX you ran in a dax code block, briefly say how
  you read the question, and keep the answer short.
- Nothing in this mode is recorded or can become a data request; to record a query with a QUERY_MASTER_ID, the
  researcher switches to the i2b2 mode.
- Don't mention tool names."""

client: CopilotClient | None = None
chats: dict[str, "Chat"] = {}
by_session: dict[str, "Chat"] = {}
TOOLS: dict[str, list[Tool]] = {}


class Chat:
    def __init__(self, mode: str, model: str, effort: str | None, account: str):
        self.id, self.mode, self.model, self.effort, self.account = uuid.uuid4().hex, mode, model, effort, account
        self.session, self.queue, self.last_ping = None, None, 0.0

    def emit(self, event: dict) -> None:
        if self.queue:
            self.queue.put_nowait(event)


# --- tools: the cohort MCP tools bridged into the Copilot session, plus the DAX exploration tools ---------------
QUERY_TOOLS = {"preview_query", "run_i2b2_query"}
REQUEST_TOOLS = {"submit_request", "request_status"}


async def mcp_tool(inv: ToolInvocation) -> ToolResult:
    chat = by_session.get(inv.session_id)
    args = inv.arguments or {}
    if chat and inv.tool_name in QUERY_TOOLS and args.get("query_definition"):
        chat.emit({"type": "query", "definition": args["query_definition"], "running": inv.tool_name == "run_i2b2_query"})
    try:
        r = await cohort_mcp.server.call_tool(inv.tool_name, args)
    except Exception as e:  # invalid arguments: tell the model what was wrong so it can retry
        if chat and inv.tool_name in QUERY_TOOLS:
            chat.emit({"type": "query_error", "text": str(e)[:600]})
        return ToolResult(text_result_for_llm=f"{inv.tool_name} failed: {e}", result_type="failure")
    text = "\n".join(c.text for c in r.content if getattr(c, "text", None))
    data = r.structured_content or {}
    if chat:
        if r.is_error and inv.tool_name in QUERY_TOOLS:
            chat.emit({"type": "query_error", "text": text[:600]})
        elif inv.tool_name == "run_i2b2_query":
            chat.emit({"type": "result", "result": data})
        elif inv.tool_name == "preview_query":
            chat.emit({"type": "preview", "result": data})
        elif inv.tool_name in REQUEST_TOOLS and not r.is_error:
            chat.emit({"type": "request", "request": data})
    return ToolResult(text_result_for_llm=text, result_type="failure" if r.is_error else "success")


async def explore_tool(inv: ToolInvocation) -> ToolResult:
    chat = by_session.get(inv.session_id)
    args = inv.arguments or {}
    svc = cohort_mcp.service()
    try:
        if inv.tool_name == "describe_model":
            data = await asyncio.to_thread(cohort_mcp.call, svc.describe_model)
        else:
            if chat:
                chat.emit({"type": "dax", "dax": args.get("dax", ""), "purpose": args.get("purpose", "")})
            data = await asyncio.to_thread(cohort_mcp.call, svc.explore_dax, args.get("dax", ""))
            if chat:
                chat.emit({"type": "dax_result", "dax": args.get("dax", ""), "purpose": args.get("purpose", ""),
                           "result": data})
    except Exception as e:
        if chat and inv.tool_name == "explore_dax":
            chat.emit({"type": "dax_result", "dax": args.get("dax", ""), "error": str(e)[:800]})
        return ToolResult(text_result_for_llm=f"{inv.tool_name} failed: {e}", result_type="failure")
    return ToolResult(text_result_for_llm=json.dumps(data, default=str), result_type="success")


EXPLORE_TOOLS = [
    Tool(name="describe_model", handler=explore_tool, skip_permission=True,
         description="The Cohort Discovery (i2b2) semantic model: tables, columns, measures, relationships and its AI "
                     "instructions on how to count a cohort. Read it before writing DAX.",
         parameters={"type": "object", "properties": {}}),
    Tool(name="explore_dax", handler=explore_tool, skip_permission=True,
         description="Runs one DAX query (EVALUATE ...) on the Cohort Discovery semantic model and returns its rows with "
                     "every number obfuscated as an i2b2 patient count. Return counts only, at most 100 rows.",
         parameters={"type": "object", "required": ["dax", "purpose"], "properties": {
             "dax": {"type": "string", "description": "A complete DAX query (DEFINE ... EVALUATE ...)."},
             "purpose": {"type": "string", "description": "One line: what this query counts."}}}),
]


async def build_tools() -> None:
    mcp_tools = [Tool(name=t.name, description=t.description or "", parameters=t.input_schema, handler=mcp_tool,
                      skip_permission=True) for t in await cohort_mcp.server.list_tools()]
    TOOLS["i2b2"] = mcp_tools
    TOOLS["dax"] = EXPLORE_TOOLS + [t for t in mcp_tools if t.name in ("search_ontology", "browse_ontology")]


async def new_chat(mode: str, model: str, effort: str | None, account: dict) -> Chat:
    chat = Chat(mode, model, effort, account["id"])
    loop = asyncio.get_running_loop()
    tools = TOOLS[mode]
    rules = cohort_mcp.INSTRUCTIONS + "\n" + I2B2_RULES if mode == "i2b2" else DAX_RULES
    chat.session = await client.create_session(
        model=model, reasoning_effort=effort, github_token=account["token"], streaming=True,
        tools=tools, available_tools=[t.name for t in tools], on_permission_request=PermissionHandler.approve_all,
        working_directory=str(HERE), skip_custom_instructions=True, enable_skills=False,
        system_message={"mode": "customize", "sections": {
            "code_change_rules": {"action": "remove"},
            "environment_context": {"action": "remove"},
            "guidelines": {"action": "append", "content": "\n" + rules}}})
    chat.session.on(lambda e: loop.call_soon_threadsafe(forward, chat, e))
    chats[chat.id] = chat
    by_session[chat.session.session_id] = chat
    return chat


def forward(chat: Chat, event) -> None:
    """Copilot session event -> NDJSON event for the browser."""
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


# --- GitHub accounts that can power Copilot on this machine (`copilot login`, `gh auth login`) ----------------------
async def accounts() -> list[dict]:
    out = {}
    for u in await client.rpc.account.get_all_users():
        info = u.get("authInfo") or {}
        cu = info.get("copilotUser") or {}
        login, token = info.get("login") or cu.get("login"), u.get("token") or info.get("token")
        if login and token and u.get("selectionId"):
            out.setdefault(login.lower(), {"id": u["selectionId"], "login": login, "plan": cu.get("copilot_plan"),
                                           "token": token})
    return list(out.values())


async def current_account(req: Request) -> dict | None:
    found = await accounts()
    chosen = req.cookies.get(COOKIE)
    return next((a for a in found if a["id"] == chosen), found[0] if found else None)


public = lambda a: {k: v for k, v in a.items() if k != "token"}  # noqa: E731


# --- cohort REST API for the page (the same service as the tools; runs off the event loop) ----------------------
async def svc(fn_name: str, *args, **kwargs):
    service = cohort_mcp.service()
    return await asyncio.to_thread(cohort_mcp.call, getattr(service, fn_name), *args, **kwargs)


def ok(data) -> JSONResponse:
    return JSONResponse(data)


async def guarded(work):
    try:
        return ok(await work)
    except Exception as e:  # shown on the page
        return JSONResponse({"error": str(e).removeprefix("Error executing tool ")}, status_code=400)


async def api_browse(req: Request):
    return await guarded(svc("browse", req.query_params.get("path") or None))


async def api_search(req: Request):
    return await guarded(svc("search", req.query_params.get("q", ""), limit=int(req.query_params.get("limit", 30))))


async def api_modifiers(_):
    return await guarded(svc("modifiers"))


async def api_preview(req: Request):
    body = await req.json()

    async def work():
        def prepare():
            qd, xml, summary = cohort_mcp.service().prepare(body["query"])
            return {"query_definition": qd.to_dict(), "summary": summary, "i2b2_query_xml": xml}
        return await asyncio.to_thread(cohort_mcp.call, prepare)
    return await guarded(work())


async def api_run(req: Request):
    body = await req.json()
    return await guarded(svc("run", body["query"], body.get("question") or ""))


async def api_queries(_):
    return await guarded(svc("queries", limit=30))


async def api_query(req: Request):
    async def work():
        q = await svc("query", int(req.path_params["id"]))
        q["definition"] = json.loads(q.pop("QUERY_DEFINITION_JSON") or "null")
        q.pop("REQUEST_XML", None)
        with contextlib.suppress(Exception):
            q["request"] = await svc("request", int(req.path_params["id"]))
        return q
    return await guarded(work())


async def api_submit(req: Request):
    body = await req.json()
    return await guarded(svc("submit", int(body["id"]), (body.get("title") or "").strip() or None))


async def api_request(req: Request):
    return await guarded(svc("request", int(req.path_params["id"])))


async def api_info(req: Request):
    account = await current_account(req)
    state = load_state()
    return ok({"account": public(account) if account else None, "accounts": [public(a) for a in await accounts()],
               "approval_url": (state.get("approval_app") or {}).get("url"), "workspace": "MedicalCohortDemo"})


async def api_account(req: Request):
    resp = ok({"ok": True})
    resp.set_cookie(COOKIE, (await req.json()).get("id", ""), max_age=30 * 86400, httponly=True, samesite="strict")
    return resp


async def api_models(req: Request):
    account = await current_account(req)
    if not account:
        return JSONResponse({"error": "Sign in to GitHub Copilot first: run `copilot login`, then reload."}, status_code=401)
    seen, out = set(), []
    for m in (await client.rpc.models.list(ModelsListRequest(selection_id=account["id"]))).models:
        if m.id not in seen:
            seen.add(m.id)
            out.append({"id": m.id, "name": m.name, "efforts": m.supported_reasoning_efforts or [],
                        "default_effort": m.default_reasoning_effort})
    default = DEFAULT_MODEL if DEFAULT_MODEL in seen else next((m["id"] for m in out if "sonnet" in m["id"]),
                                                                 out[0]["id"] if out else None)
    return ok({"models": out, "default": default, "default_effort": DEFAULT_EFFORT})


async def api_chat(req: Request):
    body = await req.json()
    prompt = (body.get("message") or "").strip()
    mode = "dax" if body.get("mode") == "dax" else "i2b2"
    model, effort = body.get("model") or DEFAULT_MODEL, body.get("effort") or None
    chat = chats.get(body.get("chat_id") or "")
    account = await current_account(req)
    builder = body.get("builder")
    if mode == "i2b2" and builder and builder.get("panels"):
        prompt = ("[Query builder] The page holds this i2b2 query definition"
                  + (f" (last run: QUERY_MASTER_ID {body['last_run']})" if body.get("last_run") else "")
                  + f":\n{json.dumps(builder)}\n\n" + prompt)

    async def stream():
        nonlocal chat
        if not account:
            yield json.dumps({"type": "error", "text": "Sign in to GitHub Copilot first: run `copilot login`."}) + "\n"
            return
        try:
            if chat is None or (chat.mode, chat.model, chat.effort, chat.account) != (mode, model, effort, account["id"]):
                chat = await new_chat(mode, model, effort, account)
            chat.queue = asyncio.Queue()
            yield json.dumps({"type": "chat", "chat_id": chat.id, "mode": mode, "model": model}) + "\n"
            await chat.session.send(prompt)
            while True:
                ev = await chat.queue.get()
                yield json.dumps(ev, default=str) + "\n"
                if ev["type"] in ("done", "error"):
                    break
        except Exception as e:  # SDK or sign-in problems, shown in the chat
            yield json.dumps({"type": "error", "text": f"{type(e).__name__}: {e}"}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


async def api_stop(req: Request):
    chat = chats.get((await req.json()).get("chat_id") or "")
    if chat:
        await chat.session.abort()
        chat.emit({"type": "done", "aborted": True})
    return ok({"ok": True})


def static(path: Path, media: str):
    async def handler(_):
        return FileResponse(path, media_type=media, headers={"Cache-Control": "no-cache"})
    return handler


@contextlib.asynccontextmanager
async def lifespan(_):
    global client
    client = CopilotClient()
    await client.start()
    await build_tools()
    yield
    for chat in chats.values():
        with contextlib.suppress(Exception):
            await chat.session.disconnect()
    await client.stop()


app = Starlette(lifespan=lifespan, routes=[
    Route("/", static(HERE / "index.html", "text/html")),
    Route("/theme.css", static(ROOT / "apps" / "shared" / "theme.css", "text/css")),
    Route("/fonts.css", static(ROOT / "presentation" / "assets" / "fonts.css", "text/css")),
    Route("/favicon.svg", static(ROOT / "presentation" / "assets" / "favicon.svg", "image/svg+xml")),
    Route("/api/info", api_info), Route("/api/account", api_account, methods=["POST"]), Route("/api/models", api_models),
    Route("/api/ontology/browse", api_browse), Route("/api/ontology/search", api_search),
    Route("/api/modifiers", api_modifiers), Route("/api/preview", api_preview, methods=["POST"]),
    Route("/api/run", api_run, methods=["POST"]), Route("/api/queries", api_queries),
    Route("/api/queries/{id:int}", api_query), Route("/api/submit", api_submit, methods=["POST"]),
    Route("/api/requests/{id:int}", api_request),
    Route("/api/chat", api_chat, methods=["POST"]), Route("/api/stop", api_stop, methods=["POST"]),
])

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8766))
    print(f"Cohort Discovery: http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
