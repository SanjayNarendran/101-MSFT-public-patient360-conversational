"""The i2b2 CRC query store: where every cohort query run, its counts and its data request are recorded.

The QT_* tables follow the i2b2 CRC schema (i2b2-data Release_1-8 crc_create_query_*.sql, SQL Server flavour):
QT_QUERY_MASTER (the query definition; QUERY_MASTER_ID is the ID a data request refers to), QT_QUERY_INSTANCE (a
run), QT_QUERY_RESULT_INSTANCE (one row per result: patient set, patient count, breakdowns; SET_SIZE is what the user
sees, REAL_SET_SIZE the true value), QT_PATIENT_SET_COLLECTION (the patient set, keyed by RESULT_INSTANCE_ID) and
QT_XML_RESULT (counts and breakdowns as i2b2 result XML). Breakdowns come from the ontology folders in
QT_BREAKDOWN_PATH, as in i2b2.

Obfuscation follows the CRC for users with the DATA_OBFSC role (GaussianBoxMuller): Gaussian noise with sigma 1.323 on
totals and 1.6 on breakdown cells, rounded; true counts of 3 or fewer, and results of 0 or less, are reported as 0.

Tables outside the i2b2 schema (prefixed COHORT_): the natural-language question behind a query, the data request
with its approval decision, and an audit trail. The dashboard reads the V_* views.
"""
from __future__ import annotations

import random
from xml.sax.saxutils import escape

SCHEMA = "crc"
PROJECT = "COHORT_DEMO"
SIGMA_TOTAL, SIGMA_BREAKDOWN, MINIMUM = 1.323, 1.6, 3   # HIVE_CELL_PARAMS defaults of the i2b2 CRC
OBFUSCATED_DISPLAY = 3                                    # web client shows "N ±3"

STATUS_TYPES = [(1, "QUEUED", "WAITING IN QUEUE TO START PROCESS"), (2, "PROCESSING", "PROCESSING"),
                (3, "FINISHED", "FINISHED"), (4, "ERROR", "ERROR"), (5, "INCOMPLETE", "INCOMPLETE"),
                (6, "COMPLETED", "COMPLETED"), (9, "CANCELLED", "CANCELLED"), (10, "TIMEDOUT", "TIMEDOUT")]
RESULT_TYPES = [(1, "PATIENTSET", "Patient set", "LIST", "LA"),
                (4, "PATIENT_COUNT_XML", "Number of patients", "CATNUM", "LA"),
                (5, "PATIENT_GENDER_COUNT_XML", "Gender patient breakdown", "CATNUM", "LA"),
                (6, "PATIENT_VITALSTATUS_COUNT_XML", "Vital Status patient breakdown", "CATNUM", "LA"),
                (7, "PATIENT_RACE_COUNT_XML", "Race patient breakdown", "CATNUM", "LA"),
                (8, "PATIENT_AGE_COUNT_XML", "Age patient breakdown", "CATNUM", "LA")]
RESULT_TYPE_IDS = {name: rid for rid, name, *_ in RESULT_TYPES}
RESULT_DESCRIPTIONS = {name: desc for _, name, desc, *_ in RESULT_TYPES}
BREAKDOWN_PATHS = {"PATIENT_GENDER_COUNT_XML": "\\i2b2\\Demographics\\Sex\\",
                   "PATIENT_AGE_COUNT_XML": "\\i2b2\\Demographics\\Age\\",
                   "PATIENT_RACE_COUNT_XML": "\\i2b2\\Demographics\\Race\\",
                   "PATIENT_VITALSTATUS_COUNT_XML": "\\i2b2\\Demographics\\Vital Status\\"}

