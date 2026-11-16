"""Stage 6, Ask in Fabric: Patient 360's GitHub Copilot relay in Azure Container Apps.

In the Fabric App, Ask talks to GitHub Copilot through apps/patient360/chat/server.py running with RELAY=1 in the
Container App PATIENT360_CHAT_APP (default `patient360-chat`), in the same Container Apps environment and registry as
the Discovery tab's relay (DISCOVERY_ENVIRONMENT, DISCOVERY_REGISTRY, DISCOVERY_RESOURCE_GROUP). Each user signs in to
GitHub once in Ask, so questions use their own Copilot plan. Every tool runs in the page, so the relay never sees the
data; the app's chatTicket function signs who the Fabric user is (CHAT_TICKET_KEY, shared by the app and the relay).

  python scripts/28_patient360_chat.py create          # the Container App and its chat ticket key; prints the OAuth App values
  python scripts/28_patient360_chat.py configure --client-id <id>   # after the person stores the GitHub client secret
  python scripts/28_patient360_chat.py deploy          # build the image in Azure, roll the Container App, /healthz
  python scripts/28_patient360_chat.py set-app-secret  # copy the chat ticket key into the patient-360 app's secrets

Order (docs/setup.md, step 9.4): scripts/27_patient360_app.py, `create`, the GitHub OAuth App and its client secret
[person], `configure`, `deploy`, `set-app-secret`, then scripts/27_patient360_app.py again so the app has the relay's
address. The Container App scales to zero when idle (minimum replicas 0).
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, load_state, save_state, settings  # noqa: E402

# Script 23's Azure helpers read the Container App's name from its module globals; they are pointed at this relay.
relay = importlib.import_module("23_discovery_chat")
_CFG = settings()
APP = relay.APP = _CFG.get("PATIENT360_CHAT_APP") or "patient360-chat"
ENVIRONMENT = _CFG.get("DISCOVERY_ENVIRONMENT", "")
RG, REGISTRY = relay.RG, relay.REGISTRY
SOURCE = ROOT / "apps" / "patient360" / "chat"
P360_APP = ROOT / "apps" / "patient360"
IMAGE = "patient360-chat"
LOCAL_ORIGINS = ["http://localhost:5178", "http://127.0.0.1:5178"]
DEFAULT_MODEL, DEFAULT_EFFORT = "claude-opus-5.5", "high"
az = relay.az


def exists() -> bool:
    return bool(az("containerapp", "list", "-g", RG, "--query", f"[?name=='{APP}'].name", "-o", "tsv"))


def secret_names() -> set[str]:
    return set(json.loads(az("containerapp", "secret", "list", "-g", RG, "-n", APP, "--query", "[].name", "-o", "json") or "[]"))


def app_origin() -> str:
    url = (load_state().get("patient360_app") or {}).get("url", "")
    return "/".join(url.split("/")[:3]) if url else ""


def create() -> None:
    if not ENVIRONMENT:
        raise SystemExit("Set DISCOVERY_ENVIRONMENT in the settings file (docs/setup.md, Stage 4e)")
    if not exists():
        az("containerapp", "create", "-g", RG, "-n", APP, "--environment", ENVIRONMENT,
           "--image", "mcr.microsoft.com/k8se/quickstart:latest", "--ingress", "external", "--target-port", "80",
           "--cpu", "1", "--memory", "2Gi", "--min-replicas", "0", "--max-replicas", "1",
           "--tags", "project=patient-360", "-o", "none")
        print(f"Created the Container App {APP}")
    if "chat-ticket-key" not in secret_names():
        import secrets
        relay.wait_ready()
        az("containerapp", "secret", "set", "-g", RG, "-n", APP, "-o", "none",
           "--secrets", f"chat-ticket-key={secrets.token_urlsafe(32)}")
        print("Stored a new chat ticket key (secret chat-ticket-key)")
    fqdn = relay.app_fqdn()
    print(f"""
Relay address: https://{fqdn}

The GitHub OAuth App [person] (github.com > Settings > Developer settings > OAuth Apps > New OAuth App):
  Application name            Patient 360 (Fabric)
  Homepage URL                {app_origin() or 'the Patient 360 app address (scripts/27_patient360_app.py prints it)'}
  Authorization callback URL  https://{fqdn}/auth/github/callback
