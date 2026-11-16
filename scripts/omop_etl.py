"""Bronze -> Silver OMOP CDM v5.4 ETL (DuckDB SQL).

The same code runs locally (14_silver_omop.py, reading the generated Bronze files) and in a Fabric Python notebook
(reading the Bronze lakehouses and the Bronze_PACS database through OneLake). Either way it reads only Bronze data:
- Clarity tables (patients, encounters, diagnoses, orders, results, medications, flowsheets)
- Bronze_PACS (studies, series, nodule findings) -> IMAGE_OCCURRENCE, IMAGE_FEATURE and nodule measurements
- Bronze_ClinicalDocuments (document index and text) -> NOTE

Mapping rules:
- Source codes map to standard concepts through 'Maps to' in the OMOP vocabularies; each record goes to the table of
  its standard concept's domain (a SNOMED "finding" diagnosis can land in OBSERVATION, for example).
- Diagnoses use the SNOMED CT code carried on the Epic diagnosis (CLARITY_EDG) for the concept and the ICD-10-CM code
  as the source value.
- Epic-internal imaging and pathology procedure codes use the curated LOCAL_PROCEDURES map (also written to
  SOURCE_TO_CONCEPT_MAP). Imaging and pathology orders always go to PROCEDURE_OCCURRENCE so IMAGE_OCCURRENCE and
  NOTE can link to them.
- Lab orders aren't procedures in OMOP; their results go to MEASUREMENT.
"""
from __future__ import annotations

import time
from datetime import date
from typing import Callable

import duckdb

from epic_schema import CLARITY
from omop_schema import CDM, EXTENSIONS, ddl

# --- Curated maps (Epic codes -> standard concepts) ---------------------------------------------------------------

GENDER = {1: 8532, 2: 8507}                       # ZC_SEX: Female, Male (Unknown -> 0)
RACE = {1: 8527, 2: 8516, 3: 8515, 4: 8657, 5: 8557}  # ZC_PATIENT_RACE (Other -> 0)
ETHNICITY = {1: 38003563, 2: 38003564}            # ZC_ETHNIC_GROUP
ENCOUNTER_VISIT = {101: 581477, 2101: 581477, 1003: 9202, 1214: 8782, 76: 5083}  # Office, Outpatient, Urgent, Tele
HOSPITAL_CLASS_VISIT = {1: 9201, 2: 9202, 3: 9203, 4: 581385}  # ADT patient class: IP, OP, ED, Observation
ADMITTED_FROM = {7: 8870, 4: 8717}                # ED, transfer from a hospital
DISCHARGED_TO = {1: 581476, 3: 8863, 6: 38004519, 9: 8717}  # Home, SNF, Home health, Admitted
PLACE_OF_SERVICE = {"Emergency Dept": 8870, "Urgent Care": 8782, "Intensive Care Unit": 8717,
                    "Medical Surgical Unit": 8717, "Behavioral Health Unit": 8717, "Labor And Delivery": 8717}
PROVIDER_SPECIALTY = {"General Practice": 38004446, "Diagnostic Radiology": 38004675, "Pathology": 38004466}
NOTE_TYPES = {  # document type -> (note_type_concept_id, note_class_concept_id: LOINC document ontology)
    "Radiology Report": (32841, 3009854), "Pathology Report": (32835, 3008122), "Progress Note": (32834, 3000735)}

# Epic-internal procedure codes (CLARITY_EAP.PROC_CODE) and a few SNOMED codes that need a procedure-domain concept
LOCAL_PROCEDURES = {
    "IMG0101": "168731009", "IMG0102": "446639004", "IMG0103": "713026007", "IMG0104": "399208008",
    "IMG0105": "168594001", "IMG0106": "446621008", "IMG0107": "40348008", "IMG0108": "713024005",
    "IMG0201": "395081000119108", "IMG0202": "16334891000119106", "IMG0301": "816077007", "IMG0401": "433236007",
    "IMG0402": "426701000119108",
    "PATH0101": "39228008", "PATH0102": "39228008", "PATH0103": "39228008", "PATH0104": "39228008",
    "24623002": "71651007",  # Screening mammography is a Measurement-domain concept; use Mammography (procedure)
}
BODY_SITES = {  # DICOM BodyPartExamined / pathology organ -> SNOMED body structure
    "CHEST": "51185008", "HEART": "302509004", "BREAST": "76752008", "HIP": "29836001", "PELVIS": "12921003",
    "HEAD": "69536005", "PROSTATE": "41216001", "HUMERUS": "85050009", "CLAVICLE": "51299004", "WRIST": "8205005",
    "ANKLE": "344001", "COLON": "71854001", "LUNG": "39607008", "KNEE": "72696002", "ABDOMEN": "818983003"}
LUNG_LOBES = {"right upper lobe": "361969002", "right middle lobe": "361973004", "right lower lobe": "361976007",
              "left upper lobe": "361984006", "left lower lobe": "361989001", "lingula": "184916009"}
NODULE_FINDING = "786838002"          # Nodule of lung
NODULE_MEASURES = [  # PACS NoduleFinding column -> (SNOMED code or None, source value, UCUM unit)
    ("DiameterMM", "246120007", "LIDC mean diameter", "mm"),
    ("MaxDiameterMM", None, "LIDC maximum diameter", "mm"),
    ("VolumeMM3", None, "LIDC volume", "mm3"),
    ("MalignancyScore", None, "LIDC malignancy rating (1-5)", "{score}"),
    ("SpiculationScore", None, "LIDC spiculation rating (1-5)", "{score}"),
]

TYPE_EHR, TYPE_LAB, TYPE_RX, TYPE_PROBLEM, TYPE_RAD = 32817, 32856, 32838, 32840, 32841
FIELD_PROCEDURE, FIELD_MEASUREMENT = 1147082, 1147138
TUMOR_TISSUE = 4122248
LIDC_SYSTEM = "LIDC-IDRI radiologist annotations (DICOM SR TID 1500, NCI Imaging Data Commons v25)"

CLARITY_TABLES = ["PATIENT", "PATIENT_RACE", "ZC_SEX", "ZC_ETHNIC_GROUP", "ZC_PATIENT_RACE", "ZC_DISP_ENC_TYPE",
                  "ZC_PAT_CLASS", "ZC_ADM_SOURCE", "ZC_DISCH_DISP", "CLARITY_DEP", "CLARITY_SER", "CLARITY_EDG",
                  "CLARITY_EAP", "CLARITY_COMPONENT", "CLARITY_MEDICATION", "IP_FLO_GP_DATA", "PAT_ENC", "PAT_ENC_HSP",
                  "PAT_ENC_DX", "PROBLEM_LIST", "ORDER_PROC", "ORDER_RAD_ACC_NUM", "ORDER_RESULTS", "ORDER_MED",
                  "IP_FLWSHT_REC", "IP_FLWSHT_MEAS"]
PACS_TABLES = ["ArchiveStore", "Study", "Series", "NoduleFinding"]
DUCK_TYPES = {"VARCHAR": "VARCHAR", "INT": "BIGINT", "DATE": "DATE", "TIMESTAMP": "TIMESTAMP"}


# --- Bronze sources ------------------------------------------------------------------------------------------------

