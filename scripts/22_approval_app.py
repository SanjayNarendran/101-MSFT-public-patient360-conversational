"""Stage 4b, approval app: the Rayfin (Fabric App) front end for cohort data requests.

apps/approval is a Rayfin project: a React page (inbox + one page per request, opened at #/requests/<id>) and Rayfin
functions that read and write the Cohort_Requests SQL database and start the Cohort_Delivery notebook. This script
writes the functions' Fabric coordinates for this workspace (rayfin/functions/src/config.generated.ts),
installs the npm packages, deploys the app into the workspace with `rayfin up`, and saves its URL in data/state.json.
cohort_service.submit() then links each new request to its page in the app (APPROVAL_UI=rayfin in settings.env).
The app's items go into the workspace folder APPROVAL_APP_FOLDER (default: the "Cohort requests" folder); delivery
lakehouses are created in the same folder.

Needs Node.js 20, 22 or 24 (the Rayfin CLI rejects other versions); set NODE_HOME to its install folder if the
default `node` is another version. The first deploy opens a browser to sign in to the Rayfin CLI.

  python scripts/22_approval_app.py            # configure, install, deploy
  python scripts/22_approval_app.py --no-deploy  # configure and build only
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import request_report
from common import ROOT, fabric, fabric_list, load_state, save_state, settings

APP = ROOT / "apps" / "approval"
APP_NAME = "cohort-approval"   # the id in apps/approval/rayfin/rayfin.yml; also the Fabric item names
FUNCTIONS = APP / "rayfin" / "functions"
SUPPORTED_NODE = (20, 22, 24)


def node_env() -> dict[str, str]:
    """PATH with a Node.js version the Rayfin CLI supports first (Homebrew kegs are checked on macOS)."""
    candidates = [os.environ.get("NODE_HOME", "")] + [f"/opt/homebrew/opt/node@{v}" for v in (24, 22, 20)] + [""]
    for home in candidates:
        node = shutil.which("node", path=f"{home}/bin" if home else None)
        if not node:
            continue
        major = int(subprocess.run([node, "-v"], capture_output=True, text=True).stdout.strip().lstrip("v").split(".")[0])
        if major in SUPPORTED_NODE:
            return {**os.environ, "PATH": f"{Path(node).parent}:{os.environ['PATH']}"}
    raise SystemExit("Install Node.js 20, 22 or 24 (e.g. brew install node@22) or set NODE_HOME.")


def write_config(state: dict, cfg: dict) -> dict:
    db = state["cohort_requests_db"]
    config = {"workspaceId": state["workspace_id"], "sqlServer": db["server"].split(",")[0],
              "sqlDatabase": db["database"], "deliveryNotebookId": state["cohort_app"]["delivery_notebook_id"],
              "deliveryPipelineId": state["cohort_app"]["delivery_pipeline_id"], "appName": APP_NAME,
              "discoveryModelId": state["semantic_models"][cfg["SEMANTIC_MODEL_DISCOVERY"]],
              "appUrl": (state.get("approval_app") or {}).get("url", ""),
              "chatUrl": (state.get("discovery_chat") or {}).get("url", ""),
              "patient360Url": (state.get("patient360_app") or {}).get("url", "")}
    (FUNCTIONS / "src" / "config.generated.ts").write_text(
        "// Written by scripts/22_approval_app.py for this workspace.\n"
        f"export const CONFIG = {json.dumps(config, indent=2)} as const;\n")
    write_model_description(state, cfg)
    print(f"Functions configured for workspace {config['workspaceId']}"
          + ("" if config["chatUrl"] else " (no chat relay yet: run scripts/23_discovery_chat.py deploy)"))
    return config


def write_model_description(state: dict, cfg: dict) -> None:
    """The Cohort Discovery model as the Discovery tab's describe_model tool returns it (as CohortService does)."""
    spec = importlib.import_module("18_semantic_models").discovery(state, cfg)
    model = {"model": spec.name, "instructions": spec.instructions.strip(), "relationships": spec.relationships,
             "tables": [{"name": t.name, "description": t.description, "columns": t.columns or [],
                         "column_descriptions": t.column_descriptions,
                         "measures": [{"name": m.name, "description": m.description} for m in t.measures]}
                        for t in spec.tables]}
    (FUNCTIONS / "src" / "discovery.generated.ts").write_text(
        "// Written by scripts/22_approval_app.py: the Cohort Discovery (i2b2) semantic model, for describe_model.\n"
        f"export const MODEL_DESCRIPTION = {json.dumps(model, indent=1, default=str)};\n")


