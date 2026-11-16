"""Verifies stage 2 end to end, from Fabric (after waiting for the PACS database to replicate to OneLake):

1. One cross-database query on the SQL analytics endpoints joins Clarity (the Bronze_Clarity lakehouse), the PACS
   SQL database and the documents lakehouse on the accession number.
2. Coverage checks: every PACS study is a Clarity imaging order, every ONLINE study has archived instances, and every
   radiology/pathology report points to a PACS study.
3. A random sample of PACS instances is checked against the files in the imaging archive lakehouse (size match).
"""
import os
import sys
import time

_SSL = "/opt/homebrew/opt/openssl@3/lib"
if sys.platform == "darwin" and os.path.isdir(_SSL) and _SSL not in os.environ.get("DYLD_LIBRARY_PATH", ""):
    os.environ["DYLD_LIBRARY_PATH"] = _SSL
    os.execv(sys.executable, [sys.executable] + sys.argv)

import mssql_python  # noqa: E402
import requests  # noqa: E402

from common import ONELAKE_DFS, fabric, fabric_list, load_state, settings, storage_token  # noqa: E402

CROSS_SOURCE = """
SELECT TOP 10
    p.PAT_MRN_ID                         AS Mrn,
    o.DESCRIPTION                        AS OrderedExam,
    a.ACC_NUM                            AS Accession,
    s.InstanceAvailability,
    s.NumberOfStudyRelatedInstances      AS Images,
    n.Nodules,
    d.Title                              AS Report,
    d.OneLakePath
FROM {clarity}.dbo.ORDER_RAD_ACC_NUM a
JOIN {clarity}.dbo.ORDER_PROC o            ON o.ORDER_PROC_ID = a.ORDER_PROC_ID
JOIN {clarity}.dbo.PATIENT p               ON p.PAT_ID = o.PAT_ID
JOIN {pacs}.pacs.Study s                   ON s.AccessionNumber = a.ACC_NUM
LEFT JOIN (SELECT StudyKey, COUNT(*) AS Nodules FROM {pacs}.pacs.NoduleFinding GROUP BY StudyKey) n
                                         ON n.StudyKey = s.StudyKey
JOIN {docs}.dbo.document_index d ON d.AccessionNumber = a.ACC_NUM
WHERE s.InstanceAvailability = 'ONLINE' AND n.Nodules > 0
ORDER BY n.Nodules DESC, a.ACC_NUM
"""

CHECKS = {
    "PACS studies without a Clarity imaging order":
        "SELECT COUNT(*) FROM {pacs}.pacs.Study s LEFT JOIN {clarity}.dbo.ORDER_RAD_ACC_NUM a "
        "ON a.ACC_NUM = s.AccessionNumber WHERE a.ACC_NUM IS NULL",
    "Clarity imaging orders without a PACS study":
        "SELECT COUNT(*) FROM {clarity}.dbo.ORDER_RAD_ACC_NUM a LEFT JOIN {pacs}.pacs.Study s "
        "ON s.AccessionNumber = a.ACC_NUM WHERE s.StudyKey IS NULL",
    "ONLINE studies without archived instances":
        "SELECT COUNT(*) FROM {pacs}.pacs.Study s WHERE s.InstanceAvailability = 'ONLINE' AND NOT EXISTS "
        "(SELECT 1 FROM {pacs}.pacs.Series se JOIN {pacs}.pacs.Instance i ON i.SeriesKey = se.SeriesKey "
        "WHERE se.StudyKey = s.StudyKey)",
    "Reports whose accession is not in PACS":
        "SELECT COUNT(*) FROM {docs}.dbo.document_index d LEFT JOIN {pacs}.pacs.Study s "
        "ON s.AccessionNumber = d.AccessionNumber WHERE d.AccessionNumber IS NOT NULL AND s.StudyKey IS NULL",
    "Imaging orders without a report":
        "SELECT COUNT(*) FROM {clarity}.dbo.ORDER_RAD_ACC_NUM a LEFT JOIN {docs}.dbo.document_index d "
        "ON d.AccessionNumber = a.ACC_NUM WHERE d.DocumentId IS NULL",
}

