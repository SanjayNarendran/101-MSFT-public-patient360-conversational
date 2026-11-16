"""Data access for the i2b2 CRC query store (Fabric SQL database, schema crc): runs, patient sets, data requests.

Connects with the signed-in Azure CLI identity (ActiveDirectoryDefault). Entry scripts must call
common.ensure_openssl() before importing this module on macOS.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import mssql_python

import i2b2_crc as crc
from common import fabric, fabric_list, load_state, save_state, settings

S = crc.SCHEMA


def ensure_database() -> dict:
    state, name = load_state(), settings()["COHORT_REQUEST_DATABASE"]
    ws_id = state["workspace_id"]
    db = next((d for d in fabric_list(f"/workspaces/{ws_id}/sqlDatabases") if d["displayName"] == name), None)
    if db is None:
        fabric("POST", f"/workspaces/{ws_id}/sqlDatabases",
               {"displayName": name, "description": "i2b2 CRC query store (QT_* tables) and cohort data requests."})
        db = next(d for d in fabric_list(f"/workspaces/{ws_id}/sqlDatabases") if d["displayName"] == name)
        print(f"Created SQL database {name}")
    props = fabric("GET", f"/workspaces/{ws_id}/sqlDatabases/{db['id']}")["properties"]
    info = {"id": db["id"], "server": props["serverFqdn"], "database": props["databaseName"]}
    save_state(cohort_requests_db=info)
    return info


def connect(attempts: int = 4):
    """Connects to the CRC store. Retries for about half a minute: right after the capacity resumes, the SQL
    database can refuse connections for a short while."""
    db = load_state()["cohort_requests_db"]
    for attempt in range(attempts):
        try:
            return mssql_python.connect(f"Server={db['server'].split(',')[0]};Database={db['database']};"
                                        "Authentication=ActiveDirectoryDefault;Encrypt=yes;", autocommit=False)
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(10)


def create_schema(conn):
    cur = conn.cursor()
    for statement in [s for s in crc.DDL.split(";") if s.strip()]:
        cur.execute(statement)
    for view in crc.VIEWS:
        cur.execute(view)
    for statement, params in crc.seed_statements():
        cur.execute(statement, params)
    conn.commit()


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def _one(cur, sql, params=()):
    cur.execute(sql, params)
    row = cur.fetchone()
    return row[0] if row else None


def _rows(cur, sql, params=()) -> list[dict]:
    cur.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def record_run(conn, *, user: str, name: str, request_xml: str, generated_query: str, query_json: dict,
               nl_question: str, summary: str, language: str, model_id: str, real_total: int,
               breakdowns: dict[str, list[tuple[str, int]]], patients: list[int], started: datetime) -> dict:
    """Stores one run the way the i2b2 CRC does and returns the IDs and the obfuscated counts the user may see."""
    cur = conn.cursor()
    now = _now()
    outputs = ["PATIENTSET", "PATIENT_COUNT_XML", *breakdowns]
    qm = _one(cur, f"""INSERT INTO {S}.QT_QUERY_MASTER (NAME, USER_ID, GROUP_ID, CREATE_DATE, DELETE_FLAG, REQUEST_XML,
                       GENERATED_SQL, I2B2_REQUEST_XML) OUTPUT INSERTED.QUERY_MASTER_ID VALUES (?, ?, ?, ?, 'N', ?, ?, ?)""",
              (name, user, crc.PROJECT, now, request_xml, generated_query,
               crc.request_message(request_xml, user, outputs)))
    cur.execute(f"""INSERT INTO {S}.COHORT_QUERY_CONTEXT VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (qm, nl_question, summary, json.dumps(query_json), language, model_id, "GitHub Copilot (MCP)"))
    qi = _one(cur, f"""INSERT INTO {S}.QT_QUERY_INSTANCE (QUERY_MASTER_ID, USER_ID, GROUP_ID, BATCH_MODE, START_DATE,
                       END_DATE, DELETE_FLAG, STATUS_TYPE_ID) OUTPUT INSERTED.QUERY_INSTANCE_ID
                       VALUES (?, ?, ?, 'FINISHED', ?, ?, 'N', 6)""", (qm, user, crc.PROJECT, started, now))
    total = crc.obfuscate(real_total, crc.SIGMA_TOTAL)

    def result(kind: str, set_size: int, real: int, method: str, description: str) -> int:
        return _one(cur, f"""INSERT INTO {S}.QT_QUERY_RESULT_INSTANCE (QUERY_INSTANCE_ID, RESULT_TYPE_ID, SET_SIZE,
                             START_DATE, END_DATE, STATUS_TYPE_ID, DELETE_FLAG, DESCRIPTION, REAL_SET_SIZE,
                             OBFUSC_METHOD) OUTPUT INSERTED.RESULT_INSTANCE_ID VALUES (?, ?, ?, ?, ?, 3, 'N', ?, ?, ?)""",
                    (qi, crc.RESULT_TYPE_IDS[kind], set_size, started, now, description, real, method))

    patient_set = result("PATIENTSET", total, real_total, "OBTOTAL", f'Patient Set for "{name}"'[:200])
    cur.execute(f"""INSERT INTO {S}.QT_PATIENT_SET_COLLECTION (RESULT_INSTANCE_ID, SET_INDEX, PATIENT_NUM)
                    SELECT ?, ROW_NUMBER() OVER (ORDER BY CAST(value AS BIGINT)), CAST(value AS BIGINT)
                    FROM OPENJSON(?)""", (patient_set, json.dumps(sorted(patients))))
    count = result("PATIENT_COUNT_XML", total, real_total, "OBSUBTOTAL",
                   f'{crc.RESULT_DESCRIPTIONS["PATIENT_COUNT_XML"]} for "{name}"'[:200])
    cur.execute(f"INSERT INTO {S}.QT_XML_RESULT (RESULT_INSTANCE_ID, XML_VALUE) VALUES (?, ?)",
                (count, crc.result_xml("PATIENT_COUNT_XML", [("patient_count", total)])))
    shown = {}
    for kind, cells in breakdowns.items():
        noisy = [(label, crc.obfuscate(n, crc.SIGMA_BREAKDOWN)) for label, n in cells]
        rid = result(kind, total, real_total, "OBSUBTOTAL", f'{crc.RESULT_DESCRIPTIONS[kind]} for "{name}"'[:200])
        cur.execute(f"INSERT INTO {S}.QT_XML_RESULT (RESULT_INSTANCE_ID, XML_VALUE) VALUES (?, ?)",
                    (rid, crc.result_xml(kind, noisy)))
        shown[crc.RESULT_DESCRIPTIONS[kind]] = {label: n for label, n in noisy}
    conn.commit()
    return {"query_master_id": qm, "query_instance_id": qi, "patient_set_result_instance_id": patient_set,
            "query_name": name, "patient_count": total, "patient_count_display": crc.display(total),
            "breakdowns": shown}