HOST_JSON = {
    "version": "2.0",
    "logging": {"applicationInsights": {"samplingSettings": {"isEnabled": True, "excludedTypes": "Request"}},
                "logLevel": {"default": "Information"}},
    "extensionBundle": {"id": "Microsoft.Azure.Functions.ExtensionBundle.Preview", "version": "[4.49.0, 5.0.0)"},
    "watchDirectories": ["dist"],
}


def ensure_host_json(functions: Path) -> None:
    """`rayfin up` needs the functions' host.json, which the Rayfin scaffold writes and git ignores."""
    path = functions / "host.json"
    if not path.exists():
        path.write_text(json.dumps(HOST_JSON, indent=2) + "\n")
        print(f"Wrote {path.relative_to(ROOT)}")


def npm(args: list[str], cwd: Path, env: dict) -> None:
    # --legacy-peer-deps: npm 10 fails on this workspace's peer set ("Cannot read properties of null (edgesOut)")
    subprocess.run(["npm", *args, "--legacy-peer-deps", "--no-audit", "--no-fund"], cwd=cwd, env=env, check=True)


def deploy(state: dict, cfg: dict, env: dict) -> dict:
    cmd = ["npx", "rayfin", "up", "--workspace-id", state["workspace_id"], "--yes", "--json"]
    if cfg.get("FABRIC_TENANT_ID", "").count("-") == 4:
        cmd += ["--tenant", cfg["FABRIC_TENANT_ID"]]
    out = subprocess.run(cmd, cwd=APP, env=env, capture_output=True, text=True)
    print(out.stderr[-3000:])
    if out.returncode != 0:
        print(out.stdout[-3000:])
        raise SystemExit("rayfin up failed")
    text = out.stdout
    result = json.loads(text[text.index("{"):]) if "{" in text else {}
    url = next(iter(re.findall(r"https://[\w.-]+\.fabricapps\.net[^\s\"']*", text)), None)
    return {"url": (result.get("url") or result.get("appUrl") or url or "").rstrip("/"), "result": result}


def place_in_folder(ws_id: str, folder_name: str) -> str:
    """Moves the app into a workspace folder (its functions item is a child and follows); deliveries follow the app."""
    folder = request_report.ensure_folder(ws_id, folder_name)
    for item in fabric_list(f"/workspaces/{ws_id}/items?type=AppBackend"):
        if item["displayName"] == APP_NAME and item.get("folderId") != folder:
            fabric("POST", f"/workspaces/{ws_id}/items/{item['id']}/move", {"targetFolderId": folder})
            print(f"Moved {item['type']} {APP_NAME} to the folder {folder_name}")
    return folder


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-deploy", action="store_true", help="configure and build, but don't deploy")
    args = parser.parse_args()
    state, cfg = load_state(), settings()
    env = node_env()
    write_config(state, cfg)
    ensure_host_json(FUNCTIONS)
    for folder in (APP, FUNCTIONS):
        if not (folder / "node_modules").exists():
            npm(["install"], folder, env)
    if args.no_deploy:
        subprocess.run(["npm", "run", "build"], cwd=FUNCTIONS, env=env, check=True)
        subprocess.run(["npx", "vite", "build"], cwd=APP / "packages" / "frontend", env=env, check=True)
        print("Built; not deployed.")
        return
    deployed = deploy(state, cfg, env)
    save_state(approval_app={"url": deployed["url"], "deploy": deployed["result"]})
    place_in_folder(state["workspace_id"], cfg.get("APPROVAL_APP_FOLDER", cfg["COHORT_REQUEST_FOLDER"]))
    print(f"Approval app: {deployed['url']}")


if __name__ == "__main__":
    main()