class OneLakeBronze:
    """Reads the Bronze layer through OneLake: Clarity table shortcuts, the Bronze_PACS database's OneLake replica and
    the clinical documents lakehouse. `token` returns a storage-scoped bearer token."""

    def __init__(self, workspace_id: str, clarity_id: str, pacs_id: str, documents_id: str, token: Callable[[], str]):
        self.ws, self.clarity_id, self.pacs_id, self.documents_id, self.token = (
            workspace_id, clarity_id, pacs_id, documents_id, token)

    def _table(self, item: str, path: str):
        import pyarrow as pa
        from deltalake import DeltaTable, QueryBuilder
        uri = f"abfss://{self.ws}@onelake.dfs.fabric.microsoft.com/{item}/Tables/{path}"
        table = DeltaTable(uri, storage_options={"bearer_token": self.token(), "use_fabric_endpoint": "true"})
        # The DataFusion reader also handles deletion vectors, which some Delta tables declare. It
        # returns Utf8View strings, so register_bronze copies the data into DuckDB rather than using PyArrow on it.
        return pa.table(QueryBuilder().register("t", table).execute("SELECT * FROM t").read_all())

    def clarity(self, name: str):
        return self._table(self.clarity_id, name)

    def pacs(self, name: str):
        return self._table(self.pacs_id, f"pacs/{name}")

    def documents(self):
        return self._table(self.documents_id, "document_index")

    def document_texts(self, paths: list[str]) -> list[str | None]:
        import requests
        from concurrent.futures import ThreadPoolExecutor
        base = f"https://onelake.dfs.fabric.microsoft.com/{self.ws}/{self.documents_id}/"
        session, headers = requests.Session(), {"Authorization": f"Bearer {self.token()}"}

        def get(path):
            for _ in range(5):
                resp = session.get(base + path, headers=headers, timeout=60)
                if resp.status_code == 200:
                    return resp.content.decode("utf-8")
                time.sleep(2)
            raise RuntimeError(f"GET {path} -> {resp.status_code}")

        with ThreadPoolExecutor(32) as pool:
            return list(pool.map(get, paths))


def _copy_in(con: duckdb.DuckDBPyConnection, name: str, data) -> None:
    """Copies a DataFrame or Arrow table into a native DuckDB table (no later scans or pushdown into the source)."""
    con.register("bronze_source", data)
    con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM bronze_source")
    con.unregister("bronze_source")


def register_bronze(con: duckdb.DuckDBPyConnection, bronze) -> None:
    """Loads the Bronze inputs into DuckDB: typed views clarity_<TABLE>, tables pacs_<Table> and documents."""
    for name in CLARITY_TABLES:
        _copy_in(con, f"raw_{name}", bronze.clarity(name))
        cols = ", ".join(f'TRY_CAST("{c}" AS {DUCK_TYPES.get(t, "DOUBLE")}) AS "{c}"' for c, t in CLARITY[name])
        con.execute(f"CREATE OR REPLACE VIEW clarity_{name} AS SELECT {cols} FROM raw_{name}")
    for name in PACS_TABLES:
        _copy_in(con, f"pacs_{name}", bronze.pacs(name))
    _copy_in(con, "raw_documents", bronze.documents())
    docs = con.execute("SELECT * FROM raw_documents").df()
    texts = docs.OneLakePath.where(~docs.IsScanned.astype(str).str.lower().eq("true"))
    docs["note_text"] = None
    readable = texts.notna()
    docs.loc[readable, "note_text"] = bronze.document_texts(texts[readable].tolist())
    _copy_in(con, "documents", docs)


def register_vocab(con: duckdb.DuckDBPyConnection, sources: dict[str, object]) -> None:
    """sources: vocabulary table -> parquet path (str) or any relation DuckDB can scan (Arrow table/dataset)."""
    con.execute("CREATE SCHEMA IF NOT EXISTS vocab")
    for name, src in sources.items():
        if isinstance(src, str):
            con.execute(f"CREATE OR REPLACE VIEW vocab.{name} AS SELECT * FROM read_parquet('{src}')")
        else:
            con.register(f"vocab_src_{name}", src)
            con.execute(f"CREATE OR REPLACE VIEW vocab.{name} AS SELECT * FROM vocab_src_{name}")


# --- ETL -------------------------------------------------------------------------------------------------------------

def _case(column: str, mapping: dict, default="0") -> str:
    whens = " ".join(f"WHEN {k!r} THEN {v}" if isinstance(k, str) else f"WHEN {k} THEN {v}" for k, v in mapping.items())
    return f"CASE {column} {whens} ELSE {default} END"


def _curated(con) -> None:
    """Resolves the curated SNOMED codes to concept IDs and checks they're valid standard concepts."""
    rows = [("procedure", code, target) for code, target in LOCAL_PROCEDURES.items()]
    rows += [("site", k, v) for k, v in BODY_SITES.items()] + [("lobe", k, v) for k, v in LUNG_LOBES.items()]
    rows += [("finding", "nodule", NODULE_FINDING)] + [("nodule", c, s) for c, s, _, _ in NODULE_MEASURES if s]
    con.execute("CREATE OR REPLACE TABLE stg.curated (kind VARCHAR, source_code VARCHAR, snomed VARCHAR)")
    con.executemany("INSERT INTO stg.curated VALUES (?, ?, ?)", rows)
    con.execute("""
        CREATE OR REPLACE TABLE stg.curated_map AS
        SELECT k.kind, k.source_code, k.snomed, c.concept_id, c.domain_id, c.concept_name, c.standard_concept
        FROM stg.curated k LEFT JOIN vocab.concept c ON c.vocabulary_id = 'SNOMED' AND c.concept_code = k.snomed""")
    bad = con.execute("SELECT kind, source_code, snomed FROM stg.curated_map "
                      "WHERE concept_id IS NULL OR standard_concept IS DISTINCT FROM 'S'").fetchall()
    for kind, source, snomed in bad:
        print(f"  WARNING: curated {kind} {source} -> SNOMED {snomed} is not a standard concept; mapped to 0")


STEPS: list[tuple[str, str]] = []


def step(name: str):
    def wrap(fn):
        STEPS.append((name, fn))
        return fn
    return wrap