def list_queries(conn, user: str | None = None, limit: int = 20) -> list[dict]:
    where = "WHERE qm.DELETE_FLAG = 'N'" + (" AND qm.USER_ID = ?" if user else "")
    return _rows(conn.cursor(), f"""
        SELECT TOP {int(limit)} qm.QUERY_MASTER_ID, qm.NAME, qm.USER_ID, qm.CREATE_DATE, c.NL_QUESTION,
               ri.SET_SIZE AS PATIENT_COUNT, r.STATUS AS REQUEST_STATUS
        FROM {S}.QT_QUERY_MASTER qm
        LEFT JOIN {S}.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
        LEFT JOIN {S}.QT_QUERY_INSTANCE qi ON qi.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
        LEFT JOIN {S}.QT_QUERY_RESULT_INSTANCE ri ON ri.QUERY_INSTANCE_ID = qi.QUERY_INSTANCE_ID
             AND ri.RESULT_TYPE_ID = {crc.RESULT_TYPE_IDS['PATIENT_COUNT_XML']}
        LEFT JOIN {S}.COHORT_REQUEST r ON r.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
        {where} ORDER BY qm.QUERY_MASTER_ID DESC""", (user,) if user else ())


def get_query(conn, query_master_id: int) -> dict | None:
    rows = _rows(conn.cursor(), f"""
        SELECT qm.QUERY_MASTER_ID, qm.NAME, qm.USER_ID, qm.CREATE_DATE, qm.REQUEST_XML, qm.GENERATED_SQL,
               c.NL_QUESTION, c.QUERY_SUMMARY, c.QUERY_DEFINITION_JSON, c.QUERY_LANGUAGE,
               ps.RESULT_INSTANCE_ID AS PATIENT_SET_RESULT_INSTANCE_ID, ps.SET_SIZE AS PATIENT_COUNT
        FROM {S}.QT_QUERY_MASTER qm
        LEFT JOIN {S}.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
        OUTER APPLY (SELECT TOP 1 ri.RESULT_INSTANCE_ID, ri.SET_SIZE FROM {S}.QT_QUERY_INSTANCE qi
                     JOIN {S}.QT_QUERY_RESULT_INSTANCE ri ON ri.QUERY_INSTANCE_ID = qi.QUERY_INSTANCE_ID
                     WHERE qi.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
                       AND ri.RESULT_TYPE_ID = {crc.RESULT_TYPE_IDS['PATIENTSET']}
                     ORDER BY qi.QUERY_INSTANCE_ID DESC) ps
        WHERE qm.QUERY_MASTER_ID = ? AND qm.DELETE_FLAG = 'N'""", (query_master_id,))
    return rows[0] if rows else None