DDL = f"""
IF SCHEMA_ID('{SCHEMA}') IS NULL EXEC('CREATE SCHEMA {SCHEMA}');

IF OBJECT_ID('{SCHEMA}.QT_QUERY_STATUS_TYPE') IS NULL
CREATE TABLE {SCHEMA}.QT_QUERY_STATUS_TYPE (
    STATUS_TYPE_ID INT NOT NULL PRIMARY KEY, NAME VARCHAR(100), DESCRIPTION VARCHAR(200));

IF OBJECT_ID('{SCHEMA}.QT_QUERY_RESULT_TYPE') IS NULL
CREATE TABLE {SCHEMA}.QT_QUERY_RESULT_TYPE (
    RESULT_TYPE_ID INT NOT NULL PRIMARY KEY, NAME VARCHAR(100), DESCRIPTION VARCHAR(200),
    DISPLAY_TYPE_ID VARCHAR(500), VISUAL_ATTRIBUTE_TYPE_ID VARCHAR(3), USER_ROLE_CD VARCHAR(255),
    CLASSNAME VARCHAR(200));

IF OBJECT_ID('{SCHEMA}.QT_BREAKDOWN_PATH') IS NULL
CREATE TABLE {SCHEMA}.QT_BREAKDOWN_PATH (
    NAME VARCHAR(100), VALUE VARCHAR(2000), CREATE_DATE DATETIME2(0), UPDATE_DATE DATETIME2(0), USER_ID VARCHAR(50));

IF OBJECT_ID('{SCHEMA}.QT_QUERY_MASTER') IS NULL
CREATE TABLE {SCHEMA}.QT_QUERY_MASTER (
    QUERY_MASTER_ID INT IDENTITY(1001, 1) NOT NULL PRIMARY KEY, NAME VARCHAR(250) NOT NULL,
    USER_ID VARCHAR(50) NOT NULL, GROUP_ID VARCHAR(50) NOT NULL, MASTER_TYPE_CD VARCHAR(2000), PLUGIN_ID INT,
    CREATE_DATE DATETIME2(0) NOT NULL, DELETE_DATE DATETIME2(0), DELETE_FLAG VARCHAR(3), REQUEST_XML VARCHAR(MAX),
    GENERATED_SQL VARCHAR(MAX), I2B2_REQUEST_XML VARCHAR(MAX), PM_XML VARCHAR(MAX));

IF OBJECT_ID('{SCHEMA}.QT_QUERY_INSTANCE') IS NULL
CREATE TABLE {SCHEMA}.QT_QUERY_INSTANCE (
    QUERY_INSTANCE_ID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY, QUERY_MASTER_ID INT, USER_ID VARCHAR(50) NOT NULL,
    GROUP_ID VARCHAR(50) NOT NULL, BATCH_MODE VARCHAR(50), START_DATE DATETIME2(3) NOT NULL, END_DATE DATETIME2(3),
    DELETE_FLAG VARCHAR(3), STATUS_TYPE_ID INT, MESSAGE VARCHAR(MAX));

IF OBJECT_ID('{SCHEMA}.QT_QUERY_RESULT_INSTANCE') IS NULL
CREATE TABLE {SCHEMA}.QT_QUERY_RESULT_INSTANCE (
    RESULT_INSTANCE_ID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY, QUERY_INSTANCE_ID INT, RESULT_TYPE_ID INT NOT NULL,
    SET_SIZE INT, START_DATE DATETIME2(3) NOT NULL, END_DATE DATETIME2(3), STATUS_TYPE_ID INT NOT NULL,
    DELETE_FLAG VARCHAR(3), MESSAGE VARCHAR(MAX), DESCRIPTION VARCHAR(200), REAL_SET_SIZE INT,
    OBFUSC_METHOD VARCHAR(500));

IF OBJECT_ID('{SCHEMA}.QT_PATIENT_SET_COLLECTION') IS NULL
CREATE TABLE {SCHEMA}.QT_PATIENT_SET_COLLECTION (
    PATIENT_SET_COLL_ID BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY, RESULT_INSTANCE_ID INT, SET_INDEX INT,
    PATIENT_NUM BIGINT);

IF OBJECT_ID('{SCHEMA}.QT_XML_RESULT') IS NULL
CREATE TABLE {SCHEMA}.QT_XML_RESULT (
    XML_RESULT_ID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY, RESULT_INSTANCE_ID INT, XML_VALUE VARCHAR(MAX));

IF OBJECT_ID('{SCHEMA}.COHORT_QUERY_CONTEXT') IS NULL
CREATE TABLE {SCHEMA}.COHORT_QUERY_CONTEXT (
    QUERY_MASTER_ID INT NOT NULL PRIMARY KEY, NL_QUESTION NVARCHAR(4000), QUERY_SUMMARY NVARCHAR(4000),
    QUERY_DEFINITION_JSON NVARCHAR(MAX), QUERY_LANGUAGE VARCHAR(50), SEMANTIC_MODEL_ID VARCHAR(50),
    CREATED_VIA VARCHAR(100));

IF OBJECT_ID('{SCHEMA}.COHORT_REQUEST') IS NULL
CREATE TABLE {SCHEMA}.COHORT_REQUEST (
    QUERY_MASTER_ID INT NOT NULL PRIMARY KEY, PATIENT_SET_RESULT_INSTANCE_ID INT NOT NULL, TITLE NVARCHAR(250),
    STATUS VARCHAR(20) NOT NULL, REQUESTED_BY VARCHAR(256) NOT NULL, REQUESTED_AT DATETIME2(0) NOT NULL,
    DECIDED_BY VARCHAR(256), DECIDED_AT DATETIME2(0), DECISION_COMMENT NVARCHAR(1000), REPORT_ID VARCHAR(50),
    REPORT_URL VARCHAR(500), DELIVERED_BY VARCHAR(256), DELIVERED_AT DATETIME2(0), DELIVERY_LAKEHOUSE VARCHAR(256),
    DELIVERED_PATIENTS INT);

IF OBJECT_ID('{SCHEMA}.COHORT_REQUEST_EVENT') IS NULL
CREATE TABLE {SCHEMA}.COHORT_REQUEST_EVENT (
    EVENT_ID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY, QUERY_MASTER_ID INT NOT NULL, EVENT VARCHAR(30) NOT NULL,
    ACTOR VARCHAR(256) NOT NULL, EVENT_AT DATETIME2(0) NOT NULL, DETAIL NVARCHAR(1000));
"""

