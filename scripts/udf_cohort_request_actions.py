"""Cohort_Request_Actions: the Fabric user data function behind the request dashboard and the delivery notebook.

Deployed as function_app.py of a UserDataFunction item by 20_cohort_app.py. The CohortRequests connection is the
Cohort_Requests Fabric SQL database (i2b2 CRC store). Every action records who ran it, from the invocation context.

- decideRequest: Approve / Reject buttons on a request dashboard (status must be PENDING).
- getDeliveryPackage: what the delivery notebook needs for an approved request (the patient set and the query).
- deliveryProgress: one step of a running delivery, written by the delivery notebook.
- markDelivered: called by the delivery notebook when the delivery lakehouse is written.
"""
import json

import fabric.functions as fn

udf = fn.UserDataFunctions()
DECISIONS = ("APPROVED", "REJECTED")


def _who(ctx: fn.UserDataFunctionContext) -> str:
    user = getattr(ctx, "executing_user", None) or {}
    return user.get("PreferredUsername") or user.get("Oid") or "unknown user"


def _event(cur, query_master_id: int, event: str, who: str, detail: str):
    cur.execute("INSERT INTO crc.COHORT_REQUEST_EVENT (QUERY_MASTER_ID, EVENT, ACTOR, EVENT_AT, DETAIL) "
                "VALUES (?, ?, ?, SYSUTCDATETIME(), ?)", (query_master_id, event, who, detail))


def _status(cur, query_master_id: int):
    cur.execute("SELECT STATUS, DECIDED_BY, DECIDED_AT FROM crc.COHORT_REQUEST WHERE QUERY_MASTER_ID = ?",
                (query_master_id,))
    return cur.fetchone()


@udf.connection(argName="crcDb", alias="CohortRequests")
@udf.context(argName="ctx")
@udf.function()
def decideRequest(crcDb: fn.FabricSqlConnection, ctx: fn.UserDataFunctionContext, queryMasterId: int,
                  decision: str, comment: str = "") -> str:
    decision = (decision or "").strip().upper()
    if decision not in DECISIONS:
        raise fn.UserThrownError("The decision must be APPROVED or REJECTED.", {"decision": decision})
    who = _who(ctx)
    conn = crcDb.connect()
    cur = conn.cursor()
    cur.execute("UPDATE crc.COHORT_REQUEST SET STATUS = ?, DECIDED_BY = ?, DECIDED_AT = SYSUTCDATETIME(), "
                "DECISION_COMMENT = ? OUTPUT INSERTED.DECIDED_AT WHERE QUERY_MASTER_ID = ? AND STATUS = 'PENDING'",
                (decision, who, (comment or "").strip()[:1000] or None, queryMasterId))
    row = cur.fetchone()
    if row is None:
        current = _status(cur, queryMasterId)
        conn.rollback()
        if current is None:
            raise fn.UserThrownError(f"There is no data request {queryMasterId}.", {})
        raise fn.UserThrownError(f"Request {queryMasterId} is already {current[0].lower()} (by {current[1]}).", {})
    _event(cur, queryMasterId, decision, who, (comment or "").strip()[:1000])
    conn.commit()
    cur.close()
    conn.close()
    return f"Request {queryMasterId} {decision.lower()} by {who} at {row[0]:%Y-%m-%d %H:%M} UTC."


@udf.connection(argName="crcDb", alias="CohortRequests")
@udf.context(argName="ctx")
@udf.function()
def getDeliveryPackage(crcDb: fn.FabricSqlConnection, ctx: fn.UserDataFunctionContext, queryMasterId: int) -> str:
    conn = crcDb.connect()
    cur = conn.cursor()
    cur.execute("SELECT r.STATUS, r.TITLE, r.PATIENT_SET_RESULT_INSTANCE_ID, r.REQUESTED_BY, r.REQUESTED_AT, "
                "r.DECIDED_BY, r.DECIDED_AT, r.DECISION_COMMENT, qm.NAME, qm.REQUEST_XML, c.NL_QUESTION, "
                "c.QUERY_SUMMARY FROM crc.COHORT_REQUEST r "
                "JOIN crc.QT_QUERY_MASTER qm ON qm.QUERY_MASTER_ID = r.QUERY_MASTER_ID "
                "LEFT JOIN crc.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = r.QUERY_MASTER_ID "
                "WHERE r.QUERY_MASTER_ID = ?", (queryMasterId,))
    row = cur.fetchone()
    if row is None:
        raise fn.UserThrownError(f"There is no data request {queryMasterId}.", {})
    cols = [c[0] for c in cur.description]
    package = dict(zip(cols, row))
    if package["STATUS"] not in ("APPROVED", "DELIVERED"):
        raise fn.UserThrownError(f"Request {queryMasterId} is {package['STATUS'].lower()}; only approved requests "
                                 "can be delivered.", {})
    cur.execute("SELECT PATIENT_NUM FROM crc.QT_PATIENT_SET_COLLECTION WHERE RESULT_INSTANCE_ID = ? "
                "ORDER BY SET_INDEX", (package["PATIENT_SET_RESULT_INSTANCE_ID"],))
    package["PATIENT_NUMS"] = [int(r[0]) for r in cur.fetchall()]
    _event(cur, queryMasterId, "DELIVERY_STARTED", _who(ctx), f"{len(package['PATIENT_NUMS'])} patients")
    conn.commit()
    cur.close()
    conn.close()
    return json.dumps(package, default=str)


@udf.connection(argName="crcDb", alias="CohortRequests")
@udf.context(argName="ctx")
@udf.function()
def markDelivered(crcDb: fn.FabricSqlConnection, ctx: fn.UserDataFunctionContext, queryMasterId: int,
                  lakehouse: str, patients: int) -> str:
    who = _who(ctx)
    conn = crcDb.connect()
    cur = conn.cursor()
    cur.execute("UPDATE crc.COHORT_REQUEST SET STATUS = 'DELIVERED', DELIVERED_BY = ?, "
                "DELIVERED_AT = SYSUTCDATETIME(), DELIVERY_LAKEHOUSE = ?, DELIVERED_PATIENTS = ? "
                "WHERE QUERY_MASTER_ID = ? AND STATUS IN ('APPROVED', 'DELIVERED')",
                (who, lakehouse, patients, queryMasterId))
    if cur.rowcount != 1:
        conn.rollback()
        raise fn.UserThrownError(f"Request {queryMasterId} is not approved.", {})
    _event(cur, queryMasterId, "DELIVERED", who, f"{patients} patients to {lakehouse}")
    conn.commit()
    cur.close()
    conn.close()
    return f"Request {queryMasterId} delivered to {lakehouse} by {who}."


@udf.connection(argName="crcDb", alias="CohortRequests")
@udf.context(argName="ctx")
@udf.function()
def deliveryProgress(crcDb: fn.FabricSqlConnection, ctx: fn.UserDataFunctionContext, queryMasterId: int,
                     detail: str) -> str:
    """One step of a running delivery (written by the Cohort_Delivery notebook; the approval app shows it live)."""
    conn = crcDb.connect()
    cur = conn.cursor()
    if _status(cur, queryMasterId) is None:
        raise fn.UserThrownError(f"There is no data request {queryMasterId}.", {})
    _event(cur, queryMasterId, "DELIVERY_PROGRESS", _who(ctx), (detail or "")[:1000])
    conn.commit()
    cur.close()
    conn.close()
    return "ok"
