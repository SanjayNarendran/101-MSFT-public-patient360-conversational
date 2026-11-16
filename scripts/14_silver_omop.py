"""Stage 3, step 2: build the Silver layer, an OMOP CDM v5.4 copy of the Bronze data, and load it into Silver_OMOP.

Runs omop_etl.py with DuckDB on this machine (no Fabric capacity used for the transform) and saves every OMOP table to
data/generated/omop/cdm/*.parquet. With --upload, writes them plus the standardized vocabularies as Delta tables into
the Silver_OMOP lakehouse (needs the capacity running).

  --source local     read the generated Bronze files in data/generated (default)
  --source onelake   read the Bronze lakehouses and Bronze_PACS through OneLake, as the Fabric notebook does
"""
from __future__ import annotations

import argparse
import time

import duckdb
import pandas as pd

import omop_etl as etl
from common import GEN_DIR, fabric, fabric_list, load_state, save_state, settings, storage_token
from omop_schema import CDM, EXTENSIONS, VOCAB, VOCAB_FILES

VOCAB_DIR = GEN_DIR / "omop" / "vocab"
CDM_DIR = GEN_DIR / "omop" / "cdm"


class LocalBronze:
    """The Bronze layer as generated on this machine (identical to what was loaded into Bronze_Clarity and Bronze_PACS)."""

    def __init__(self):
        import pacs_index
        self._pacs = pacs_index.named_tables()

    def clarity(self, name: str) -> pd.DataFrame:
        return pd.read_csv(GEN_DIR / "clarity" / f"{name}.csv.gz", dtype=str, keep_default_na=False, na_values=[""])

    def pacs(self, name: str) -> pd.DataFrame:
        return self._pacs[name]

    def documents(self) -> pd.DataFrame:
        return pd.read_csv(GEN_DIR / "documents" / "document_index.csv")

    def document_texts(self, paths: list[str]) -> list[str]:
        return [(GEN_DIR / "documents" / p.removeprefix("Files/")).read_text() for p in paths]


def onelake_bronze() -> etl.OneLakeBronze:
    state, cfg = load_state(), settings()
    return etl.OneLakeBronze(state["workspace_id"], state["lakehouses"][cfg["LAKEHOUSE_CLARITY"]],
                             state["pacs_database"]["id"], state["lakehouses"][cfg["LAKEHOUSE_DOCUMENTS"]],
                             storage_token)


def ensure_lakehouse(name: str, description: str) -> tuple[str, str]:
    state = load_state()
    ws_id = state["workspace_id"]
    lh = next((x for x in fabric_list(f"/workspaces/{ws_id}/lakehouses") if x["displayName"] == name), None)
    if lh is None:
        lh = fabric("POST", f"/workspaces/{ws_id}/lakehouses", {"displayName": name, "description": description})
        print(f"Created lakehouse {name}")
    save_state(lakehouses={**state["lakehouses"], name: lh["id"]})
    return ws_id, lh["id"]


def refresh_endpoint(ws_id: str, lh_id: str):
    for _ in range(30):
        props = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{lh_id}")["properties"].get("sqlEndpointProperties", {})
        if props.get("id") and props.get("provisioningStatus") == "Success":
            fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{props['id']}/refreshMetadata", {})
            return
        time.sleep(10)
    print("  SQL analytics endpoint not ready yet; refresh its metadata later")


def upload(con: duckdb.DuckDBPyConnection, tables: dict[str, str], lakehouse: str, description: str):
    """tables: Delta table name -> DuckDB query producing it."""
    ws_id, lh_id = ensure_lakehouse(lakehouse, description)
    root = f"abfss://{ws_id}@onelake.dfs.fabric.microsoft.com/{lh_id}/Tables"
    for name, query in tables.items():
        start = time.time()
        n = etl.write_delta(con, query, f"{root}/{name}", {"bearer_token": storage_token(),
                                                          "use_fabric_endpoint": "true"})
        print(f"  {name:<24} {n:>12,} rows  {time.time() - start:6.1f}s")
    refresh_endpoint(ws_id, lh_id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["local", "onelake"], default="local")
    parser.add_argument("--upload", action="store_true", help="write the tables to the Silver_OMOP lakehouse")
    parser.add_argument("--skip-build", action="store_true", help="upload the Parquet files from a previous build")
    parser.add_argument("--only", nargs="+", metavar="TABLE", help="upload only these tables")
    args = parser.parse_args()
    if not (VOCAB_DIR / "concept.parquet").exists():
        raise SystemExit("Run 13_omop_vocabulary.py first.")

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    if not args.skip_build:
        etl.register_vocab(con, {t: str(VOCAB_DIR / f"{t}.parquet") for t in VOCAB_FILES})
        print(f"Reading Bronze ({args.source})")
        etl.register_bronze(con, LocalBronze() if args.source == "local" else onelake_bronze())
        print("Building OMOP CDM v5.4")
        etl.build_silver(con)
        CDM_DIR.mkdir(parents=True, exist_ok=True)
        for name in {**CDM, **EXTENSIONS}:
            con.execute(f"COPY cdm.{name} TO '{CDM_DIR / name}.parquet' (FORMAT parquet, COMPRESSION zstd)")
        print("Rows and standard-concept coverage:")
        for name in {**CDM, **EXTENSIONS}:
            n = con.execute(f"SELECT count(*) FROM cdm.{name}").fetchone()[0]
            if n:
                print(f"  {name:<24} {n:>10,}")
        for table, n, mapped in etl.coverage(con):
            print(f"  {table:<24} {mapped / max(n, 1):7.1%} of {n:,} mapped")

    if args.upload:
        print(f"Uploading to {settings()['LAKEHOUSE_SILVER_OMOP']}")
        tables = {name: f"SELECT * FROM read_parquet('{CDM_DIR / name}.parquet')" for name in {**CDM, **EXTENSIONS}}
        for name, cols in VOCAB.items():
            select = ", ".join(f"CAST({c} AS {t}) AS {c}" for c, t in cols)
            source = (f"read_parquet('{VOCAB_DIR / name}.parquet')" if name in VOCAB_FILES
                      else f"(SELECT {', '.join(f'NULL AS {c}' for c, _ in cols)} WHERE false)")
            tables[name] = f"SELECT {select} FROM {source}"
        if args.only:
            tables = {k: v for k, v in tables.items() if k in args.only}
        upload(con, tables, settings()["LAKEHOUSE_SILVER_OMOP"],
               "Silver: OMOP CDM v5.4 (+ medical imaging extension) built from the Bronze layer, with the OMOP "
               "standardized vocabularies from Microsoft healthcare data solutions.")


if __name__ == "__main__":
    main()