@step("code maps")
def _codes(con):
    con.execute("""
        CREATE OR REPLACE TABLE stg.edg AS
        SELECT DX_ID, DX_NAME, NULLIF(trim(SNOMED_CT_CODE), '') AS snomed,
               NULLIF(trim(split_part(CURRENT_ICD10_LIST, ',', 1)), '') AS icd10
        FROM clarity_CLARITY_EDG""")
    con.execute("""
        CREATE OR REPLACE TABLE stg.src_code AS
        SELECT DISTINCT vocabulary_id, code FROM (
            SELECT 'SNOMED' AS vocabulary_id, snomed AS code FROM stg.edg
            UNION ALL SELECT 'ICD10CM', icd10 FROM stg.edg
            UNION ALL SELECT 'SNOMED', PROC_CODE FROM clarity_CLARITY_EAP WHERE CODE_TYPE = 'SNOMED CT'
            UNION ALL SELECT 'LOINC', LOINC_CODE FROM clarity_CLARITY_COMPONENT
            UNION ALL SELECT 'LOINC', unnest(string_split(LOINC_CODE, '/')) FROM clarity_IP_FLO_GP_DATA
            UNION ALL SELECT 'RxNorm', RXNORM_CODE FROM clarity_CLARITY_MEDICATION)
        WHERE code IS NOT NULL AND code <> ''""")
    con.execute("""
        CREATE OR REPLACE TABLE stg.src_concept AS
        SELECT s.vocabulary_id, s.code, c.concept_id AS source_concept_id
        FROM stg.src_code s LEFT JOIN vocab.concept c ON c.vocabulary_id = s.vocabulary_id AND c.concept_code = s.code""")
    # One standard target per code (lowest concept_id when a code maps to several), plus any 'Maps to value'
    con.execute("""
        CREATE OR REPLACE TABLE stg.code_map AS
        WITH rel AS (
            SELECT r.concept_id_1, r.concept_id_2, r.relationship_id
            FROM vocab.concept_relationship r
            WHERE r.relationship_id IN ('Maps to', 'Maps to value') AND r.invalid_reason IS NULL
              AND r.concept_id_1 IN (SELECT source_concept_id FROM stg.src_concept)),
        tgt AS (
            SELECT rel.concept_id_1, min(t.concept_id) AS concept_id
            FROM rel JOIN vocab.concept t ON t.concept_id = rel.concept_id_2 AND t.standard_concept = 'S'
            WHERE rel.relationship_id = 'Maps to' GROUP BY 1),
        val AS (SELECT concept_id_1, min(concept_id_2) AS value_concept_id FROM rel
                WHERE relationship_id = 'Maps to value' GROUP BY 1)
        SELECT s.vocabulary_id, s.code, COALESCE(s.source_concept_id, 0) AS source_concept_id,
               COALESCE(tgt.concept_id, 0) AS concept_id, c.domain_id, val.value_concept_id
        FROM stg.src_concept s
        LEFT JOIN tgt ON tgt.concept_id_1 = s.source_concept_id
        LEFT JOIN vocab.concept c ON c.concept_id = tgt.concept_id
        LEFT JOIN val ON val.concept_id_1 = s.source_concept_id""")
    con.execute("""
        CREATE OR REPLACE TABLE stg.unit_map AS
        SELECT u.unit, min(c.concept_id) AS concept_id
        FROM (SELECT DISTINCT REFERENCE_UNIT AS unit FROM clarity_ORDER_RESULTS
              UNION SELECT DISTINCT UNITS FROM clarity_IP_FLO_GP_DATA UNION SELECT unnest(['mm', 'mm3', '{score}'])) u
        JOIN vocab.concept c ON c.vocabulary_id = 'UCUM' AND c.concept_code = u.unit AND c.standard_concept = 'S'
        GROUP BY 1""")
    # Text answers (flowsheet categories, non-numeric results) -> LOINC answer or SNOMED concepts, matched by name
    con.execute(r"""
        CREATE OR REPLACE TABLE stg.answer_map AS
        WITH txt AS (
            SELECT DISTINCT v AS txt, lower(trim(regexp_replace(v, '\s*\([^)]*\)\s*$', ''))) AS norm FROM (
                SELECT m.MEAS_VALUE AS v FROM clarity_IP_FLWSHT_MEAS m
                JOIN clarity_IP_FLO_GP_DATA g ON g.FLO_MEAS_ID = m.FLO_MEAS_ID WHERE g.VAL_TYPE = 'Category'
                UNION SELECT ORD_VALUE FROM clarity_ORDER_RESULTS WHERE ORD_NUM_VALUE IS NULL)
            WHERE v IS NOT NULL),
        hit AS (
            SELECT txt.txt, c.concept_id,
                   CASE WHEN c.domain_id = 'Meas Value' AND c.vocabulary_id = 'LOINC' THEN 1
                        WHEN c.domain_id = 'Meas Value' THEN 2 WHEN c.vocabulary_id = 'SNOMED' THEN 3 ELSE 4 END AS pref
            FROM txt JOIN vocab.concept c ON lower(c.concept_name) = txt.norm
            WHERE c.standard_concept = 'S' AND c.vocabulary_id IN ('LOINC', 'SNOMED'))
        SELECT txt, arg_min(concept_id, pref * 1e10 + concept_id) AS concept_id FROM hit GROUP BY txt""")
    _curated(con)
    con.execute("""
        CREATE OR REPLACE TABLE stg.local_proc AS
        SELECT e.PROC_ID, e.PROC_CODE, e.PROC_NAME, COALESCE(m.concept_id, 0) AS concept_id, m.domain_id
        FROM clarity_CLARITY_EAP e
        JOIN stg.curated_map m ON m.kind = 'procedure' AND m.source_code = e.PROC_CODE AND m.standard_concept = 'S'""")


@step("location, care_site, provider, person, death")
def _people(con):
    con.execute("""
        CREATE OR REPLACE TABLE stg.location AS
        SELECT row_number() OVER (ORDER BY src) AS location_id, * FROM (
            SELECT 'CAMPUS:' || REV_LOC_ID AS src, NULL AS address_1, any_value(CITY) AS city,
                   any_value(STATE) AS state, NULL AS zip, NULL AS county
            FROM clarity_CLARITY_DEP GROUP BY REV_LOC_ID
            UNION ALL
            SELECT 'PATIENT:' || PAT_ID, ADD_LINE_1, CITY, STATE, ZIP, COUNTY FROM clarity_PATIENT)""")
    con.execute("""
        INSERT INTO cdm.location BY NAME
        SELECT location_id, address_1, city, state, zip, county, src AS location_source_value,
               4330442 AS country_concept_id, 'US' AS country_source_value FROM stg.location""")
    con.execute(f"""
        INSERT INTO cdm.care_site BY NAME
        SELECT d.DEPARTMENT_ID AS care_site_id, d.DEPARTMENT_NAME AS care_site_name,
               {_case('d.SPECIALTY', PLACE_OF_SERVICE, '8756')} AS place_of_service_concept_id,
               l.location_id, CAST(d.DEPARTMENT_ID AS VARCHAR) AS care_site_source_value,
               d.SPECIALTY AS place_of_service_source_value
        FROM clarity_CLARITY_DEP d LEFT JOIN stg.location l ON l.src = 'CAMPUS:' || d.REV_LOC_ID""")
    con.execute(f"""
        INSERT INTO cdm.provider BY NAME
        SELECT TRY_CAST(PROV_ID AS BIGINT) AS provider_id, PROV_NAME AS provider_name, NPI AS npi,
               {_case('SPECIALTY', PROVIDER_SPECIALTY)} AS specialty_concept_id, PRIMARY_DEPT_ID AS care_site_id,
               {_case('SEX', {'Female': 8532, 'Male': 8507})} AS gender_concept_id, PROV_ID AS provider_source_value,
               SPECIALTY AS specialty_source_value, 0 AS specialty_source_concept_id, SEX AS gender_source_value,
               0 AS gender_source_concept_id
        FROM clarity_CLARITY_SER""")
    con.execute(f"""
        INSERT INTO cdm.person BY NAME
        WITH race AS (SELECT PAT_ID, arg_min(PATIENT_RACE_C, LINE) AS race_c FROM clarity_PATIENT_RACE GROUP BY 1)
        SELECT CAST(substr(p.PAT_ID, 2) AS BIGINT) AS person_id, {_case('p.SEX_C', GENDER)} AS gender_concept_id,
               year(p.BIRTH_DATE) AS year_of_birth, month(p.BIRTH_DATE) AS month_of_birth,
               day(p.BIRTH_DATE) AS day_of_birth, CAST(p.BIRTH_DATE AS TIMESTAMP) AS birth_datetime,
               {_case('r.race_c', RACE)} AS race_concept_id, {_case('p.ETHNIC_GROUP_C', ETHNICITY)} AS ethnicity_concept_id,
               l.location_id, TRY_CAST(p.CUR_PCP_PROV_ID AS BIGINT) AS provider_id, p.PAT_ID AS person_source_value,
               zs.NAME AS gender_source_value, 0 AS gender_source_concept_id, zr.NAME AS race_source_value,
               0 AS race_source_concept_id, ze.NAME AS ethnicity_source_value, 0 AS ethnicity_source_concept_id
        FROM clarity_PATIENT p
        LEFT JOIN race r ON r.PAT_ID = p.PAT_ID
        LEFT JOIN clarity_ZC_SEX zs ON zs.RCPT_MEM_SEX_C = p.SEX_C
        LEFT JOIN clarity_ZC_PATIENT_RACE zr ON zr.PATIENT_RACE_C = r.race_c
        LEFT JOIN clarity_ZC_ETHNIC_GROUP ze ON ze.ETHNIC_GROUP_C = p.ETHNIC_GROUP_C
        LEFT JOIN stg.location l ON l.src = 'PATIENT:' || p.PAT_ID""")
    con.execute(f"""
        INSERT INTO cdm.death BY NAME
        SELECT CAST(substr(PAT_ID, 2) AS BIGINT) AS person_id, DEATH_DATE AS death_date,
               CAST(DEATH_DATE AS TIMESTAMP) AS death_datetime, {TYPE_EHR} AS death_type_concept_id,
               0 AS cause_concept_id
        FROM clarity_PATIENT WHERE DEATH_DATE IS NOT NULL""")