VIEWS = [f"""
CREATE OR ALTER VIEW {SCHEMA}.V_REQUEST AS
SELECT r.QUERY_MASTER_ID, qm.NAME AS QUERY_NAME, COALESCE(r.TITLE, qm.NAME) AS TITLE, c.NL_QUESTION,
       c.QUERY_SUMMARY, qm.REQUEST_XML AS I2B2_QUERY_XML, qm.GENERATED_SQL AS GENERATED_QUERY, c.QUERY_LANGUAGE,
       qm.USER_ID AS QUERY_USER, qm.CREATE_DATE AS QUERY_CREATED_AT, r.PATIENT_SET_RESULT_INSTANCE_ID,
       cnt.SET_SIZE AS PATIENT_COUNT, cnt.OBFUSC_METHOD,
       CASE WHEN cnt.OBFUSC_METHOD IS NULL OR cnt.OBFUSC_METHOD = '' THEN CAST(cnt.SET_SIZE AS VARCHAR(20))
            WHEN cnt.SET_SIZE < {OBFUSCATED_DISPLAY + 1} THEN 'Fewer than {OBFUSCATED_DISPLAY + 1}'
            ELSE CAST(cnt.SET_SIZE AS VARCHAR(20)) + ' ±{OBFUSCATED_DISPLAY}' END AS PATIENT_COUNT_DISPLAY,
       r.STATUS, r.REQUESTED_BY, r.REQUESTED_AT, r.DECIDED_BY, r.DECIDED_AT, r.DECISION_COMMENT, r.REPORT_URL,
       r.DELIVERED_BY, r.DELIVERED_AT, r.DELIVERY_LAKEHOUSE, r.DELIVERED_PATIENTS
FROM {SCHEMA}.COHORT_REQUEST r
JOIN {SCHEMA}.QT_QUERY_MASTER qm ON qm.QUERY_MASTER_ID = r.QUERY_MASTER_ID
LEFT JOIN {SCHEMA}.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = r.QUERY_MASTER_ID
OUTER APPLY (
    SELECT TOP 1 ri.SET_SIZE, ri.OBFUSC_METHOD FROM {SCHEMA}.QT_QUERY_RESULT_INSTANCE ri
    WHERE ri.QUERY_INSTANCE_ID = (SELECT QUERY_INSTANCE_ID FROM {SCHEMA}.QT_QUERY_RESULT_INSTANCE
                                  WHERE RESULT_INSTANCE_ID = r.PATIENT_SET_RESULT_INSTANCE_ID)
      AND ri.RESULT_TYPE_ID = {RESULT_TYPE_IDS['PATIENT_COUNT_XML']}) cnt""", f"""
CREATE OR ALTER VIEW {SCHEMA}.V_REQUEST_BREAKDOWN AS
SELECT r.QUERY_MASTER_ID, rt.NAME AS RESULT_TYPE, rt.DESCRIPTION AS BREAKDOWN,
       d.n.value('@column', 'NVARCHAR(200)') AS CATEGORY, d.n.value('.', 'INT') AS PATIENTS,
       ROW_NUMBER() OVER (PARTITION BY r.QUERY_MASTER_ID ORDER BY rt.RESULT_TYPE_ID, x.XML_RESULT_ID) AS SORT_ORDER
FROM {SCHEMA}.COHORT_REQUEST r
JOIN {SCHEMA}.QT_QUERY_RESULT_INSTANCE ps ON ps.RESULT_INSTANCE_ID = r.PATIENT_SET_RESULT_INSTANCE_ID
JOIN {SCHEMA}.QT_QUERY_RESULT_INSTANCE ri ON ri.QUERY_INSTANCE_ID = ps.QUERY_INSTANCE_ID
JOIN {SCHEMA}.QT_QUERY_RESULT_TYPE rt ON rt.RESULT_TYPE_ID = ri.RESULT_TYPE_ID
JOIN {SCHEMA}.QT_XML_RESULT x ON x.RESULT_INSTANCE_ID = ri.RESULT_INSTANCE_ID
CROSS APPLY (SELECT CAST(x.XML_VALUE AS XML) AS doc) xd
CROSS APPLY xd.doc.nodes('/*:i2b2_result_envelope/body/*:result/data') d(n)
WHERE rt.NAME <> 'PATIENT_COUNT_XML'""", f"""
CREATE OR ALTER VIEW {SCHEMA}.V_REQUEST_EVENT AS
SELECT EVENT_ID, QUERY_MASTER_ID, EVENT, ACTOR, EVENT_AT, DETAIL FROM {SCHEMA}.COHORT_REQUEST_EVENT"""]


