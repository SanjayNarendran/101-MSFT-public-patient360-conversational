"""Stage 3, step 4: Fabric notebooks that rebuild Silver_OMOP and Gold_i2b2 inside Fabric, for future runs.

The notebooks are Fabric Python notebooks (single node, no Spark) that run the same DuckDB ETL as 14/15: the modules
are uploaded to Silver_OMOP/Files/etl_code and imported at run time, so local and Fabric runs share one copy of the
logic. Silver_OMOP_Build reads Bronze through OneLake (Clarity shortcuts, the Bronze_PACS OneLake replica, the clinical
documents lakehouse) and the vocabularies already in Silver_OMOP; Gold_i2b2_Build reads Silver_OMOP.

  16_fabric_notebooks.py          upload the code and create/update both notebooks
  16_fabric_notebooks.py --run    also run them (Silver, then Gold) and print each run's summary
"""
from __future__ import annotations

import argparse
import base64
import json
import time

import requests

from common import ONELAKE_BLOB, ROOT, _fabric_token, fabric, fabric_list, load_state, onelake_put, settings, \
    storage_token

MODULES = ["epic_schema.py", "epic_reference.py", "omop_schema.py", "omop_etl.py", "i2b2_etl.py", "cohort_delivery.py",
           "research_notebook.py"]

HEADER = """# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "jupyter",
# META     "jupyter_kernel_name": "python3.11"
# META   },
# META   "dependencies": {}
# META }
"""
CODE_META = """
# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "jupyter_python"
# META }
"""


def markdown(text: str) -> str:
    return "\n# MARKDOWN ********************\n\n" + "\n".join(f"# {line}" for line in text.strip().splitlines()) + "\n"


def code(text: str, parameters: bool = False) -> str:
    kind = "PARAMETERS CELL" if parameters else "CELL"
    return f"\n# {kind} ********************\n\n{text.strip()}\n" + CODE_META


HELPERS = '''
import json, os, sys, time, traceback
from datetime import datetime, timezone

import requests
import notebookutils

ONELAKE = "onelake.dfs.fabric.microsoft.com"
token = lambda: notebookutils.credentials.getToken("storage")
opts = lambda: {"bearer_token": token(), "use_fabric_endpoint": "true"}
silver = f"abfss://{WORKSPACE_ID}@{ONELAKE}/{SILVER_OMOP_ID}/Tables"


def save(name, payload):
    """Writes a run summary (or error) to <lakehouse>/Files/etl_runs/ so runs can be checked from outside."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    url = f"https://onelake.blob.fabric.microsoft.com/{WORKSPACE_ID}/{RUN_LOG_ITEM_ID}/Files/etl_runs/{name}_{stamp}.json"
    resp = requests.put(url, data=json.dumps(payload, indent=2, default=str).encode(), timeout=60, headers={
        "Authorization": f"Bearer {token()}", "x-ms-version": "2023-11-03", "x-ms-blob-type": "BlockBlob"})
    resp.raise_for_status()
    print(json.dumps(payload, indent=2, default=str))


def failed(step):
    save(f"{RUN_NAME}_error", {"step": step, "error": traceback.format_exc()})
'''

SETUP = '''
# Pinned DuckDB and delta-rs versions (the notebook image may ship older ones); installed only when needed
try:
    import importlib, subprocess
    from importlib.metadata import PackageNotFoundError, version

    def too_old(package, minimum):
        try:
            return tuple(int(x) for x in version(package).split(".")[:2]) < minimum
        except PackageNotFoundError:
            return True

    wanted = [("duckdb", (1, 4), "duckdb>=1.4,<2"), ("deltalake", (1, 1), "deltalake>=1.1,<2")]
    missing = [spec for package, minimum, spec in wanted if too_old(package, minimum)]
    if missing:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *missing])
        importlib.invalidate_caches()

    # The ETL modules are uploaded next to the Silver tables by scripts/16_fabric_notebooks.py
    os.makedirs("/tmp/etl_code", exist_ok=True)
    for module in MODULES:
        resp = requests.get(f"https://{ONELAKE}/{WORKSPACE_ID}/{SILVER_OMOP_ID}/Files/etl_code/{module}",
                            headers={"Authorization": f"Bearer {token()}"}, timeout=60)
        resp.raise_for_status()
        open(f"/tmp/etl_code/{module}", "wb").write(resp.content)
    sys.path.insert(0, "/tmp/etl_code")
except Exception:
    failed("setup")
    raise
'''

