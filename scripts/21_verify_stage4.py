"""Stage 4 verification: cohort discovery on the semantic models, the MCP server and the data-request workflow.

Checks:
1. The i2b2 query compiler gives the same patient count in DAX (Cohort Discovery semantic model, Direct Lake on
   Gold_i2b2) as in SQL (DuckDB over the local Gold build) for queries covering folders, AND/OR/NOT, numeric values,
   modifiers, occurrences, dates and SAMEVISIT.
2. The cohort-discovery MCP server starts over stdio and exposes exactly the researcher tools (no approve/deliver).
3. The Cohort Requests DirectQuery model answers from the CRC store.
4. With --e2e: run -> submit -> approve (user data function) -> deliver (Cohort_Delivery notebook), then check the
   delivery against the exact count, run its Explore notebook, and remove the test request and its delivery.

  python scripts/21_verify_stage4.py [--e2e]
"""
import argparse
import asyncio
import importlib
import json
import sys
import time
from pathlib import Path

from common import GEN_DIR, _fabric_token, ensure_openssl, fabric_list, load_state

ensure_openssl()

import duckdb  # noqa: E402
import requests  # noqa: E402

import cohort_store as store  # noqa: E402
from cohort_service import CohortService, cross_check  # noqa: E402
from semantic_models import execute_dax  # noqa: E402

AGE = "\\\\i2b2_demographics\\i2b2\\Demographics\\Age\\{}\\"
SMOKER = "\\\\i2b2_vital_signs_and_assessments\\i2b2\\Vital Signs and Assessments\\LOINC_72166-2\\LOINC_LA15920-4\\"
NODULE = "\\\\i2b2_imaging\\i2b2\\Imaging\\Lung nodule findings (LIDC)\\SNOMED_246120007\\"
LDCT = "\\\\i2b2_procedures\\i2b2\\Procedures\\Imaging procedures\\SNOMED_16334891000119106\\"
CT_STUDIES = "\\\\i2b2_imaging\\i2b2\\Imaging\\Studies\\CT\\"
R91 = "\\\\i2b2_diagnoses\\i2b2\\Diagnoses\\R00-R99\\R91\\"
EMPHYSEMA = "\\\\i2b2_diagnoses\\i2b2\\Diagnoses\\J00-J99\\J43\\"
PRIMARY_DX = "\\\\i2b2_modifiers\\Diagnosis role\\Primary diagnosis\\"


def item(key, **extra):
    return {"item_key": key, **extra}


def value(op, v):
    return {"constrain_by_value": {"value_operator": op, "value_constraint": v, "value_type": "NUMBER",
                                   "value_unit_of_measure": "mm"}}


QUERIES = {
    "former smokers 50+ with a nodule >= 6 mm": {"panels": [
        {"items": [item(AGE.format(a)) for a in ("50-64 years old", "65-79 years old", "80 years old and over")]},
        {"items": [item(SMOKER)]}, {"items": [item(NODULE, **value("GE", "6"))]}]},
    "low-dose chest CT, nodule >= 8 mm, NOT emphysema": {"panels": [
        {"items": [item(LDCT)]}, {"items": [item(NODULE, **value("GE", "8"))]},
        {"items": [item(EMPHYSEMA)], "invert": 1}]},
    "nodule between 4 and 10 mm": {"panels": [{"items": [item(NODULE, **value("BETWEEN", "4 and 10"))]}]},
    "R91 as a primary diagnosis (modifier)": {"panels": [
        {"items": [item(R91, constrain_by_modifier={"modifier_key": PRIMARY_DX})]}]},
    "3 or more CT studies (occurrences)": {"panels": [{"items": [item(CT_STUDIES)], "total_item_occurrences": 3}]},
    "R91 or emphysema since 2024 (dates)": {"panels": [
        {"items": [item(R91), item(EMPHYSEMA)], "panel_date_from": "2024-01-01"}]},
    "low-dose CT and R91 in the same visit": {"query_timing": "SAMEVISIT", "panels": [
        {"items": [item(LDCT)], "panel_timing": "SAMEVISIT"}, {"items": [item(R91)], "panel_timing": "SAMEVISIT"}]},
    "same visit, excluding emphysema at any time": {"query_timing": "SAMEVISIT", "panels": [
        {"items": [item(LDCT)], "panel_timing": "SAMEVISIT"}, {"items": [item(R91)], "panel_timing": "SAMEVISIT"},
        {"items": [item(EMPHYSEMA)], "invert": 1, "panel_timing": "ANY"}]},
}

RESEARCHER_TOOLS = {"search_ontology", "browse_ontology", "list_modifiers", "preview_query", "run_i2b2_query",
                    "list_queries", "get_query", "submit_request", "request_status"}


def local_gold() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for f in sorted((GEN_DIR / "i2b2").glob("*.parquet")):
        con.execute(f"CREATE VIEW {f.stem} AS SELECT * FROM read_parquet('{f.as_posix()}')")
    return con


