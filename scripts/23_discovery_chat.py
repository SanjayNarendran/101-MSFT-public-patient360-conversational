"""Stage 4e, the Fabric-hosted Cohort Discovery chat: the GitHub Copilot relay in Azure Container Apps.

The Discovery tab of the approval app (apps/approval) talks to GitHub Copilot through a small server
(apps/discovery/relay/server.py) that runs in the Container App `cohort-discovery-chat`. Each user signs in to GitHub
in the tab, so questions use their own Copilot plan. The tools run in the app's Rayfin Functions, which query the
semantic model with the app's identity and record the signed-in Fabric user on every run and request. See
docs/fabric-hosted-discovery.md for the design and the Azure and GitHub items it uses.

  python scripts/23_discovery_chat.py export          # write apps/discovery/relay/tools.json
  python scripts/23_discovery_chat.py deploy          # export, build the image in Azure, roll the Container App
  python scripts/23_discovery_chat.py local           # run the relay on http://127.0.0.1:8770 (secrets from Azure)
  python scripts/23_discovery_chat.py set-app-secret  # copy the chat ticket key into the approval app's secrets
  python scripts/23_discovery_chat.py check           # the TypeScript i2b2 compiler vs the Python one, on the history

The Container Apps environment, the Container App, its secrets and the GitHub OAuth App are created once by hand
(docs/setup.md, Stage 4e). Their names are in config/settings*.env (DISCOVERY_*). After `deploy`, rerun
scripts/22_approval_app.py so the app knows the relay's address.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, SETTINGS_FILE, ensure_openssl, load_state, save_state, settings  # noqa: E402

ensure_openssl()

RELAY = ROOT / "apps" / "discovery" / "relay"
_CFG = settings()
RG = _CFG.get("DISCOVERY_RESOURCE_GROUP", "")
APP = _CFG.get("DISCOVERY_CONTAINER_APP") or "cohort-discovery-chat"
REGISTRY = _CFG.get("DISCOVERY_REGISTRY", "")   # globally unique: 5 to 50 lowercase letters and digits
LOCATION = _CFG.get("DISCOVERY_LOCATION", "")
if LOCATION.startswith("<"):
    LOCATION = ""                                # still the template's placeholder: use the resource group's region
IMAGE = "cohort-discovery-chat"
LOCAL_PORT = 8770
# The hosted chat starts on Opus 5.5 with high thinking; each user can pick another model in the tab.
DEFAULT_MODEL, DEFAULT_EFFORT = "claude-opus-5.5", "high"

SHOW_VISUAL = {
    "name": "show_visual",
    "description": "Draws a chart in the chat to explain a result: a Vega-Lite spec whose data are numbers you "
                   "already have (the obfuscated counts and breakdowns from run_i2b2_query, get_query or "
                   "explore_dax). Use it when a picture tells the story better than a sentence, e.g. comparing "
                   "cohorts, a breakdown, or counts over time. Never invent or estimate numbers.",
    "parameters": {"type": "object", "required": ["title", "spec"], "properties": {
        "title": {"type": "string", "description": "A short, plain title."},
        "spec": {"type": "object", "description": "A Vega-Lite spec with inline data (data.values). Leave out "
                 "width, colours and fonts: the page sets them. Bar, line and point marks work best."},
        "caption": {"type": "string", "description": "Optional one-line note shown under the chart."}}},
}
VISUAL_RULES = """
- To explain a result visually, call show_visual with a small Vega-Lite spec built only from numbers a tool returned
  (counts are obfuscated: label them "patients (±3)"). Prefer one clear bar or line chart over several."""


def az(*args: str, capture: bool = True) -> str:
    r = subprocess.run(["az", *args], capture_output=capture, text=True)
    if r.returncode:
        raise SystemExit(f"az {' '.join(args[:3])} failed: {(r.stderr or '').strip()[-800:]}")
    return (r.stdout or "").strip()


# --- tools.json: the chat's tools and rules, taken from the local app so both stay the same ---------------------------
def export_tools() -> Path:
    spec = importlib.util.spec_from_file_location("discovery_app", ROOT / "apps" / "discovery" / "app.py")
    local = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(local)
    import cohort_mcp
    mcp = [{"name": t.name, "description": t.description or "", "parameters": t.input_schema}
           for t in asyncio.run(cohort_mcp.server.list_tools())]
    explore = [{"name": t.name, "description": t.description, "parameters": t.parameters} for t in local.EXPLORE_TOOLS]
    ontology = [t for t in mcp if t["name"] in ("search_ontology", "browse_ontology")]
    out = {
        "default_model": local.DEFAULT_MODEL,
        "i2b2": {"rules": cohort_mcp.INSTRUCTIONS + "\n" + local.I2B2_RULES + VISUAL_RULES, "tools": mcp + [SHOW_VISUAL]},
        "dax": {"rules": local.DAX_RULES + VISUAL_RULES, "tools": explore + ontology + [SHOW_VISUAL]},
    }
    path = RELAY / "tools.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(f"Wrote {path.relative_to(ROOT)}: {len(out['i2b2']['tools'])} i2b2 tools, {len(out['dax']['tools'])} DAX tools")
    return path


# --- Azure ----------------------------------------------------------------------------------------------------------
def need_azure() -> None:
    missing = [k for k, v in (("DISCOVERY_RESOURCE_GROUP", RG), ("DISCOVERY_REGISTRY", REGISTRY)) if not v or v.startswith("<")]
    if missing:
        raise SystemExit(f"Set {' and '.join(missing)} in {SETTINGS_FILE.relative_to(ROOT)} (docs/setup.md, Stage 4e)")


def app_fqdn() -> str:
    return az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.configuration.ingress.fqdn", "-o", "tsv")


def ensure_registry() -> str:
    found = az("acr", "list", "-g", RG, "--query", f"[?name=='{REGISTRY}'].loginServer", "-o", "tsv")
    if found:
        return found
    location = LOCATION or az("group", "show", "-n", RG, "--query", "location", "-o", "tsv")
    az("acr", "create", "-g", RG, "-n", REGISTRY, "--sku", "Basic", "-l", location, "--admin-enabled", "false",
       "--tags", "project=cohort-discovery", "-o", "none")
    print(f"Created container registry {REGISTRY}")
    return az("acr", "show", "-n", REGISTRY, "--query", "loginServer", "-o", "tsv")


def wait_ready() -> None:
    """Waits while another update of the Container App is in progress (concurrent updates fail)."""
    for _ in range(60):
        if az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.provisioningState", "-o", "tsv") != "InProgress":
            return
        time.sleep(10)
    raise SystemExit(f"{APP} is still updating; try again later")


def patch_app(configuration: dict) -> None:
    """PATCHes the Container App's configuration through ARM, with the body in a private temporary file."""
    app_id = az("containerapp", "show", "-g", RG, "-n", APP, "--query", "id", "-o", "tsv")
    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"properties": {"configuration": configuration}}, f)
        az("rest", "--method", "patch", "--url", f"https://management.azure.com{app_id}?api-version=2024-03-01",
           "--body", f"@{path}")
    finally:
        os.remove(path)