SILVER_BUILD = """
import duckdb
from deltalake import DeltaTable

import omop_etl as etl
from omop_schema import CDM, EXTENSIONS, VOCAB_FILES

started = time.time()
con = duckdb.connect()
con.execute("SET TimeZone = 'UTC'")
etl.register_vocab(con, {t: DeltaTable(f"{silver}/{t}", storage_options=opts()).to_pyarrow_dataset()
                         for t in VOCAB_FILES})
etl.register_bronze(con, etl.OneLakeBronze(WORKSPACE_ID, BRONZE_CLARITY_ID, BRONZE_PACS_ID, BRONZE_DOCUMENTS_ID,
                                           token))
etl.build_silver(con)
coverage = {t: {"rows": n, "mapped": m} for t, n, m in etl.coverage(con)}
"""

SILVER_WRITE = """
rows = {}
for name in {**CDM, **EXTENSIONS}:
    query = f"SELECT * FROM cdm.{name}"
    rows[name] = (etl.write_delta(con, query, f"{silver}/{name}", opts()) if WRITE_TABLES
                  else con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0])
save(RUN_NAME, {"written": WRITE_TABLES, "seconds": round(time.time() - started), "rows": rows,
                "coverage": coverage})
"""

GOLD_BUILD = """
import duckdb
from deltalake import DeltaTable

import i2b2_etl
from omop_etl import write_delta
from omop_schema import CDM, VOCAB_FILES

started = time.time()
con = duckdb.connect()
con.execute("SET TimeZone = 'UTC'")
for schema, tables in (("omop", list(CDM)), ("vocab", list(VOCAB_FILES))):
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    for t in tables:
        con.register(f"src_{schema}_{t}", DeltaTable(f"{silver}/{t}", storage_options=opts()).to_pyarrow_dataset())
        con.execute(f"CREATE OR REPLACE VIEW {schema}.{t} AS SELECT * FROM src_{schema}_{t}")
# Reuse the surrogate patient/encounter numbers of the previous build (mappings live in Silver_OMOP)
con.execute("CREATE SCHEMA IF NOT EXISTS prior")
for name in i2b2_etl.MAPPING:
    try:
        con.register(f"prior_{name}", DeltaTable(f"{silver}/i2b2_{name}", storage_options=opts()).to_pyarrow_dataset())
        con.execute(f"CREATE OR REPLACE VIEW prior.{name} AS SELECT * FROM prior_{name}")
    except Exception:
        print(f"No earlier {name}; new surrogate keys will be drawn")
i2b2_etl.build_gold(con)
"""

GOLD_WRITE = """
gold = f"abfss://{WORKSPACE_ID}@{ONELAKE}/{GOLD_I2B2_ID}/Tables"
rows = {}
for name in i2b2_etl.GOLD:
    query = f"SELECT * FROM gold.{name}"
    rows[name] = (write_delta(con, query, f"{gold}/{name}", opts()) if WRITE_TABLES
                  else con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0])
for name in i2b2_etl.MAPPING:  # protected side: Silver_OMOP, not Gold
    query = f"SELECT * FROM mapping.{name}"
    rows[f"Silver_OMOP.i2b2_{name}"] = (write_delta(con, query, f"{silver}/i2b2_{name}", opts()) if WRITE_TABLES
                                        else con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0])
save(RUN_NAME, {"written": WRITE_TABLES, "seconds": round(time.time() - started), "rows": rows})
"""


def guarded(step: str, body: str) -> str:
    """Wraps a cell so a failure is written to Files/etl_runs before the run stops."""
    inner = "\n".join(f"    {line}" if line else "" for line in body.strip().splitlines())
    return f"try:\n{inner}\nexcept Exception:\n    failed({step!r})\n    raise"


