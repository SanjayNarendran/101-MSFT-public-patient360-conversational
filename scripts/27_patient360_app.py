"""Stage 6, Patient 360 in Fabric: the Rayfin (Fabric App) deploy of apps/patient360.

The app's Rayfin functions read every source in the workspace through the Patient360 lakehouse's SQL analytics
endpoint (three-part names reach Bronze_Clarity, Bronze_PACS, Bronze_ClinicalDocuments and the oncology silos) and hand
the browser short-lived, read-only SAS links for files in OneLake. This script writes the functions' coordinates for
this workspace (rayfin/functions/src/config.generated.ts) and the header's workspace link (.env.production.local),
installs the npm packages, deploys the app with `rayfin up`, saves its URL in the state file and moves the app and the
Patient360 lakehouse into the workspace folder PATIENT360_FOLDER (default "Patient 360").

Run scripts/24_patient360_data.py --fabric, 25_patient360_viewers.py --upload-only and 26_patient360_import.py first.
Ask needs its relay (scripts/28_patient360_chat.py deploy, then set-app-secret); rerun this script after `deploy` so
the app knows the relay's address. Needs Node.js 20, 22 or 24, like scripts/22_approval_app.py.

  python scripts/27_patient360_app.py              # configure, install, deploy
  python scripts/27_patient360_app.py --no-deploy  # configure and build only
"""
from __future__ import annotations

import argparse
import importlib
import json
import re
import subprocess
import sys
from pathlib import Path

import request_report
from common import ROOT, fabric, fabric_list, load_state, save_state, settings

APP = ROOT / "apps" / "patient360"
APP_NAME = "patient-360"   # the id in apps/patient360/rayfin/rayfin.yml; also the Fabric item names
FUNCTIONS = APP / "rayfin" / "functions"
P360 = "Patient360"
# The items the functions read, by display name (record.ts DEFAULT_NAMES).
SOURCES = ["Bronze_Clarity", "Bronze_PACS", "Bronze_ImagingArchive", "Bronze_ClinicalDocuments", P360,
           "Bronze_Oncology_Clinical", "Bronze_Oncology_Genomics", "Bronze_Oncology_Imaging",
           "Cohort_Requests", "Silver_OMOP"]   # the last two: the Cohorts tab (data requests and their patients)
REQUIRED = {"Bronze_Clarity", "Bronze_PACS", "Bronze_ClinicalDocuments", P360}

sys.path.insert(0, str(Path(__file__).resolve().parent))
approval = importlib.import_module("22_approval_app")


def workspace_items(ws_id: str) -> dict[str, dict]:
    found = {}
    for kind in ("Lakehouse", "SQLDatabase"):
        for item in fabric_list(f"/workspaces/{ws_id}/items?type={kind}"):
            if item["displayName"] in SOURCES:
                found[item["displayName"]] = item
    missing = sorted(REQUIRED - set(found))
    if missing:
        raise SystemExit(f"Not in the workspace yet: {', '.join(missing)}. Run the earlier stages first "
                         "(Patient360 comes from scripts/24_patient360_data.py --fabric).")
    absent = [s for s in SOURCES if s not in found]
    if absent:
        print(f"Not in the workspace (the app shows these sources as missing): {', '.join(absent)}")
    return found


def sql_endpoint(ws_id: str, lh_id: str) -> str:
    props = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{lh_id}")["properties"].get("sqlEndpointProperties", {})
    if props.get("provisioningStatus") != "Success" or not props.get("connectionString"):
        raise SystemExit(f"The {P360} lakehouse's SQL analytics endpoint isn't ready; try again in a few minutes.")
    return props["connectionString"].split(",")[0]


def workspace_name(ws_id: str) -> str:
    return fabric("GET", f"/workspaces/{ws_id}")["displayName"]


def write_config(state: dict) -> dict:
    ws_id = state["workspace_id"]
    items = workspace_items(ws_id)
    config = {"workspaceId": ws_id, "workspaceName": workspace_name(ws_id),
              "sqlServer": sql_endpoint(ws_id, items[P360]["id"]),
              "items": {name: item["id"] for name, item in items.items()},
              "chatUrl": (state.get("patient360_chat") or {}).get("url", ""),
              "appUrl": (state.get("patient360_app") or {}).get("url", ""),
              "approvalUrl": (state.get("approval_app") or {}).get("url", "")}
    fields = [f"  {k}: {json.dumps(v)}," for k, v in config.items() if k != "items"]
    fields.append(f"  items: {json.dumps(config['items'], indent=4)[:-1]}  }} as Record<string, string>,")
    (FUNCTIONS / "src" / "config.generated.ts").write_text(
        "// Written by scripts/27_patient360_app.py for this workspace.\n"
        "export const CONFIG = {\n" + "\n".join(fields) + "\n} as const;\n")
    (APP / ".env.production.local").write_text(
        "# Written by scripts/27_patient360_app.py: the workspace linked from the app header. Not committed.\n"
        f"VITE_FABRIC_WORKSPACE_ID={ws_id}\nVITE_FABRIC_WORKSPACE_NAME={config['workspaceName']}\n")
    print(f"Functions configured for {config['workspaceName']} ({ws_id}), SQL endpoint {config['sqlServer']}"
          + ("" if config["chatUrl"] else "\n  No Ask relay yet: run scripts/28_patient360_chat.py deploy, then this again"))
    return config


def place_in_folder(ws_id: str, folder_name: str) -> None:
    """Moves the app (its functions item follows) and the Patient360 lakehouse into a workspace folder."""
    folder = request_report.ensure_folder(ws_id, folder_name)
    for kind, name in (("AppBackend", APP_NAME), ("Lakehouse", P360)):
        for item in fabric_list(f"/workspaces/{ws_id}/items?type={kind}"):
            if item["displayName"] == name and item.get("folderId") != folder:
                fabric("POST", f"/workspaces/{ws_id}/items/{item['id']}/move", {"targetFolderId": folder})
                print(f"Moved {item['type']} {name} to the folder {folder_name}")


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-deploy", action="store_true", help="configure and build, but don't deploy")
    args = parser.parse_args()
    state, cfg = load_state(), settings()
    env = approval.node_env()
    write_config(state)
    approval.ensure_host_json(FUNCTIONS)
    for folder in (APP, FUNCTIONS):
        if not (folder / "node_modules").exists():
            approval.npm(["install"], folder, env)
    if args.no_deploy:
        subprocess.run(["npm", "run", "build"], cwd=FUNCTIONS, env=env, check=True)
        subprocess.run(["npm", "run", "build:fabric"], cwd=APP, env=env, check=True)
        print("Built; not deployed.")
        return
    deployed = deploy(state, cfg, env)
    save_state(patient360_app={"url": deployed["url"], "deploy": deployed["result"]})
    place_in_folder(state["workspace_id"], cfg.get("PATIENT360_FOLDER") or "Patient 360")
    print(f"Patient 360: {deployed['url']}")


if __name__ == "__main__":
    main()