@step("visit_occurrence")
def _visits(con):
    con.execute(f"""
        INSERT INTO cdm.visit_occurrence BY NAME
        WITH v AS (
            SELECT e.PAT_ENC_CSN_ID AS visit_occurrence_id, CAST(substr(e.PAT_ID, 2) AS BIGINT) AS person_id,
                   CASE WHEN e.ENC_TYPE_C = 3 THEN {_case('h.ADT_PAT_CLASS_C', HOSPITAL_CLASS_VISIT, '9202')}
                        ELSE {_case('e.ENC_TYPE_C', ENCOUNTER_VISIT)} END AS visit_concept_id,
                   COALESCE(h.HOSP_ADMSN_TIME, e.APPT_TIME, CAST(e.CONTACT_DATE AS TIMESTAMP)) AS start_dt,
                   COALESCE(h.HOSP_DISCH_TIME, e.ENC_CLOSE_TIME, h.HOSP_ADMSN_TIME, e.APPT_TIME,
                            CAST(e.CONTACT_DATE AS TIMESTAMP)) AS end_dt,
                   TRY_CAST(COALESCE(h.ADMISSION_PROV_ID, e.VISIT_PROV_ID) AS BIGINT) AS provider_id,
                   COALESCE(h.DEPARTMENT_ID, e.DEPARTMENT_ID) AS care_site_id,
                   zt.NAME || COALESCE(' - ' || zc.NAME, '') AS visit_source_value,
                   {_case('h.ADMIT_SOURCE_C', ADMITTED_FROM)} AS admitted_from_concept_id,
                   za.NAME AS admitted_from_source_value,
                   {_case('h.DISCH_DISP_C', DISCHARGED_TO)} AS discharged_to_concept_id,
                   zd.NAME AS discharged_to_source_value
            FROM clarity_PAT_ENC e
            LEFT JOIN clarity_PAT_ENC_HSP h ON h.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID
            LEFT JOIN clarity_ZC_DISP_ENC_TYPE zt ON zt.DISP_ENC_TYPE_C = e.ENC_TYPE_C
            LEFT JOIN clarity_ZC_PAT_CLASS zc ON zc.ADT_PAT_CLASS_C = h.ADT_PAT_CLASS_C
            LEFT JOIN clarity_ZC_ADM_SOURCE za ON za.ADMIT_SOURCE_C = h.ADMIT_SOURCE_C
            LEFT JOIN clarity_ZC_DISCH_DISP zd ON zd.DISCH_DISP_C = h.DISCH_DISP_C
            WHERE e.APPT_STATUS_C IS NULL OR e.APPT_STATUS_C NOT IN (3, 4))
        SELECT visit_occurrence_id, person_id, visit_concept_id, CAST(start_dt AS DATE) AS visit_start_date,
               start_dt AS visit_start_datetime, CAST(end_dt AS DATE) AS visit_end_date, end_dt AS visit_end_datetime,
               {TYPE_EHR} AS visit_type_concept_id, provider_id, care_site_id, visit_source_value,
               0 AS visit_source_concept_id, admitted_from_concept_id, admitted_from_source_value,
               discharged_to_concept_id, discharged_to_source_value,
               lag(visit_occurrence_id) OVER (PARTITION BY person_id ORDER BY start_dt, visit_occurrence_id)
                   AS preceding_visit_occurrence_id
        FROM v""")


