"""Stage 3, step 3: build the Gold layer, an i2b2 star schema and ontology for cohort discovery, from Silver OMOP.

Runs i2b2_etl.py with DuckDB on this machine over the OMOP Parquet files written by 14_silver_omop.py and saves the
i2b2 tables to data/generated/i2b2/*.parquet. patient_num and encounter_num are random surrogates; their mappings to
Epic and OMOP IDs are saved to data/generated/omop/mapping/ (reused by the next build so the surrogates stay stable).
With --upload, writes the i2b2 tables to the Gold_i2b2 lakehouse and the mappings to Silver_OMOP as
i2b2_patient_mapping and i2b2_encounter_mapping (needs the capacity running).
"""
from __future__ import annotations

import argparse
import importlib

import duckdb

import i2b2_etl
from common import GEN_DIR, load_state, onelake_delete_folder, settings
from omop_schema import CDM, VOCAB_FILES

silver = importlib.import_module("14_silver_omop")
GOLD_DIR = GEN_DIR / "i2b2"
MAP_DIR = GEN_DIR / "omop" / "mapping"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upload", action="store_true", help="write the tables to the Gold_i2b2 lakehouse")
    parser.add_argument("--skip-build", action="store_true", help="upload the Parquet files from a previous build")
    args = parser.parse_args()
    if not (silver.CDM_DIR / "person.parquet").exists():
        raise SystemExit("Run 14_silver_omop.py first.")

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    if not args.skip_build:
        con.execute("CREATE SCHEMA omop")
        for name in CDM:
            con.execute(f"CREATE VIEW omop.{name} AS SELECT * FROM read_parquet('{silver.CDM_DIR / name}.parquet')")
        con.execute("CREATE SCHEMA vocab")
        for name in VOCAB_FILES:
            con.execute(f"CREATE VIEW vocab.{name} AS SELECT * FROM read_parquet('{silver.VOCAB_DIR / name}.parquet')")
        con.execute("CREATE SCHEMA prior")
        for name in i2b2_etl.MAPPING:
            if (MAP_DIR / f"{name}.parquet").exists():
                con.execute(f"CREATE TABLE prior.{name} AS SELECT * FROM read_parquet('{MAP_DIR / name}.parquet')")
        print("Building i2b2 star schema and ontology")
        i2b2_etl.build_gold(con)
        GOLD_DIR.mkdir(parents=True, exist_ok=True)
        for name in i2b2_etl.GOLD:
            con.execute(f"COPY gold.{name} TO '{GOLD_DIR / name}.parquet' (FORMAT parquet, COMPRESSION zstd)")
            print(f"  {name:<22} {con.execute(f'SELECT count(*) FROM gold.{name}').fetchone()[0]:>10,}")
        MAP_DIR.mkdir(parents=True, exist_ok=True)
        for name in i2b2_etl.MAPPING:
            con.execute(f"COPY mapping.{name} TO '{MAP_DIR / name}.parquet' (FORMAT parquet, COMPRESSION zstd)")
            print(f"  {name:<22} {con.execute(f'SELECT count(*) FROM mapping.{name}').fetchone()[0]:>10,}"
                  "  (protected: Silver_OMOP)")
        print("Top-level ontology folders (patients):")
        for name, n in con.execute("SELECT c_name, c_totalnum FROM gold.table_access ORDER BY c_fullname").fetchall():
            print(f"  {name:<30} {n:>6,}")

    if args.upload:
        print(f"Uploading to {settings()['LAKEHOUSE_GOLD_I2B2']}")
        tables = {name: f"SELECT * FROM read_parquet('{GOLD_DIR / name}.parquet')" for name in i2b2_etl.GOLD}
        silver.upload(con, tables, settings()["LAKEHOUSE_GOLD_I2B2"],
                      "Gold: i2b2 CRC star schema (observation_fact and dimensions) and i2b2 ontology with patient "
                      "counts, built from Silver_OMOP for cohort discovery.")
        print(f"Uploading the surrogate-key mappings to {settings()['LAKEHOUSE_SILVER_OMOP']}")
        silver.upload(con, {f"i2b2_{name}": f"SELECT * FROM read_parquet('{MAP_DIR / name}.parquet')"
                            for name in i2b2_etl.MAPPING}, settings()["LAKEHOUSE_SILVER_OMOP"], "")
        # Earlier builds kept the source-ID mappings in Gold; they now belong on the protected side only
        state = load_state()
        for name in i2b2_etl.MAPPING:
            onelake_delete_folder(state["workspace_id"], state["lakehouses"][settings()["LAKEHOUSE_GOLD_I2B2"]],
                                  f"Tables/{name}")


if __name__ == "__main__":
    main()