def notebook(title: str, intro: str, params: dict, cells: list[tuple[str, str]]) -> str:
    lines = "\n".join(f"{k} = {v!r}" for k, v in params.items())
    parts = [HEADER, markdown(f"# {title}\n\n{intro}"), code(lines, parameters=True), code(HELPERS), code(SETUP)]
    parts += [code(guarded(step, body)) for step, body in cells]
    return "".join(parts)


def definitions(state: dict, cfg: dict) -> dict[str, tuple[str, str]]:
    ws, lh = state["workspace_id"], state["lakehouses"]
    silver_id, gold_id = lh[cfg["LAKEHOUSE_SILVER_OMOP"]], lh[cfg["LAKEHOUSE_GOLD_I2B2"]]
    common = {"WORKSPACE_ID": ws, "SILVER_OMOP_ID": silver_id, "WRITE_TABLES": True, "MODULES": MODULES}
    silver = notebook(
        "Silver: OMOP CDM v5.4 from Bronze",
        "Rebuilds every OMOP table in Silver_OMOP from the Bronze layer: Epic Clarity (Bronze_Clarity),\n"
        "the Bronze_PACS SQL database (OneLake replica) and Bronze_ClinicalDocuments. Uses the OMOP vocabularies\n"
        "already loaded into Silver_OMOP. Same code as scripts/14_silver_omop.py (DuckDB, single node).\n\n"
        "Set WRITE_TABLES = False for a dry run. Each run writes a summary (or the error) to "
        "Silver_OMOP/Files/etl_runs/.",
        {**common, "BRONZE_CLARITY_ID": lh[cfg["LAKEHOUSE_CLARITY"]],
         "BRONZE_PACS_ID": state["pacs_database"]["id"], "BRONZE_DOCUMENTS_ID": lh[cfg["LAKEHOUSE_DOCUMENTS"]],
         "RUN_LOG_ITEM_ID": silver_id, "RUN_NAME": "silver_omop"},
        [("build", SILVER_BUILD), ("write", SILVER_WRITE)])
    gold = notebook(
        "Gold: i2b2 star schema and ontology from Silver OMOP",
        "Rebuilds the i2b2 CRC tables (observation_fact and dimensions) and the i2b2 ontology with patient counts\n"
        "in Gold_i2b2 from Silver_OMOP. Same code as scripts/15_gold_i2b2.py (DuckDB, single node).\n\n"
        "Run after Silver_OMOP_Build. Each run writes a summary (or the error) to Gold_i2b2/Files/etl_runs/.",
        {**common, "GOLD_I2B2_ID": gold_id, "RUN_LOG_ITEM_ID": gold_id, "RUN_NAME": "gold_i2b2"},
        [("build", GOLD_BUILD), ("write", GOLD_WRITE)])
    return {"Silver_OMOP_Build": (silver, "Builds Silver_OMOP (OMOP CDM v5.4) from the Bronze layer."),
            "Gold_i2b2_Build": (gold, "Builds Gold_i2b2 (i2b2 star schema and ontology) from Silver_OMOP.")}


def upload_code(ws_id: str, silver_id: str):
    for module in MODULES:
        onelake_put(f"{ONELAKE_BLOB}/{ws_id}/{silver_id}/Files/etl_code/{module}",
                    (ROOT / "scripts" / module).read_bytes(), "text/x-python")
    print(f"Uploaded {len(MODULES)} ETL modules to Silver_OMOP/Files/etl_code")


def deploy(ws_id: str, name: str, content: str, description: str) -> str:
    payload = base64.b64encode(content.encode()).decode()
    definition = {"format": "fabricGitSource", "parts": [
        {"path": "notebook-content.py", "payload": payload, "payloadType": "InlineBase64"}]}
    existing = next((n for n in fabric_list(f"/workspaces/{ws_id}/notebooks") if n["displayName"] == name), None)
    if existing:
        fabric("POST", f"/workspaces/{ws_id}/notebooks/{existing['id']}/updateDefinition", {"definition": definition})
        print(f"Updated notebook {name}")
        return existing["id"]
    item = fabric("POST", f"/workspaces/{ws_id}/notebooks",
                  {"displayName": name, "description": description, "definition": definition})
    print(f"Created notebook {name}")
    return item.get("id") or next(n["id"] for n in fabric_list(f"/workspaces/{ws_id}/notebooks")
                                  if n["displayName"] == name)