@step("clinical events (domain routing)")
def _events(con):
    pid = "CAST(substr({}.PAT_ID, 2) AS BIGINT)"
    diagnosis = """
        CASE WHEN sm.concept_id > 0 THEN sm.concept_id ELSE COALESCE(im.concept_id, 0) END AS concept_id,
        CASE WHEN sm.concept_id > 0 THEN sm.domain_id ELSE im.domain_id END AS domain_id,
        CASE WHEN sm.concept_id > 0 THEN sm.value_concept_id ELSE im.value_concept_id END AS value_as_concept_id,
        COALESCE(edg.icd10, edg.snomed) AS source_value,
        COALESCE(NULLIF(im.source_concept_id, 0), sm.source_concept_id, 0) AS source_concept_id"""
    dx_joins = """
        JOIN stg.edg edg ON edg.DX_ID = x.DX_ID
        LEFT JOIN stg.code_map sm ON sm.vocabulary_id = 'SNOMED' AND sm.code = edg.snomed
        LEFT JOIN stg.code_map im ON im.vocabulary_id = 'ICD10CM' AND im.code = edg.icd10"""
    con.execute(f"""
        CREATE OR REPLACE TABLE stg.evt AS
        -- Encounter diagnoses
        SELECT 'PAT_ENC_DX' AS origin, x.PAT_ENC_CSN_ID * 100 + x.LINE AS origin_id, {pid.format('x')} AS person_id,
               x.PAT_ENC_CSN_ID AS visit_occurrence_id, TRY_CAST(e.VISIT_PROV_ID AS BIGINT) AS provider_id,
               x.CONTACT_DATE AS start_date, NULL::TIMESTAMP AS start_datetime, NULL::DATE AS end_date,
               {diagnosis}, 'condition' AS default_target, {TYPE_EHR} AS type_concept_id,
               CASE WHEN x.PRIMARY_DX_YN = 'Y' THEN 32902 ELSE 32908 END AS status_concept_id,
               CASE WHEN x.PRIMARY_DX_YN = 'Y' THEN 'Primary' ELSE 'Secondary' END AS status_source_value
        FROM clarity_PAT_ENC_DX x {dx_joins}
        LEFT JOIN clarity_PAT_ENC e ON e.PAT_ENC_CSN_ID = x.PAT_ENC_CSN_ID
        UNION ALL BY NAME
        -- Problem list
        SELECT 'PROBLEM_LIST' AS origin, x.PROBLEM_LIST_ID AS origin_id, {pid.format('x')} AS person_id,
               x.DIAG_ENC_CSN_ID AS visit_occurrence_id, NULL::BIGINT AS provider_id, x.NOTED_DATE AS start_date,
               x.RESOLVED_DATE AS end_date, {diagnosis}, 'condition' AS default_target,
               {TYPE_PROBLEM} AS type_concept_id,
               CASE WHEN x.RESOLVED_DATE IS NULL THEN 'Active' ELSE 'Resolved' END AS status_source_value
        FROM clarity_PROBLEM_LIST x {dx_joins}
        UNION ALL BY NAME
        -- Procedure, imaging and pathology orders (lab orders are represented by their results)
        SELECT 'ORDER_PROC' AS origin, o.ORDER_PROC_ID AS origin_id, {pid.format('o')} AS person_id,
               o.PAT_ENC_CSN_ID AS visit_occurrence_id, TRY_CAST(o.AUTHRZING_PROV_ID AS BIGINT) AS provider_id,
               CAST(COALESCE(o.PROC_START_TIME, o.ORDER_INST, o.ORDERING_DATE) AS DATE) AS start_date,
               COALESCE(o.PROC_START_TIME, o.ORDER_INST) AS start_datetime,
               COALESCE(lp.concept_id, cm.concept_id, 0) AS concept_id,
               CASE WHEN o.ORDER_TYPE_C IN (10, 26) THEN 'Procedure' ELSE COALESCE(lp.domain_id, cm.domain_id) END
                   AS domain_id,
               cm.value_concept_id AS value_as_concept_id, ea.PROC_CODE AS source_value,
               COALESCE(cm.source_concept_id, 0) AS source_concept_id, 'procedure' AS default_target,
               {TYPE_EHR} AS type_concept_id
        FROM clarity_ORDER_PROC o
        JOIN clarity_CLARITY_EAP ea ON ea.PROC_ID = o.PROC_ID
        LEFT JOIN stg.local_proc lp ON lp.PROC_ID = o.PROC_ID
        LEFT JOIN stg.code_map cm ON cm.vocabulary_id = 'SNOMED'
             AND cm.code = CASE WHEN ea.CODE_TYPE = 'SNOMED CT' THEN ea.PROC_CODE END
        WHERE o.ORDER_TYPE_C IN (1, 10, 26) AND o.ORDER_STATUS_C IS DISTINCT FROM 4
        UNION ALL BY NAME
        -- Lab results
        SELECT 'ORDER_RESULTS' AS origin, r.ORDER_PROC_ID * 1000 + r.LINE AS origin_id, {pid.format('r')} AS person_id,
               r.PAT_ENC_CSN_ID AS visit_occurrence_id, TRY_CAST(o.AUTHRZING_PROV_ID AS BIGINT) AS provider_id,
               CAST(r.RESULT_TIME AS DATE) AS start_date, r.RESULT_TIME AS start_datetime,
               COALESCE(cm.concept_id, 0) AS concept_id, cm.domain_id,
               COALESCE(CASE WHEN r.ORD_NUM_VALUE IS NULL THEN am.concept_id END, cm.value_concept_id)
                   AS value_as_concept_id,
               c.LOINC_CODE AS source_value, COALESCE(cm.source_concept_id, 0) AS source_concept_id,
               'measurement' AS default_target, {TYPE_LAB} AS type_concept_id, r.ORD_NUM_VALUE AS value_as_number,
               CASE WHEN r.ORD_NUM_VALUE IS NULL THEN r.ORD_VALUE END AS value_as_string,
               um.concept_id AS unit_concept_id, r.REFERENCE_UNIT AS unit_source_value,
               TRY_CAST(r.REFERENCE_LOW AS DOUBLE) AS range_low, TRY_CAST(r.REFERENCE_HIGH AS DOUBLE) AS range_high,
               r.ORD_VALUE AS value_source_value
        FROM clarity_ORDER_RESULTS r
        JOIN clarity_CLARITY_COMPONENT c ON c.COMPONENT_ID = r.COMPONENT_ID
        LEFT JOIN clarity_ORDER_PROC o ON o.ORDER_PROC_ID = r.ORDER_PROC_ID
        LEFT JOIN stg.code_map cm ON cm.vocabulary_id = 'LOINC' AND cm.code = c.LOINC_CODE
        LEFT JOIN stg.unit_map um ON um.unit = r.REFERENCE_UNIT
        LEFT JOIN stg.answer_map am ON am.txt = r.ORD_VALUE
        UNION ALL BY NAME
        -- Flowsheet rows (vitals, scores, social history); blood pressure splits into systolic and diastolic
        SELECT 'IP_FLWSHT_MEAS' AS origin, CAST(f.FSD_ID AS BIGINT) * 10000 + f.LINE * 10 + f.part AS origin_id,
               {pid.format('f')} AS person_id, f.PAT_ENC_CSN_ID AS visit_occurrence_id,
               TRY_CAST(f.VISIT_PROV_ID AS BIGINT) AS provider_id, CAST(f.RECORDED_TIME AS DATE) AS start_date,
               f.RECORDED_TIME AS start_datetime, COALESCE(cm.concept_id, 0) AS concept_id, cm.domain_id,
               CASE WHEN f.VAL_TYPE = 'Category' THEN COALESCE(am.concept_id, cm.value_concept_id) END
                   AS value_as_concept_id,
               f.loinc AS source_value, COALESCE(cm.source_concept_id, 0) AS source_concept_id,
               CASE WHEN f.VAL_TYPE = 'Category' THEN 'observation' ELSE 'measurement' END AS default_target,
               {TYPE_EHR} AS type_concept_id, TRY_CAST(f.val AS DOUBLE) AS value_as_number,
               CASE WHEN f.VAL_TYPE = 'Category' THEN f.val END AS value_as_string,
               um.concept_id AS unit_concept_id, f.UNITS AS unit_source_value, f.MEAS_VALUE AS value_source_value
        FROM (
            SELECT m.*, rec.PAT_ID, enc.PAT_ENC_CSN_ID, enc.VISIT_PROV_ID, g.VAL_TYPE, g.UNITS, p.part,
                   CASE WHEN g.VAL_TYPE = 'Blood Pressure' THEN string_split(g.LOINC_CODE, '/')[p.part]
                        ELSE g.LOINC_CODE END AS loinc,
                   CASE WHEN g.VAL_TYPE = 'Blood Pressure' THEN string_split(m.MEAS_VALUE, '/')[p.part]
                        ELSE m.MEAS_VALUE END AS val
            FROM clarity_IP_FLWSHT_MEAS m
            JOIN clarity_IP_FLWSHT_REC rec ON rec.FSD_ID = m.FSD_ID
            JOIN clarity_IP_FLO_GP_DATA g ON g.FLO_MEAS_ID = m.FLO_MEAS_ID
            LEFT JOIN clarity_PAT_ENC enc ON enc.INPATIENT_DATA_ID = rec.INPATIENT_DATA_ID
            JOIN (SELECT unnest([1, 2]) AS part) p ON p.part = 1 OR g.VAL_TYPE = 'Blood Pressure') f
        LEFT JOIN stg.code_map cm ON cm.vocabulary_id = 'LOINC' AND cm.code = f.loinc
        LEFT JOIN stg.unit_map um ON um.unit = f.UNITS
        LEFT JOIN stg.answer_map am ON am.txt = f.val
        UNION ALL BY NAME
        -- Medication orders
        SELECT 'ORDER_MED' AS origin, m.ORDER_MED_ID AS origin_id, {pid.format('m')} AS person_id,
               m.PAT_ENC_CSN_ID AS visit_occurrence_id, TRY_CAST(m.AUTHRZING_PROV_ID AS BIGINT) AS provider_id,
               COALESCE(m.START_DATE, m.ORDERING_DATE) AS start_date, m.ORDER_INST AS start_datetime,
               COALESCE(m.END_DATE, m.START_DATE, m.ORDERING_DATE) AS end_date, COALESCE(cm.concept_id, 0) AS concept_id,
               cm.domain_id, md.RXNORM_CODE AS source_value, COALESCE(cm.source_concept_id, 0) AS source_concept_id,
               'drug' AS default_target, {TYPE_RX} AS type_concept_id, m.REFILLS AS refills,
               m.END_DATE AS verbatim_end_date, md.FORM AS route_source_value,
               CASE WHEN m.ORDER_STATUS_C = 9 THEN 'Discontinued' END AS stop_reason
        FROM clarity_ORDER_MED m
        JOIN clarity_CLARITY_MEDICATION md ON md.MEDICATION_ID = m.MEDICATION_ID
        LEFT JOIN stg.code_map cm ON cm.vocabulary_id = 'RxNorm' AND cm.code = md.RXNORM_CODE
        WHERE m.ORDER_STATUS_C IS DISTINCT FROM 4""")
    con.execute("ALTER TABLE stg.evt ADD COLUMN target VARCHAR")
    con.execute("""
        UPDATE stg.evt SET target = COALESCE(CASE domain_id WHEN 'Condition' THEN 'condition'
            WHEN 'Procedure' THEN 'procedure' WHEN 'Measurement' THEN 'measurement' WHEN 'Observation' THEN 'observation'
            WHEN 'Drug' THEN 'drug' WHEN 'Device' THEN 'device' END, default_target)""")

    order = "ORDER BY person_id, start_date, origin, origin_id, concept_id"
    con.execute(f"""
        INSERT INTO cdm.condition_occurrence BY NAME
        SELECT row_number() OVER ({order}) AS condition_occurrence_id, person_id, concept_id AS condition_concept_id,
               start_date AS condition_start_date, start_datetime AS condition_start_datetime,
               end_date AS condition_end_date, type_concept_id AS condition_type_concept_id,
               COALESCE(status_concept_id, 0) AS condition_status_concept_id, stop_reason, provider_id,
               visit_occurrence_id, source_value AS condition_source_value,
               source_concept_id AS condition_source_concept_id, status_source_value AS condition_status_source_value
        FROM stg.evt WHERE target = 'condition'""")
    con.execute(f"""
        INSERT INTO cdm.procedure_occurrence BY NAME
        SELECT CASE WHEN origin = 'ORDER_PROC' THEN origin_id ELSE 900000000 + row_number() OVER ({order}) END
                   AS procedure_occurrence_id,
               person_id, concept_id AS procedure_concept_id, start_date AS procedure_date,
               start_datetime AS procedure_datetime, end_date AS procedure_end_date,
               type_concept_id AS procedure_type_concept_id, 0 AS modifier_concept_id, provider_id,
               visit_occurrence_id, source_value AS procedure_source_value,
               source_concept_id AS procedure_source_concept_id
        FROM stg.evt WHERE target = 'procedure'""")
    con.execute(f"""
        INSERT INTO cdm.drug_exposure BY NAME
        SELECT CASE WHEN origin = 'ORDER_MED' THEN origin_id ELSE 950000000 + row_number() OVER ({order}) END
                   AS drug_exposure_id,
               person_id, concept_id AS drug_concept_id, start_date AS drug_exposure_start_date,
               start_datetime AS drug_exposure_start_datetime, COALESCE(end_date, start_date) AS drug_exposure_end_date,
               verbatim_end_date, type_concept_id AS drug_type_concept_id, stop_reason, refills,
               0 AS route_concept_id, provider_id, visit_occurrence_id, source_value AS drug_source_value,
               source_concept_id AS drug_source_concept_id, route_source_value
        FROM stg.evt WHERE target = 'drug'""")
    con.execute(f"""
        INSERT INTO cdm.device_exposure BY NAME
        SELECT row_number() OVER ({order}) AS device_exposure_id, person_id, concept_id AS device_concept_id,
               start_date AS device_exposure_start_date, start_datetime AS device_exposure_start_datetime,
               end_date AS device_exposure_end_date, type_concept_id AS device_type_concept_id, provider_id,
               visit_occurrence_id, source_value AS device_source_value, source_concept_id AS device_source_concept_id
        FROM stg.evt WHERE target = 'device'""")
    con.execute(f"""
        INSERT INTO cdm.measurement BY NAME
        SELECT row_number() OVER ({order}) AS measurement_id, person_id, concept_id AS measurement_concept_id,
               start_date AS measurement_date, start_datetime AS measurement_datetime,
               type_concept_id AS measurement_type_concept_id, value_as_number, value_as_concept_id, unit_concept_id,
               range_low, range_high, provider_id, visit_occurrence_id, source_value AS measurement_source_value,
               source_concept_id AS measurement_source_concept_id, unit_source_value, value_source_value
        FROM stg.evt WHERE target = 'measurement'""")
    con.execute(f"""
        INSERT INTO cdm.observation BY NAME
        SELECT row_number() OVER ({order}) AS observation_id, person_id, concept_id AS observation_concept_id,
               start_date AS observation_date, start_datetime AS observation_datetime,
               type_concept_id AS observation_type_concept_id, value_as_number, value_as_string, value_as_concept_id,
               unit_concept_id, provider_id, visit_occurrence_id, source_value AS observation_source_value,
               source_concept_id AS observation_source_concept_id, unit_source_value, value_source_value
        FROM stg.evt WHERE target = 'observation'""")


