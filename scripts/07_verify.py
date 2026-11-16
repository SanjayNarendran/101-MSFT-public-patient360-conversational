"""Verifies Stage 1: every Epic table's row count in its generated file (data/generated) must match the row count the
lakehouse SQL analytics endpoint reads, the time columns must be visible there, and a query joining Clarity and
Caboodle must return rows.

Run:  .venv/bin/python scripts/07_verify.py
"""
import gzip
import time

from common import GEN_DIR, ensure_openssl, fabric, load_state, settings

ensure_openssl()

import mssql_python  # noqa: E402

from epic_schema import SCHEMAS  # noqa: E402

CROSS_SOURCE_QUERY = """  -- {clarity} and {caboodle} are the lakehouse names
SELECT TOP 10
    p.PAT_MRN_ID                      AS Mrn,
    d.Name                            AS Diagnosis,
    d.Icd10Code,
    COUNT(DISTINCT e.EncounterKey)    AS Encounters,
    MAX(c.ORD_NUM_VALUE)              AS MaxHbA1c
FROM {caboodle}.dbo.DiagnosisEventFact e
JOIN {caboodle}.dbo.DiagnosisDim d      ON d.DiagnosisKey = e.DiagnosisKey
JOIN {caboodle}.dbo.PatientDim pd       ON pd.PatientKey = e.PatientKey
JOIN {clarity}.dbo.PATIENT p            ON p.PAT_ID = pd.PatientEpicId
JOIN {clarity}.dbo.ORDER_RESULTS c      ON c.PAT_ID = p.PAT_ID
JOIN {clarity}.dbo.CLARITY_COMPONENT cc ON cc.COMPONENT_ID = c.COMPONENT_ID AND cc.BASE_NAME = 'A1C'
WHERE d.Icd10Code LIKE 'E11%' AND e.Type = 'Problem List'
GROUP BY p.PAT_MRN_ID, d.Name, d.Icd10Code
ORDER BY MaxHbA1c DESC
"""


def local_rows(path) -> int:
    """Rows in a generated CSV (quoted values never span lines)."""
    with gzip.open(path, "rt") as f:
        return sum(1 for _ in f) - 1


def connect(host: str, database: str):
    return mssql_python.connect(f"Server={host};Database={database};Authentication=ActiveDirectoryDefault;Encrypt=yes;")


def main():
    cfg = settings()
    state = load_state()
    ws_id = state["workspace_id"]

    mismatches, missing_times = 0, []
    host = None
    for schema, tables in SCHEMAS.items():
        lh_name = cfg[f"LAKEHOUSE_{schema}"]
        lh = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{state['lakehouses'][lh_name]}")
        endpoint = lh["properties"]["sqlEndpointProperties"]
        host = endpoint["connectionString"]
        fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{endpoint['id']}/refreshMetadata", {})
        conn = connect(host, lh_name)
        cur = conn.cursor()
        print(f"{schema:<10} {'table':<26} {'generated':>10} {'Fabric':>10}")
        for table, cols in tables.items():
            expected = local_rows(GEN_DIR / schema.lower() / f"{table}.csv.gz")
            for attempt in range(6):
                try:
                    cur.execute(f"SELECT COUNT_BIG(*) FROM dbo.[{table}]")
                    found = cur.fetchone()[0]
                    break
                except mssql_python.Error:
                    if attempt == 5:
                        raise
                    time.sleep(20)  # the endpoint can take a minute to show a new table
            cur.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (table,))
            seen = {r[0] for r in cur.fetchall()}
            missing_times += [f"{table}.{c}" for c, _ in cols if c not in seen]
            flag = "" if expected == found else "  <-- MISMATCH"
            mismatches += expected != found
            print(f"{'':<10} {table:<26} {expected:>10,} {found:>10,}{flag}")
        conn.close()

    print("\nCross-source query in Fabric (Caboodle problem list + Clarity lab results):")
    conn = connect(host, cfg["LAKEHOUSE_CLARITY"])
    cur = conn.cursor()
    cur.execute(CROSS_SOURCE_QUERY.format(clarity=cfg["LAKEHOUSE_CLARITY"], caboodle=cfg["LAKEHOUSE_CABOODLE"]))
    rows = cur.fetchall()
    for row in rows:
        print("  ", " | ".join(str(v) for v in row))
    conn.close()

    if missing_times:
        raise SystemExit(f"Columns the SQL endpoint does not show: {', '.join(missing_times)}")
    if mismatches:
        raise SystemExit(f"{mismatches} table(s) differ between the generated files and Fabric")
    if not rows:
        raise SystemExit("The cross-source query returned no rows")
    print("\nAll tables match the generated files and every column is visible.")


if __name__ == "__main__":
    main()