def use_registry(server: str) -> None:
    """Lets the Container App pull from the registry with its admin credential, kept as the secret acr-password.
    (A managed identity needs an AcrPull role assignment, which this account may not create.)"""
    current = json.loads(az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.configuration.registries",
                            "-o", "json") or "[]")
    if any(r.get("server") == server and r.get("passwordSecretRef") == "acr-password" for r in current):
        return
    az("acr", "update", "-n", REGISTRY, "--admin-enabled", "true", "-o", "none")
    creds = json.loads(az("acr", "credential", "show", "-n", REGISTRY, "-o", "json"))
    secrets = {s["name"]: s["value"] for s in json.loads(az("containerapp", "secret", "list", "-g", RG, "-n", APP,
                                                            "--show-values", "-o", "json"))}
    secrets["acr-password"] = creds["passwords"][0]["value"]
    wait_ready()
    patch_app({"secrets": [{"name": k, "value": v} for k, v in secrets.items()],
               "registries": [{"server": server, "username": creds["username"], "passwordSecretRef": "acr-password"}]})
    wait_ready()
    print(f"The Container App pulls from {server} with the registry's admin credential")


def deploy() -> None:
    export_tools()
    server = ensure_registry()
    tag = time.strftime("%Y%m%d-%H%M%S")
    image = f"{server}/{IMAGE}:{tag}"
    print(f"Building {image} in Azure (a few minutes)", flush=True)
    az("acr", "build", "-r", REGISTRY, "-t", f"{IMAGE}:{tag}", "-t", f"{IMAGE}:latest", "--platform", "linux/amd64",
       "--no-logs", str(RELAY))
    use_registry(server)
    fqdn = app_fqdn()
    az("containerapp", "update", "-g", RG, "-n", APP, "--image", image,
       "--set-env-vars", f"PUBLIC_URL=https://{fqdn}", f"COHORT_MODEL={DEFAULT_MODEL}", f"COHORT_EFFORT={DEFAULT_EFFORT}",
       "-o", "none")
    wait_ready()
    az("containerapp", "ingress", "update", "-g", RG, "-n", APP, "--target-port", "8080", "-o", "none")
    url = f"https://{fqdn}"
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{url}/healthz", timeout=60) as r:
                if json.load(r).get("ok"):
                    break
        except Exception:
            time.sleep(10)
    else:
        raise SystemExit(f"{url}/healthz did not answer")
    save_state(discovery_chat={"url": url, "image": image, "resource_group": RG, "container_app": APP,
                               "registry": REGISTRY, "github_oauth_client_id": client_id()})
    print(f"Chat relay: {url} ({image}). Rerun scripts/22_approval_app.py if the app doesn't have this address yet.")