@step("specimen, note, image_occurrence, image_feature")
def _imaging_and_notes(con):
    con.execute(f"""
        INSERT INTO cdm.specimen BY NAME
        SELECT o.ORDER_PROC_ID AS specimen_id, CAST(substr(o.PAT_ID, 2) AS BIGINT) AS person_id,
               {TUMOR_TISSUE} AS specimen_concept_id, {TYPE_EHR} AS specimen_type_concept_id,
               CAST(COALESCE(o.PROC_START_TIME, o.ORDER_INST) AS DATE) AS specimen_date,
               COALESCE(o.PROC_START_TIME, o.ORDER_INST) AS specimen_datetime,
               COALESCE(s.concept_id, 0) AS anatomic_site_concept_id, 0 AS disease_status_concept_id,
               a.ACC_NUM AS specimen_source_id, ea.PROC_NAME AS specimen_source_value,
               upper(trim(split_part(ea.PROC_NAME, ',', 2))) AS anatomic_site_source_value
        FROM clarity_ORDER_PROC o
        JOIN clarity_CLARITY_EAP ea ON ea.PROC_ID = o.PROC_ID
        LEFT JOIN clarity_ORDER_RAD_ACC_NUM a ON a.ORDER_PROC_ID = o.ORDER_PROC_ID AND a.LINE = 1
        LEFT JOIN stg.curated_map s ON s.kind = 'site' AND s.source_code = upper(trim(split_part(ea.PROC_NAME, ',', 2)))
        WHERE o.ORDER_TYPE_C = 26 AND o.ORDER_STATUS_C IS DISTINCT FROM 4""")

    note_types = " ".join(f"WHEN '{k}' THEN {t}" for k, (t, _) in NOTE_TYPES.items())
    note_classes = " ".join(f"WHEN '{k}' THEN {c}" for k, (_, c) in NOTE_TYPES.items())
    con.execute(f"""
        INSERT INTO cdm.note BY NAME
        WITH prov AS (SELECT upper(PROV_NAME) AS name, min(TRY_CAST(PROV_ID AS BIGINT)) AS provider_id
                      FROM clarity_CLARITY_SER GROUP BY 1)
        SELECT row_number() OVER (ORDER BY d.DocumentId) AS note_id,
               CAST(substr(d.PAT_ID, 2) AS BIGINT) AS person_id,
               CAST(CAST(d.DocumentDateTime AS TIMESTAMP) AS DATE) AS note_date,
               CAST(d.DocumentDateTime AS TIMESTAMP) AS note_datetime,
               CASE d.DocumentType {note_types} ELSE 32831 END AS note_type_concept_id,
               CASE d.DocumentType {note_classes} ELSE 0 END AS note_class_concept_id,
               d.Title AS note_title, d.note_text, 32678 AS encoding_concept_id, 4180186 AS language_concept_id,
               p.provider_id, TRY_CAST(d.PAT_ENC_CSN_ID AS BIGINT) AS visit_occurrence_id,
               d.DocumentId AS note_source_value, TRY_CAST(TRY_CAST(d.ORDER_PROC_ID AS DOUBLE) AS BIGINT) AS note_event_id,
               CASE WHEN d.ORDER_PROC_ID IS NOT NULL THEN {FIELD_PROCEDURE} END AS note_event_field_concept_id
        FROM documents d
        LEFT JOIN prov p ON p.name = upper(regexp_replace(d.AuthorName, ',\\s*[A-Z]+$', ''))""")

    con.execute("""
        CREATE OR REPLACE TABLE stg.study AS
        SELECT st.*, o.ORDER_PROC_ID, o.PAT_ENC_CSN_ID, CAST(substr(o.PAT_ID, 2) AS BIGINT) AS person_id
        FROM pacs_Study st
        JOIN clarity_ORDER_RAD_ACC_NUM acc ON acc.ACC_NUM = st.AccessionNumber
        JOIN clarity_ORDER_PROC o ON o.ORDER_PROC_ID = acc.ORDER_PROC_ID""")
    con.execute("""
        INSERT INTO cdm.image_occurrence BY NAME
        SELECT CAST(se.SeriesKey AS BIGINT) AS image_occurrence_id, st.person_id,
               st.ORDER_PROC_ID AS procedure_occurrence_id, st.PAT_ENC_CSN_ID AS visit_occurrence_id,
               COALESCE(site.concept_id, 0) AS anatomic_site_concept_id,
               CASE WHEN se.InstanceAvailability = 'ONLINE'
                    THEN a.BaseUrl || 'dicom/' || st.StudyInstanceUID || '/' || se.SeriesInstanceUID || '/' END
                   AS local_path,
               CAST(CAST(st.StudyDateTime AS TIMESTAMP) AS DATE) AS image_occurrence_date,
               st.StudyInstanceUID AS image_study_uid, se.SeriesInstanceUID AS image_series_uid,
               COALESCE(m.concept_id, 0) AS modality_concept_id, se.Modality AS modality_source_value
        FROM pacs_Series se
        JOIN stg.study st ON st.StudyKey = se.StudyKey
        JOIN pacs_ArchiveStore a ON a.ArchiveStoreKey = st.ArchiveStoreKey
        LEFT JOIN stg.curated_map site ON site.kind = 'site'
             AND site.source_code = upper(COALESCE(se.BodyPartExamined, st.BodyPartExamined))
        LEFT JOIN vocab.concept m ON m.vocabulary_id = 'DICOMCodes' AND m.concept_code = se.Modality
        WHERE se.Modality NOT IN ('SR', 'SEG')""")

    # Nodule findings: one measurement per LIDC attribute, each linked to its CT series through IMAGE_FEATURE
    measures = " UNION ALL ".join(
        f"SELECT '{col}' AS attr, {i} AS ord, '{src}' AS source_value, '{unit}' AS unit, "
        f"{'NULL' if not code else repr(col)} AS curated_key" for i, (col, code, src, unit) in enumerate(NODULE_MEASURES))
    values = " ".join(f"WHEN '{col}' THEN TRY_CAST(n.{col} AS DOUBLE)" for col, *_ in NODULE_MEASURES)
    con.execute(f"""
        CREATE OR REPLACE TABLE stg.nodule AS
        SELECT n.NoduleFindingKey, k.ord, k.source_value, k.unit, st.person_id, st.PAT_ENC_CSN_ID, st.ORDER_PROC_ID,
               CAST(st.StudyDateTime AS TIMESTAMP) AS study_dt,
               COALESCE(CAST(n.SeriesKey AS BIGINT), (SELECT min(io.image_occurrence_id) FROM cdm.image_occurrence io
                         WHERE io.image_study_uid = st.StudyInstanceUID AND io.modality_source_value = 'CT'))
                   AS image_occurrence_id,
               CASE k.attr {values} END AS value, COALESCE(c.concept_id, 0) AS concept_id,
               COALESCE(lobe.concept_id, 0) AS site_concept_id, lower(n.Lobe) AS lobe
        FROM pacs_NoduleFinding n
        JOIN stg.study st ON st.StudyKey = n.StudyKey
        CROSS JOIN ({measures}) k
        LEFT JOIN stg.curated_map c ON c.kind = 'nodule' AND c.source_code = k.curated_key
        LEFT JOIN stg.curated_map lobe ON lobe.kind = 'lobe' AND lobe.source_code = lower(n.Lobe)""")
    base = con.execute("SELECT COALESCE(max(measurement_id), 0) FROM cdm.measurement").fetchone()[0]
    con.execute(f"""
        CREATE OR REPLACE TABLE stg.nodule_measure AS
        SELECT *, {base} + row_number() OVER (ORDER BY NoduleFindingKey, ord) AS measurement_id FROM stg.nodule
        WHERE value IS NOT NULL""")
    con.execute(f"""
        INSERT INTO cdm.measurement BY NAME
        SELECT measurement_id, person_id, n.concept_id AS measurement_concept_id,
               CAST(study_dt AS DATE) AS measurement_date, study_dt AS measurement_datetime,
               {TYPE_RAD} AS measurement_type_concept_id, value AS value_as_number, u.concept_id AS unit_concept_id,
               PAT_ENC_CSN_ID AS visit_occurrence_id, source_value AS measurement_source_value,
               0 AS measurement_source_concept_id, n.unit AS unit_source_value, CAST(value AS VARCHAR) AS value_source_value,
               ORDER_PROC_ID AS measurement_event_id, {FIELD_PROCEDURE} AS meas_event_field_concept_id
        FROM stg.nodule_measure n LEFT JOIN stg.unit_map u ON u.unit = n.unit""")
    finding = "(SELECT concept_id FROM stg.curated_map WHERE kind = 'finding')"
    con.execute(f"""
        INSERT INTO cdm.image_feature BY NAME
        SELECT row_number() OVER (ORDER BY measurement_id) AS image_feature_id, person_id, image_occurrence_id,
               {FIELD_MEASUREMENT} AS image_feature_event_field_concept_id, measurement_id AS image_feature_event_id,
               concept_id AS image_feature_concept_id, {TYPE_RAD} AS image_feature_type_concept_id,
               COALESCE({finding}, 0) AS image_finding_concept_id, NoduleFindingKey AS image_finding_id,
               site_concept_id AS anatomic_site_concept_id, '{LIDC_SYSTEM}' AS alg_system
        FROM stg.nodule_measure WHERE image_occurrence_id IS NOT NULL""")