SUMMARY = """
SELECT 'PACS studies' AS Item, COUNT(*) AS N FROM {pacs}.pacs.Study
UNION ALL SELECT 'PACS ONLINE studies', COUNT(*) FROM {pacs}.pacs.Study WHERE InstanceAvailability = 'ONLINE'
UNION ALL SELECT 'PACS instances (archived)', COUNT(*) FROM {pacs}.pacs.Instance
UNION ALL SELECT 'PACS nodule findings', COUNT(*) FROM {pacs}.pacs.NoduleFinding
UNION ALL SELECT 'Documents', COUNT(*) FROM {docs}.dbo.document_index
UNION ALL SELECT 'Scanned documents', COUNT(*) FROM {docs}.dbo.document_index WHERE IsScanned = 1
UNION ALL SELECT 'Ground-truth facts', COUNT(*) FROM {docs}.dbo.document_facts
"""


def refresh_endpoints(ws_id):
    for ep in fabric_list(f"/workspaces/{ws_id}/sqlEndpoints"):
        fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{ep['id']}/refreshMetadata", {})


def wait_for_replication(state, endpoint_cursor, pacs_name, timeout_min=30):
    """Fabric replicates the PACS SQL database to OneLake asynchronously; wait until the SQL analytics endpoint
    shows the same row counts as the database itself (a reload drops and recreates the tables)."""
    db = state["pacs_database"]
    conn = mssql_python.connect(f"Server={db['server'].split(',')[0]};Database={db['database']};"
                                "Authentication=ActiveDirectoryDefault;Encrypt=yes;")
    cur = conn.cursor()
    tables = ["Study", "Series", "Instance", "NoduleFinding"]
    expected = {}
    for t in tables:
        cur.execute(f"SELECT COUNT(*) FROM pacs.{t}")
        expected[t] = cur.fetchone()[0]
    conn.close()
    deadline = time.time() + timeout_min * 60
    while True:
        seen = {}
        for t in tables:
            try:
                endpoint_cursor.execute(f"SELECT COUNT(*) FROM {pacs_name}.pacs.{t}")
                seen[t] = endpoint_cursor.fetchone()[0]
            except Exception:
                seen[t] = None
        if seen == expected:
            print(f"PACS replicated to OneLake: {expected}")
            return
        if time.time() > deadline:
            raise SystemExit(f"PACS replication incomplete after {timeout_min} min: {seen} vs {expected}")
        print(f"  waiting for PACS replication: {seen} of {expected}")
        time.sleep(30)
        refresh_endpoints(state["workspace_id"])


def main():
    cfg = settings()
    names = {"clarity": cfg["LAKEHOUSE_CLARITY"], "pacs": cfg["PACS_DATABASE"], "docs": cfg["LAKEHOUSE_DOCUMENTS"]}
    state = load_state()
    ws_id = state["workspace_id"]
    refresh_endpoints(ws_id)
    lh = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{state['lakehouses'][names['clarity']]}")
    host = lh["properties"]["sqlEndpointProperties"]["connectionString"]
    conn = mssql_python.connect(f"Server={host};Database={names['clarity']};Authentication=ActiveDirectoryDefault;"
                                "Encrypt=yes;")
    cur = conn.cursor()
    wait_for_replication(state, cur, names["pacs"])

    cur.execute(SUMMARY.format(**names))
    for item, n in cur.fetchall():
        print(f"  {item:<28} {n:>10,}")

    failures = 0
    print("\nCoverage checks:")
    for label, query in CHECKS.items():
        cur.execute(query.format(**names))
        n = cur.fetchone()[0]
        failures += n > 0
        print(f"  {'OK ' if n == 0 else 'FAIL'} {label}: {n:,}")

    print("\nOne query across Clarity, the PACS SQL database and the document lakehouse:")
    cur.execute(CROSS_SOURCE.format(**names))
    cols = [c[0] for c in cur.description]
    print("  " + " | ".join(cols))
    for row in cur.fetchall():
        print("  " + " | ".join(str(v) for v in row))

    cur.execute(f"SELECT TOP 25 i.FileSizeBytes, i.StoragePath FROM {names['pacs']}.pacs.Instance i ORDER BY NEWID()")
    sample = cur.fetchall()
    conn.close()
    archive = state["lakehouses"][cfg["LAKEHOUSE_IMAGING"]]
    bad = 0
    for size, path in sample:
        resp = requests.head(f"{ONELAKE_DFS}/{ws_id}/{archive}/{path}", timeout=60,
                             headers={"Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03"})
        if resp.status_code != 200 or int(resp.headers.get("Content-Length", -1)) != int(size):
            bad += 1
    print(f"\nArchive spot check: {len(sample) - bad}/{len(sample)} sampled instances match their OneLake file")
    failures += bad > 0
    if failures:
        raise SystemExit(f"{failures} check(s) failed")
    print("Stage 2 verified.")


if __name__ == "__main__":
    main()