def seed_statements() -> list[tuple[str, tuple]]:
    out = [(f"DELETE FROM {SCHEMA}.QT_QUERY_STATUS_TYPE", ()), (f"DELETE FROM {SCHEMA}.QT_QUERY_RESULT_TYPE", ()),
           (f"DELETE FROM {SCHEMA}.QT_BREAKDOWN_PATH", ())]
    out += [(f"INSERT INTO {SCHEMA}.QT_QUERY_STATUS_TYPE VALUES (?, ?, ?)", row) for row in STATUS_TYPES]
    classes = {"PATIENTSET": "QueryResultPatientSetGenerator", "PATIENT_COUNT_XML": "QueryResultPatientCountGenerator"}
    out += [(f"INSERT INTO {SCHEMA}.QT_QUERY_RESULT_TYPE VALUES (?, ?, ?, ?, ?, ?, ?)",
             (rid, name, desc, display, visual, "DATA_OBFSC",
              "edu.harvard.i2b2.crc.dao.setfinder." + classes.get(name, "QueryResultGenerator")))
            for rid, name, desc, display, visual in RESULT_TYPES]
    out += [(f"INSERT INTO {SCHEMA}.QT_BREAKDOWN_PATH (NAME, VALUE, CREATE_DATE) VALUES (?, ?, SYSUTCDATETIME())",
             (name, "\\\\i2b2_demographics" + path)) for name, path in BREAKDOWN_PATHS.items()]
    return out


# --- Obfuscation and result XML -------------------------------------------------------------------------------------

_rng = random.SystemRandom()


def obfuscate(count: int, sigma: float) -> int:
    """i2b2 CRC GaussianBoxMuller.getNormalizedValueForCount(count, sigma, minimum)."""
    if count <= MINIMUM:
        return 0
    noisy = round(count + _rng.gauss(0.0, sigma))
    return noisy if noisy > 0 else 0


def display(set_size: int, obfuscated: bool = True) -> str:
    if not obfuscated:
        return str(set_size)
    return f"Fewer than {OBFUSCATED_DISPLAY + 1}" if set_size < OBFUSCATED_DISPLAY + 1 \
        else f"{set_size} ±{OBFUSCATED_DISPLAY}"


def result_xml(result_type: str, cells: list[tuple[str, int]]) -> str:
    """i2b2 result message (i2b2_result_msg.xsd), as stored in QT_XML_RESULT.XML_VALUE."""
    data = "".join(f'<data type="int" column="{escape(c, {chr(34): "&quot;"})}">{n}</data>' for c, n in cells)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<ns10:i2b2_result_envelope xmlns:ns10="http://www.i2b2.org/xsd/hive/msg/result/1.1/">'
            f'<body><ns10:result name="{result_type}">{data}</ns10:result></body></ns10:i2b2_result_envelope>')


def request_message(query_definition_xml: str, user: str, outputs: list[str]) -> str:
    """The CRC_QRY_runQueryInstance_fromQueryDefinition request body (stored in I2B2_REQUEST_XML)."""
    results = "".join(f'<result_output priority_index="{i}" name="{o.lower()}"/>' for i, o in enumerate(outputs, 1))
    return ('<ns4:psmheader><user group="' + PROJECT + '" login="' + escape(user) + '">' + escape(user) + '</user>'
            '<patient_set_limit>0</patient_set_limit><estimated_time>0</estimated_time>'
            '<query_mode>optimize_without_temp_table</query_mode>'
            '<request_type>CRC_QRY_runQueryInstance_fromQueryDefinition</request_type></ns4:psmheader>'
            '<ns4:request xsi:type="ns4:query_definition_requestType" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + query_definition_xml +
            f'<result_output_list>{results}</result_output_list></ns4:request>')
