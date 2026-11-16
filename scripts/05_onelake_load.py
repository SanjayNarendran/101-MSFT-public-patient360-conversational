"""Stage 1: loads the Epic-style tables into OneLake as Delta tables in the Bronze lakehouses.

The generator (02) writes each table as data/generated/<clarity|caboodle>/<TABLE>.csv.gz. This script reads each file
with DuckDB, typed as epic_schema.py declares, and writes it as a Delta table: the CLARITY tables into the lakehouse
named by LAKEHOUSE_CLARITY (Bronze_Clarity), the CABOODLE tables into LAKEHOUSE_CABOODLE (Bronze_Caboodle). Table and
column names stay exactly as in epic_schema.py, because later SQL uses them and the SQL analytics endpoint is
case-sensitive. Times are written as UTC timestamps, which the endpoint shows (it leaves out naive timestamps).

Every table is overwritten, so the script can run again; name tables to reload only those. It ends by refreshing each
lakehouse's SQL analytics endpoint so the tables appear there at once. 07_verify.py then checks every row count.

Run:  .venv/bin/python scripts/05_onelake_load.py [TABLE ...]
"""
from __future__ import annotations

import gzip
import re
import sys

import duckdb

from common import GEN_DIR, fabric, load_state, settings, storage_token
from epic_schema import SCHEMAS
from omop_etl import write_delta


def duck_type(t: str) -> str:
    """epic_schema's types as DuckDB reads them (TIMESTAMP is read as written, then made UTC)."""
    m = re.fullmatch(r"NUMBER\((\d+),(\d+)\)", t)
    if m:
        return f"DECIMAL({m.group(1)},{m.group(2)})"
    return {"INT": "INTEGER", "VARCHAR": "VARCHAR", "DATE": "DATE", "TIMESTAMP": "TIMESTAMP"}[t]


def header(path) -> list[str]:
    with gzip.open(path, "rt") as f:
        return next(f).rstrip("\r\n").split(",")


def table_query(path, cols: list[tuple[str, str]]) -> str:
    columns = ", ".join(f"'{name}': '{duck_type(t)}'" for name, t in cols)
    select = ", ".join(f'CAST("{name}" AS TIMESTAMPTZ) AS "{name}"' if t == "TIMESTAMP" else f'"{name}"' for name, t in cols)
    return (f"SELECT {select} FROM read_csv('{path}', header = true, columns = {{{columns}}}, nullstr = '', "
            f"dateformat = '%Y-%m-%d', timestampformat = '%Y-%m-%d %H:%M:%S')")


def main():
    cfg = settings()
    state = load_state()
    if "workspace_id" not in state:
        raise SystemExit("No workspace yet: run scripts/03_fabric_workspace.py first.")
    ws_id = state["workspace_id"]
    only = set(sys.argv[1:])
    known = {t for tables in SCHEMAS.values() for t in tables}
    if only - known:
        raise SystemExit(f"Unknown tables: {', '.join(sorted(only - known))}")

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    opts = {"bearer_token": storage_token(), "use_fabric_endpoint": "true"}
    targets = {}
    for schema, tables in SCHEMAS.items():
        lh_name = cfg[f"LAKEHOUSE_{schema}"]
        lh_id = state["lakehouses"][lh_name]
        targets[lh_name] = lh_id
        print(f"{schema} -> {lh_name}")
        for table, cols in tables.items():
            if only and table not in only:
                continue
            path = GEN_DIR / schema.lower() / f"{table}.csv.gz"
            if not path.exists():
                raise SystemExit(f"Missing {path}: run scripts/02_generate_epic_data.py first.")
            if header(path) != [c for c, _ in cols]:
                raise SystemExit(f"{path.name}: its columns differ from epic_schema.py; run 02 again.")
            uri = f"abfss://{ws_id}@onelake.dfs.fabric.microsoft.com/{lh_id}/Tables/{table}"
            rows = write_delta(con, table_query(path, cols), uri, opts)
            print(f"  {table:<26} {rows:>10,} rows")

    for lh_name, lh_id in targets.items():
        endpoint = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{lh_id}")["properties"].get("sqlEndpointProperties", {}).get("id")
        if not endpoint:
            print(f"{lh_name}: SQL analytics endpoint not provisioned yet; 07_verify.py refreshes it")
            continue
        result = fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{endpoint}/refreshMetadata", {})
        print(f"{lh_name}: SQL endpoint metadata refreshed for {len(result.get('value', []))} tables")


if __name__ == "__main__":
    main()