def delete_query(conn, query_master_id: int):
    """Deletes a query from the history the way i2b2 does: DELETE_FLAG 'Y' on the query master; rows are kept."""
    if get_request(conn, query_master_id):
        raise ValueError(f"QUERY_MASTER_ID {query_master_id} has a data request; remove the request first")
    cur = conn.cursor()
    cur.execute(f"UPDATE {S}.QT_QUERY_MASTER SET DELETE_FLAG = 'Y', DELETE_DATE = ? WHERE QUERY_MASTER_ID = ?",
                (_now(), query_master_id))
    conn.commit()


def get_breakdowns(conn, query_master_id: int) -> dict[str, dict[str, int]]:
    """Obfuscated breakdowns of a query's latest run, from its i2b2 XML results: {breakdown: {category: count}}."""
    rows = _rows(conn.cursor(), f"""
        SELECT rt.DESCRIPTION AS BREAKDOWN, d.n.value('@column', 'NVARCHAR(200)') AS CATEGORY,
               d.n.value('.', 'INT') AS PATIENTS
        FROM {S}.QT_QUERY_RESULT_INSTANCE ri
        JOIN {S}.QT_QUERY_RESULT_TYPE rt ON rt.RESULT_TYPE_ID = ri.RESULT_TYPE_ID
        JOIN {S}.QT_XML_RESULT x ON x.RESULT_INSTANCE_ID = ri.RESULT_INSTANCE_ID
        CROSS APPLY (SELECT CAST(x.XML_VALUE AS XML) AS doc) xd
        CROSS APPLY xd.doc.nodes('/*:i2b2_result_envelope/body/*:result/data') d(n)
        WHERE ri.QUERY_INSTANCE_ID = (SELECT MAX(QUERY_INSTANCE_ID) FROM {S}.QT_QUERY_INSTANCE
                                      WHERE QUERY_MASTER_ID = ?)
          AND rt.NAME <> 'PATIENT_COUNT_XML'
        ORDER BY rt.RESULT_TYPE_ID, x.XML_RESULT_ID""", (query_master_id,))
    out: dict[str, dict[str, int]] = {}
    for r in rows:
        out.setdefault(r["BREAKDOWN"], {})[r["CATEGORY"]] = r["PATIENTS"]
    return out


def create_request(conn, query_master_id: int, user: str, title: str | None) -> dict:
    cur = conn.cursor()
    q = get_query(conn, query_master_id)
    if not q:
        raise ValueError(f"No query with QUERY_MASTER_ID {query_master_id}")
    existing = _rows(cur, f"SELECT STATUS FROM {S}.COHORT_REQUEST WHERE QUERY_MASTER_ID = ?", (query_master_id,))
    if existing:
        raise ValueError(f"QUERY_MASTER_ID {query_master_id} already has a data request ({existing[0]['STATUS']})")
    now = _now()
    cur.execute(f"""INSERT INTO {S}.COHORT_REQUEST (QUERY_MASTER_ID, PATIENT_SET_RESULT_INSTANCE_ID, TITLE, STATUS,
                    REQUESTED_BY, REQUESTED_AT) VALUES (?, ?, ?, 'PENDING', ?, ?)""",
                (query_master_id, q["PATIENT_SET_RESULT_INSTANCE_ID"], title or q["NAME"], user, now))
    cur.execute(f"""INSERT INTO {S}.COHORT_REQUEST_EVENT (QUERY_MASTER_ID, EVENT, ACTOR, EVENT_AT, DETAIL)
                    VALUES (?, 'SUBMITTED', ?, ?, ?)""", (query_master_id, user, now, title or q["NAME"]))
    conn.commit()
    return get_request(conn, query_master_id)


def set_report(conn, query_master_id: int, report_id: str, url: str):
    cur = conn.cursor()
    cur.execute(f"UPDATE {S}.COHORT_REQUEST SET REPORT_ID = ?, REPORT_URL = ? WHERE QUERY_MASTER_ID = ?",
                (report_id, url, query_master_id))
    conn.commit()


def get_request(conn, query_master_id: int) -> dict | None:
    rows = _rows(conn.cursor(), f"SELECT * FROM {S}.V_REQUEST WHERE QUERY_MASTER_ID = ?", (query_master_id,))
    return rows[0] if rows else None


def delete_request(conn, query_master_id: int):
    """Removes a data request (used to clean up test runs); the query itself stays in the i2b2 history."""
    cur = conn.cursor()
    cur.execute(f"DELETE FROM {S}.COHORT_REQUEST_EVENT WHERE QUERY_MASTER_ID = ?", (query_master_id,))
    cur.execute(f"DELETE FROM {S}.COHORT_REQUEST WHERE QUERY_MASTER_ID = ?", (query_master_id,))
    conn.commit()
