"""Stage 4, step 2: the i2b2 CRC query store (Fabric SQL database Cohort_Requests, schema crc).

Creates the database, the i2b2 QT_* tables with their seed rows (status types, result types, breakdown paths), the
COHORT_* tables for natural-language context, data requests and the audit trail, and the V_* views the request
dashboards read. Safe to rerun: existing tables and recorded queries are kept.
"""
from common import ensure_openssl

ensure_openssl()

import cohort_store as store  # noqa: E402


def main():
    info = store.ensure_database()
    print(f"CRC store: {info['server']} / {info['database']}")
    conn = store.connect()
    store.create_schema(conn)
    cur = conn.cursor()
    cur.execute("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'crc' ORDER BY 1")
    print("  " + ", ".join(r[0] for r in cur.fetchall()))
    conn.close()


if __name__ == "__main__":
    main()