def run(ws_id: str, notebook_id: str, name: str, lakehouse_id: str, prefix: str, timeout_min: int = 60,
        parameters: dict | None = None):
    """Runs a notebook through the job scheduler, waits for it, and prints the summary it wrote.

    parameters override the notebook's parameters cell, e.g. {"QUERY_MASTER_ID": 1001}."""
    url = f"https://api.fabric.microsoft.com/v1/workspaces/{ws_id}/items/{notebook_id}/jobs/instances?jobType=RunNotebook"
    kind = lambda v: "bool" if isinstance(v, bool) else "int" if isinstance(v, int) else "string"
    body = {"executionData": {"parameters": {k: {"value": str(v), "type": kind(v)}
                                             for k, v in parameters.items()}}} if parameters else {}
    resp = requests.post(url, json=body, timeout=60, headers={"Authorization": f"Bearer {_fabric_token()}"})
    if resp.status_code != 202:
        raise RuntimeError(f"Run {name} -> {resp.status_code}: {resp.text[:500]}")
    location, start = resp.headers["Location"], time.time()
    print(f"Running {name} ...")
    while True:
        time.sleep(20)
        job = requests.get(location, timeout=60, headers={"Authorization": f"Bearer {_fabric_token()}"}).json()
        status = job.get("status")
        if status in ("Completed", "Failed", "Cancelled", "Deduped"):
            break
        if time.time() - start > timeout_min * 60:
            raise SystemExit(f"{name} still {status} after {timeout_min} min")
    print(f"  {name}: {status} in {time.time() - start:.0f}s")
    kind = f"{prefix}_error" if status != "Completed" else prefix
    listing = requests.get(f"https://onelake.dfs.fabric.microsoft.com/{ws_id}", timeout=60, params={
        "resource": "filesystem", "recursive": "false", "directory": f"{lakehouse_id}/Files/etl_runs"},
        headers={"Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03"}).json()
    logs = sorted(p["name"] for p in listing.get("paths", [])
                  if p["name"].rsplit("/", 1)[-1].startswith(kind + "_2"))  # <name>_<UTC timestamp>.json
    newest = [n for n in logs if n.rsplit("_", 1)[-1] >= time.strftime("%Y%m%dT%H%M%S", time.gmtime(start - 60))]
    summary = (requests.get(f"https://onelake.dfs.fabric.microsoft.com/{ws_id}/{newest[-1]}", timeout=60,
                            headers={"Authorization": f"Bearer {storage_token()}"}).json() if newest else None)
    if status != "Completed":
        detail = summary["error"] if summary else json.dumps(job.get("failureReason"), indent=2)
        raise SystemExit(f"{name} failed at step {summary['step'] if summary else '?'}:\n{detail}")
    print(json.dumps(summary, indent=2))
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="run Silver_OMOP_Build then Gold_i2b2_Build")
    args = parser.parse_args()
    state, cfg = load_state(), settings()
    ws_id = state["workspace_id"]
    silver_id, gold_id = state["lakehouses"][cfg["LAKEHOUSE_SILVER_OMOP"]], state["lakehouses"][cfg["LAKEHOUSE_GOLD_I2B2"]]
    upload_code(ws_id, silver_id)
    ids = {name: deploy(ws_id, name, content, description)
           for name, (content, description) in definitions(state, cfg).items()}
    if args.run:
        run(ws_id, ids["Silver_OMOP_Build"], "Silver_OMOP_Build", silver_id, "silver_omop")
        run(ws_id, ids["Gold_i2b2_Build"], "Gold_i2b2_Build", gold_id, "gold_i2b2")


if __name__ == "__main__":
    main()