def check_compiler(service: CohortService, con) -> int:
    print("1. i2b2 queries: DAX on the semantic model vs SQL on the local Gold build")
    failures = 0
    for name, query in QUERIES.items():
        print(f"  {name}")
        dax_n, sql_n = cross_check(service, query, con)
        if dax_n != sql_n or dax_n == 0:
            print("    FAIL" + (" (empty cohort)" if dax_n == 0 else ""))
            failures += 1
    return failures


def check_mcp() -> int:
    print("2. MCP server tools")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def tools():
        params = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).with_name("cohort_mcp.py"))])
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                return {t.name for t in (await s.list_tools()).tools}
    names = asyncio.run(tools())
    print(f"  {sorted(names)}")
    if names != RESEARCHER_TOOLS:
        print(f"    FAIL: expected {sorted(RESEARCHER_TOOLS)}")
        return 1
    return 0


def check_requests_model(state) -> int:
    print("3. Cohort Requests model (DirectQuery on the CRC store)")
    rows = execute_dax(state["workspace_id"], state["cohort_app"]["requests_model_id"],
                       'EVALUATE ROW("requests", COUNTROWS(Request), "events", COUNTROWS(Event))')
    print(f"  {rows[0]}")
    return 0


def explore_runs(ws_id: str, notebook_id: str) -> bool:
    """Runs the delivery's Explore notebook (research_notebook.py) as a job; True when every cell ran."""
    url = f"https://api.fabric.microsoft.com/v1/workspaces/{ws_id}/items/{notebook_id}/jobs/instances?jobType=RunNotebook"
    resp = requests.post(url, json={}, timeout=60, headers={"Authorization": f"Bearer {_fabric_token()}"})
    location, start = resp.headers.get("Location"), time.time()
    while location and time.time() - start < 900:
        time.sleep(15)
        job = requests.get(location, timeout=60, headers={"Authorization": f"Bearer {_fabric_token()}"}).json()
        if job.get("status") in ("Completed", "Failed", "Cancelled", "Deduped"):
            print(f"  Explore notebook: {job['status']} in {time.time() - start:.0f}s"
                  + (f" ({json.dumps(job.get('failureReason'))[:400]})" if job["status"] != "Completed" else ""))
            return job["status"] == "Completed"
    return False


def check_e2e(service: CohortService, con, state) -> int:
    print("4. End to end: run -> submit -> approve -> deliver")
    app = importlib.import_module("20_cohort_app")
    nb = importlib.import_module("16_fabric_notebooks")
    name, query = next(iter(QUERIES.items()))
    exact = cross_check(service, query, con)[1]
    run = service.run(query, f"VERIFY: {name}")
    qm = run["query_master_id"]
    print(f"  QUERY_MASTER_ID {qm}: {run['patient_count_display']} (exact {exact})")
    failures = 0
    try:
        request = service.submit(qm, "VERIFY stage 4")
        print(f"  submitted, dashboard {request['REPORT_URL']}")
        decided = app.invoke_udf(state["workspace_id"], state["cohort_app"]["udf_id"], "decideRequest",
                                 {"queryMasterId": qm, "decision": "APPROVED", "comment": "stage 4 verification"})
        print(f"  {decided['status']}: {decided['output']}")
        summary = nb.run(state["workspace_id"], state["cohort_app"]["delivery_notebook_id"], "Cohort_Delivery",
                         state["lakehouses"][service.cfg["LAKEHOUSE_SILVER_OMOP"]], "cohort_delivery",
                         timeout_min=30, parameters={"QUERY_MASTER_ID": qm})
        request = service.request(qm)
        explore = next((n for n in fabric_list(f"/workspaces/{state['workspace_id']}/notebooks")
                        if n["displayName"] == summary.get("notebook")), None)
        explored = explore and explore_runs(state["workspace_id"], explore["id"])
        checks = {"status DELIVERED": request["STATUS"] == "DELIVERED",
                  "delivered patients = exact count": request["DELIVERED_PATIENTS"] == exact,
                  "person rows = exact count": summary["rows"]["person"] == exact,
                  "cohort rows = exact count": summary["rows"]["cohort"] == exact,
                  f"notebook {summary.get('notebook')} created and runs": bool(explored)}
        for label, ok in checks.items():
            print(f"  {'ok  ' if ok else 'FAIL'} {label}")
            failures += not ok
    finally:
        print("  removed: " + ", ".join(service.remove_request(qm) if store.get_request(service.conn, qm) else []))
        store.delete_query(service.conn, qm)
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--e2e", action="store_true", help="also run a request end to end (uses Fabric capacity)")
    args = parser.parse_args()
    state, service, con = load_state(), CohortService(), local_gold()
    failures = check_compiler(service, con) + check_mcp() + check_requests_model(state)
    if args.e2e:
        failures += check_e2e(service, con, state)
    if failures:
        raise SystemExit(f"{failures} check(s) failed")
    print("All stage 4 checks passed")


if __name__ == "__main__":
    main()