@step("observation_period, eras, metadata")
def _derived(con):
    con.execute(f"""
        INSERT INTO cdm.observation_period BY NAME
        SELECT row_number() OVER (ORDER BY person_id) AS observation_period_id, person_id,
               min(d) AS observation_period_start_date, max(d) AS observation_period_end_date,
               {TYPE_EHR} AS period_type_concept_id
        FROM (SELECT person_id, visit_start_date AS d FROM cdm.visit_occurrence
              UNION ALL SELECT person_id, visit_end_date FROM cdm.visit_occurrence
              UNION ALL SELECT person_id, start_date FROM stg.evt
              UNION ALL SELECT person_id, end_date FROM stg.evt WHERE end_date IS NOT NULL)
        WHERE d IS NOT NULL GROUP BY person_id""")
    # OHDSI era logic: events of the same concept closer than 30 days are merged into one era
    era = """,
        ends AS (
            SELECT person_id, concept_id, event_date - 30 AS end_date FROM (
                SELECT person_id, concept_id, event_date, event_type,
                       max(start_ordinal) OVER (PARTITION BY person_id, concept_id ORDER BY event_date, event_type
                                                ROWS UNBOUNDED PRECEDING) AS start_ordinal,
                       row_number() OVER (PARTITION BY person_id, concept_id ORDER BY event_date, event_type)
                           AS overall_ord
                FROM (SELECT person_id, concept_id, start_date AS event_date, -1 AS event_type,
                             row_number() OVER (PARTITION BY person_id, concept_id ORDER BY start_date)
                                 AS start_ordinal FROM target
                      UNION ALL
                      SELECT person_id, concept_id, end_date + 30, 1, NULL FROM target))
            WHERE 2 * start_ordinal - overall_ord = 0),
        spans AS (
            SELECT t.person_id, t.concept_id, t.start_date, t.end_date, min(e.end_date) AS era_end_date
            FROM target t JOIN ends e ON e.person_id = t.person_id AND e.concept_id = t.concept_id
                                     AND e.end_date >= t.start_date
            GROUP BY ALL)"""
    con.execute(f"""
        INSERT INTO cdm.condition_era BY NAME
        WITH target AS (
            SELECT person_id, condition_concept_id AS concept_id, condition_start_date AS start_date,
                   COALESCE(condition_end_date, condition_start_date + 1) AS end_date
            FROM cdm.condition_occurrence WHERE condition_concept_id <> 0) {era}
        SELECT row_number() OVER (ORDER BY person_id, concept_id, min(start_date)) AS condition_era_id, person_id,
               concept_id AS condition_concept_id, min(start_date) AS condition_era_start_date,
               era_end_date AS condition_era_end_date, count(*) AS condition_occurrence_count
        FROM spans GROUP BY person_id, concept_id, era_end_date""")
    con.execute(f"""
        INSERT INTO cdm.drug_era BY NAME
        WITH target AS (
            SELECT d.person_id, ing.concept_id, d.drug_exposure_start_date AS start_date,
                   GREATEST(COALESCE(d.drug_exposure_end_date, d.drug_exposure_start_date + 1),
                            d.drug_exposure_start_date) AS end_date
            FROM cdm.drug_exposure d
            JOIN vocab.concept_ancestor ca ON ca.descendant_concept_id = d.drug_concept_id
            JOIN vocab.concept ing ON ing.concept_id = ca.ancestor_concept_id AND ing.concept_class_id = 'Ingredient'
                 AND ing.vocabulary_id IN ('RxNorm', 'RxNorm Extension') AND ing.standard_concept = 'S'
            WHERE d.drug_concept_id <> 0) {era}
        SELECT row_number() OVER (ORDER BY person_id, concept_id, min(start_date)) AS drug_era_id, person_id,
               concept_id AS drug_concept_id, min(start_date) AS drug_era_start_date, era_end_date AS drug_era_end_date,
               count(*) AS drug_exposure_count,
               GREATEST(CAST(era_end_date - min(start_date) - sum(end_date - start_date) AS INTEGER), 0) AS gap_days
        FROM spans GROUP BY person_id, concept_id, era_end_date""")
    version = con.execute("SELECT vocabulary_version FROM vocab.vocabulary WHERE vocabulary_id = 'None'").fetchone()
    con.execute("""
        INSERT INTO cdm.cdm_source BY NAME
        SELECT 'Contoso Health medical cohort demo (synthetic)' AS cdm_source_name,
               'CONTOSO_COHORT_DEMO' AS cdm_source_abbreviation, 'Demo only - synthetic data' AS cdm_holder,
               'Synthetic Epic Clarity data (from Synthea Coherent), PACS index (Coherent MRI, LIDC-IDRI, TCGA via '
               || 'NCI IDC) and clinical documents, transformed from the Bronze layer of the MedicalCohortDemo '
               || 'Fabric workspace.' AS source_description,
               'https://github.com/SanjayNarendran/101-MSFT-public-patient360-conversational'
                   AS source_documentation_reference,
               'scripts/omop_etl.py' AS cdm_etl_reference, ? AS source_release_date, ? AS cdm_release_date,
               'v5.4' AS cdm_version, 756265 AS cdm_version_concept_id, ? AS vocabulary_version""",
                [date.today(), date.today(), version[0] if version else None])
    con.execute("""
        INSERT INTO cdm.source_to_concept_map BY NAME
        SELECT lp.PROC_CODE AS source_code, 0 AS source_concept_id, 'Epic EAP' AS source_vocabulary_id,
               lp.PROC_NAME AS source_code_description, lp.concept_id AS target_concept_id,
               'SNOMED' AS target_vocabulary_id, DATE '1970-01-01' AS valid_start_date,
               DATE '2099-12-31' AS valid_end_date
        FROM stg.local_proc lp""")