def client_id() -> str:
    env = json.loads(az("containerapp", "show", "-g", RG, "-n", APP, "--query", "properties.template.containers[0].env",
                        "-o", "json"))
    return next((e.get("value") for e in env if e["name"] == "GITHUB_CLIENT_ID"), "")


def secret(name: str) -> str:
    return az("containerapp", "secret", "show", "-g", RG, "-n", APP, "--secret-name", name, "--query", "value", "-o", "tsv")


def local() -> None:
    """The relay on this Mac (http://127.0.0.1:8770), for the app running with `npm run dev` or for tests."""
    export_tools()
    approval = (load_state().get("approval_app") or {}).get("url", "")
    env = {**os.environ, "GITHUB_CLIENT_ID": client_id(), "GITHUB_CLIENT_SECRET": secret("github-client-secret"),
           "CHAT_TICKET_KEY": secret("chat-ticket-key"), "LOCAL_CORS": "1", "HOST": "127.0.0.1",
           "PORT": str(LOCAL_PORT), "PUBLIC_URL": f"http://127.0.0.1:{LOCAL_PORT}",
           "COHORT_MODEL": DEFAULT_MODEL, "COHORT_EFFORT": DEFAULT_EFFORT,
           "ALLOWED_ORIGIN": ",".join(o for o in (approval, "http://localhost:5173", "http://127.0.0.1:5173") if o)}
    env.pop("DYLD_LIBRARY_PATH", None)
    print(f"Chat relay on http://127.0.0.1:{LOCAL_PORT} (Ctrl+C to stop)", flush=True)
    os.execve(sys.executable, [sys.executable, str(RELAY / "server.py")], env)