Then generate a client secret and store it in your own terminal (it must not appear here):
  read -rs GH_SECRET && az containerapp secret set -g {RG} -n {APP} --secrets github-client-secret="$GH_SECRET" -o none; unset GH_SECRET
Then: python scripts/28_patient360_chat.py configure --client-id <the OAuth App's client ID>""")


def configure(client_id: str) -> None:
    if "github-client-secret" not in secret_names():
        raise SystemExit(f"Store the GitHub client secret in {APP} first (see `create`'s output).")
    origin = app_origin()
    if not origin:
        raise SystemExit("Deploy the app first (scripts/27_patient360_app.py) so the relay knows its address.")
    fqdn = relay.app_fqdn()
    origins = [origin, *LOCAL_ORIGINS]
    relay.wait_ready()
    az("containerapp", "update", "-g", RG, "-n", APP, "-o", "none", "--set-env-vars",
       f"GITHUB_CLIENT_ID={client_id}", "GITHUB_CLIENT_SECRET=secretref:github-client-secret",
       "CHAT_TICKET_KEY=secretref:chat-ticket-key", f"ALLOWED_ORIGIN={','.join(origins)}",
       f"PUBLIC_URL=https://{fqdn}", f"P360_MODEL={DEFAULT_MODEL}", f"P360_EFFORT={DEFAULT_EFFORT}")
    relay.wait_ready()
    az("containerapp", "ingress", "cors", "enable", "-g", RG, "-n", APP, "-o", "none",
       "--allowed-origins", *origins, "--allowed-methods", "GET", "POST", "OPTIONS",
       "--allowed-headers", "content-type", "x-chat-ticket", "--max-age", "3600")
    print(f"{APP}: GitHub client {client_id}, origins {', '.join(origins)}")


def deploy() -> None:
    server = relay.ensure_registry()
    tag = time.strftime("%Y%m%d-%H%M%S")
    image = f"{server}/{IMAGE}:{tag}"
    print(f"Building {image} in Azure (a few minutes)", flush=True)
    az("acr", "build", "-r", REGISTRY, "-t", f"{IMAGE}:{tag}", "-t", f"{IMAGE}:latest", "--platform", "linux/amd64",
       "--no-logs", str(SOURCE))
    relay.use_registry(server)
    relay.wait_ready()
    az("containerapp", "update", "-g", RG, "-n", APP, "--image", image, "-o", "none")
    relay.wait_ready()
    az("containerapp", "ingress", "update", "-g", RG, "-n", APP, "--target-port", "8080", "-o", "none")
    url = f"https://{relay.app_fqdn()}"
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{url}/healthz", timeout=60) as r:
                if json.load(r).get("ok"):
                    break
        except Exception:
            time.sleep(10)
    else:
        raise SystemExit(f"{url}/healthz did not answer")
    save_state(patient360_chat={"url": url, "image": image, "resource_group": RG, "container_app": APP,
                                "registry": REGISTRY, "github_oauth_client_id": relay.client_id()})
    print(f"Ask relay: {url} ({image}). Rerun scripts/27_patient360_app.py if the app doesn't have this address yet.")


def set_app_secret() -> None:
    """Copies the chat ticket key from the Container App into the patient-360 app's Rayfin secrets (never printed)."""
    node = importlib.import_module("22_approval_app").node_env()
    r = subprocess.run(["npx", "rayfin", "secret", "set", "CHAT_TICKET_KEY", "--stdin",
                        "--describe=Signs the chat tickets Ask sends to its GitHub Copilot relay"],
                       input=relay.secret("chat-ticket-key") + "\n", cwd=P360_APP, env=node,
                       capture_output=True, text=True)
    print((r.stdout + r.stderr).strip()[-1500:])
    if r.returncode:
        raise SystemExit("rayfin secret set failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["create", "configure", "deploy", "set-app-secret"])
    parser.add_argument("--client-id", help="the GitHub OAuth App's client ID (configure)")
    args = parser.parse_args()
    relay.need_azure()
    if args.command == "configure":
        if not args.client_id:
            raise SystemExit("configure needs --client-id")
        configure(args.client_id)
    else:
        {"create": create, "deploy": deploy, "set-app-secret": set_app_secret}[args.command]()


if __name__ == "__main__":
    main()