@step("vocabulary slice for semantic models")
def _concept_slice(con):
    """Concepts referenced by any CDM table, plus all their ancestors, and the ancestor rows between them."""
    refs = []
    for name, cols in CDM.items():
        refs += [f"SELECT {c} AS concept_id FROM cdm.{name}" for c, t in cols
                 if t == "INTEGER" and c.endswith("concept_id") and name not in ("cdm_source", "metadata")]
    con.execute(f"CREATE OR REPLACE TABLE stg.used AS SELECT DISTINCT concept_id FROM ({' UNION ALL '.join(refs)}) "
                "WHERE concept_id IS NOT NULL AND concept_id <> 0")
    con.execute("""
        INSERT INTO cdm.concept_ancestor_in_use BY NAME
        SELECT ca.* FROM vocab.concept_ancestor ca WHERE ca.descendant_concept_id IN (SELECT concept_id FROM stg.used)""")
    con.execute("""
        INSERT INTO cdm.concept_in_use BY NAME
        SELECT c.* FROM vocab.concept c WHERE c.concept_id IN (
            SELECT concept_id FROM stg.used UNION SELECT ancestor_concept_id FROM cdm.concept_ancestor_in_use)""")


def build_silver(con: duckdb.DuckDBPyConnection, log=print) -> None:
    """Builds every OMOP table in the DuckDB schema `cdm` from the registered Bronze views and vocabularies."""
    con.execute("SET TimeZone = 'UTC'")
    con.execute("CREATE SCHEMA IF NOT EXISTS cdm")
    con.execute("CREATE SCHEMA IF NOT EXISTS stg")
    for name, cols in {**CDM, **EXTENSIONS}.items():
        con.execute(ddl("cdm", name, cols))
    for name, fn in STEPS:
        start = time.time()
        fn(con)
        log(f"  {name:<45} {time.time() - start:6.1f}s")


def coverage(con) -> list[tuple]:
    """Share of records with a standard concept, per clinical table."""
    checks = [("condition_occurrence", "condition_concept_id"), ("procedure_occurrence", "procedure_concept_id"),
              ("drug_exposure", "drug_concept_id"), ("measurement", "measurement_concept_id"),
              ("observation", "observation_concept_id"), ("visit_occurrence", "visit_concept_id"),
              ("image_occurrence", "modality_concept_id"), ("note", "note_class_concept_id")]
    out = []
    for table, col in checks:
        n, mapped = con.execute(f"SELECT count(*), count(*) FILTER (WHERE {col} <> 0) FROM cdm.{table}").fetchone()
        out.append((table, n, mapped))
    return out


def write_delta(con: duckdb.DuckDBPyConnection, query: str, uri: str, storage_options: dict) -> int:
    """Streams a DuckDB query into a Delta table (overwrite), e.g. a OneLake lakehouse table. Returns the row count."""
    from deltalake import write_deltalake
    reader = con.execute(query).fetch_record_batch(rows_per_batch=1_000_000)
    write_deltalake(uri, reader, mode="overwrite", schema_mode="overwrite", storage_options=storage_options)
    return con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0]