def check() -> None:
    """Compiles every query definition in the CRC history with the Python compiler (i2b2_query.py) and the
    TypeScript port the app's functions use (apps/approval/rayfin/functions/src/i2b2.ts, built to dist/), and
    compares the DAX, the i2b2 XML and the summary. Needs the functions built (npm run build) and the CRC store."""
    import pyarrow.parquet as pq

    import cohort_store
    import i2b2_crc as crc
    import i2b2_query as Q
    i2b2 = ROOT / "data" / "generated" / "i2b2"
    cols = ["c_hlevel", "c_fullname", "c_name", "c_visualattributes", "c_totalnum", "c_basecode", "c_tablename",
            "c_columnname", "c_operator", "c_dimcode", "c_columndatatype", "c_facttablecolumn", "c_metadataxml",
            "m_applied_path"]
    rows = pq.read_table(i2b2 / "i2b2_ontology.parquet", columns=cols).to_pylist()
    tables = pq.read_table(i2b2 / "table_access.parquet", columns=["c_table_cd", "c_fullname", "c_name"]).to_pylist()
    ontology = Q.Ontology.from_rows(rows, tables)
    cur = cohort_store.connect().cursor()
    cur.execute("SELECT QUERY_MASTER_ID, QUERY_DEFINITION_JSON FROM crc.COHORT_QUERY_CONTEXT "
                "WHERE QUERY_DEFINITION_JSON IS NOT NULL ORDER BY QUERY_MASTER_ID")
    defs = []
    for qm, text in cur.fetchall():
        d = json.loads(text)
        d["query_name"] = d.get("query_name") or f"QM{qm}"
        defs.append({"id": qm, "definition": d})
    breakdowns = {kind: ontology.children(path) for kind, path in crc.BREAKDOWN_PATHS.items()}
    python = {}
    for d in defs:
        qd = Q.QueryDefinition.from_dict(json.loads(json.dumps(d["definition"]))).normalize(ontology)
        c = Q.DaxCompiler(ontology)
        python[d["id"]] = {"count": c.count_query(qd, breakdowns), "patients": c.patient_set_query(qd),
                           "xml": Q.to_xml(qd, ontology), "summary": Q.describe(qd, ontology)}
    module = (ROOT / "apps" / "approval" / "rayfin" / "functions" / "dist" / "src" / "i2b2.js").as_uri()
    script = """
import * as Q from MODULE;
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { rows, tables, defs } = JSON.parse(input);
const o = Q.Ontology.fromRows(rows, tables);
const nodes = Q.BREAKDOWN_PATHS.map(([k, p]) => [k, o.children(p)]);
const out = {};
for (const d of defs) {
  try {
    const qd = Q.QueryDefinition.fromDict(d.definition).normalize(o);
    const c = new Q.DaxCompiler(o);
    out[d.id] = { count: c.countQuery(qd, nodes), patients: c.patientSetQuery(qd), xml: Q.toXml(qd, o), summary: Q.describe(qd, o) };
  } catch (e) { out[d.id] = { error: String(e) }; }
}
process.stdout.write(JSON.stringify(out));
""".replace("MODULE", json.dumps(module))
    node = importlib.import_module("22_approval_app").node_env()
    r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, env=node,
                       input=json.dumps({"rows": rows, "tables": tables, "defs": defs}, default=str))
    if r.returncode:
        raise SystemExit(r.stderr[-2000:])
    ts = json.loads(r.stdout)
    bad = 0
    for d in defs:
        p, t = python[d["id"]], ts[str(d["id"])]
        diff = [k for k in ("count", "patients", "xml", "summary") if p[k] != t.get(k)]
        if diff:
            bad += 1
            print(f"QM {d['id']}: differs in {', '.join(diff)} {t.get('error', '')}")
            a, b = p[diff[0]], t.get(diff[0]) or ""
            at = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            print(f"   python: ...{a[max(0, at - 80):at + 80]!r}\n   ts:     ...{b[max(0, at - 80):at + 80]!r}")
    print(f"{len(defs) - bad} of {len(defs)} stored queries compile to the same DAX, XML and summary in TypeScript")
    if bad:
        raise SystemExit(1)


def set_app_secret() -> None:
    """Copies the chat ticket key from the Container App into the approval app's Rayfin secrets (never printed)."""
    sys.path.insert(0, str(ROOT / "scripts"))
    node = importlib.import_module("22_approval_app").node_env()
    r = subprocess.run(["npx", "rayfin", "secret", "set", "CHAT_TICKET_KEY", "--stdin",
                        "--describe=Signs the chat tickets the Discovery tab sends to the GitHub Copilot relay"],
                       input=secret("chat-ticket-key") + "\n", cwd=ROOT / "apps" / "approval", env=node,
                       capture_output=True, text=True)
    print((r.stdout + r.stderr).strip()[-1500:])
    if r.returncode:
        raise SystemExit("rayfin secret set failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["export", "deploy", "local", "set-app-secret", "check"])
    args = parser.parse_args()
    if args.command in ("deploy", "local", "set-app-secret"):
        need_azure()
    {"export": export_tools, "deploy": deploy, "local": local, "set-app-secret": set_app_secret,
     "check": check}[args.command]()


if __name__ == "__main__":
    main()
