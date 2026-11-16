"""Patient 360: the local copy of the Bronze tables, the patient index and the demo patients.

Patient 360 (apps/patient360) reads the Bronze sources: the Epic Clarity tables (Bronze_Clarity),
the Bronze_PACS database and the Bronze_ClinicalDocuments index. Its local mode reads the same rows from
data/generated/p360/, written here:

  bronze/clarity/<TABLE>.parquet         the Clarity tables, as loaded into Bronze_Clarity (data/generated/clarity)
  bronze/pacs/<Table>.parquet            the Bronze_PACS tables (pacs_index.named_tables, Instance included)
  bronze/documents/<table>.parquet       document_index and document_facts, as in Bronze_ClinicalDocuments
  p360_patient.parquet                   one row per patient: keys, demographics, counts, what is online, demo order,
                                         and the list's cancer, stage, outcome, key alterations, TMB, gigapixels, scans
  p360_demo.parquet                      the demo patients and why each is in the demo (apps/patient360/demo_patients.json)
  p360_genome.parquet                    each Epic patient's tumour genomes: the TCGA cases behind their slides that the
                                         genomics silo holds (scripts/29_patient360_genomics.py)
  bronze/requests/<TABLE>.parquet        the data requests and their patient sets (Cohort_Requests, for the Cohorts tab;
                                         copied when the capacity runs, otherwise the last copy stays)
  bronze/omop/i2b2_patient_mapping.parquet  the i2b2 patient numbers to Epic PAT_ID and OMOP person_id

Every step can be run again; it rewrites the files. `--index-only` skips the Bronze copy. `--fabric` also writes
p360_patient, p360_demo and p360_genome to the Patient360 lakehouse (created if missing; stage C1 of
docs/patient-360.md). The app reads every other table where it lives, through three-part names on the SQL analytics
endpoint, apart from the time columns that endpoint can leave out (timestamp_ntz, as the documents index is written):
`--fabric` writes them to Patient360 as p360_time_<table>, keyed like their table, so rerun it after the Epic data or
the documents change. It also measures every source item in OneLake (each table's size, the Files area's files and
bytes) into p360_inventory, for the app's Where the data lives page; rerun it after files change.

Run:  .venv/bin/python scripts/24_patient360_data.py [--fabric]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import duckdb
import pandas as pd
import requests

from common import (GEN_DIR, ONELAKE_DFS, ROOT, ensure_lakehouse, ensure_openssl, fabric_list, onelake_usage, storage_token,
                    write_tables)

P360 = GEN_DIR / "p360"
BRONZE = P360 / "bronze"
DEMO_FILE = ROOT / "apps" / "patient360" / "demo_patients.json"

# The Clarity tables the record reads (all of them are small enough to copy whole)
CLARITY = ["PATIENT", "PATIENT_RACE", "PAT_ENC", "PAT_ENC_HSP", "PAT_ENC_DX", "PROBLEM_LIST", "ORDER_PROC",
           "ORDER_DX_PROC", "ORDER_RAD_ACC_NUM", "ORDER_RESULTS", "ORDER_MED", "ORDER_DX_MED", "IP_FLWSHT_REC",
           "IP_FLWSHT_MEAS", "CLARITY_DEP", "CLARITY_SER", "CLARITY_EDG", "CLARITY_EAP", "CLARITY_COMPONENT",
           "CLARITY_MEDICATION", "IP_FLO_GP_DATA", "ZC_SEX", "ZC_ETHNIC_GROUP", "ZC_PATIENT_RACE",
           "ZC_MARITAL_STATUS", "ZC_PATIENT_STATUS", "ZC_DISP_ENC_TYPE", "ZC_APPT_STATUS", "ZC_PAT_CLASS",
           "ZC_ADM_SOURCE", "ZC_DISCH_DISP", "ZC_ORDER_TYPE", "ZC_ORDER_STATUS", "ZC_RESULT_FLAG",
           "ZC_RESULT_STATUS", "ZC_PROBLEM_STATUS", "ZC_PROV_TYPE"]

# Time columns the lakehouse SQL endpoints leave out (timestamp_ntz), by table: (silo, key, times). Same list as
# HIDDEN_TIMES in apps/patient360/rayfin/functions/src/record.ts.
HIDDEN_TIMES = {
    "PAT_ENC": ("clarity", ["PAT_ENC_CSN_ID"], ["APPT_TIME", "ENC_CLOSE_TIME"]),
    "PAT_ENC_HSP": ("clarity", ["PAT_ENC_CSN_ID"], ["HOSP_ADMSN_TIME", "HOSP_DISCH_TIME"]),
    "ORDER_RESULTS": ("clarity", ["ORDER_PROC_ID", "LINE"], ["RESULT_TIME"]),
    "IP_FLWSHT_MEAS": ("clarity", ["FSD_ID", "LINE", "FLO_MEAS_ID"], ["RECORDED_TIME"]),
    "ORDER_PROC": ("clarity", ["ORDER_PROC_ID"], ["ORDER_INST", "PROC_START_TIME"]),
    "document_index": ("documents", ["DocumentId"], ["ServiceDateTime", "DocumentDateTime"]),
}


def time_tables() -> dict[str, pd.DataFrame]:
    """The hidden time columns with their keys, from the Bronze copy; written as UTC timestamps, which the endpoint
    shows (the clock times are kept as they are)."""
    frames = {}
    for table, (silo, key, times) in HIDDEN_TIMES.items():
        df = pd.read_parquet(BRONZE / silo / f"{table}.parquet", columns=key + times).dropna(subset=times, how="all")
        for col in times:
            df[col] = pd.to_datetime(df[col]).dt.tz_localize("UTC")
        frames[f"p360_time_{table.lower()}"] = df
    return frames

# The items the app reads (record.ts DEFAULT_NAMES); each one's tables and Files area are measured for p360_inventory.
SOURCE_ITEMS = ["Bronze_Clarity", "Bronze_PACS", "Bronze_ImagingArchive", "Bronze_ClinicalDocuments", "Patient360",
                "Bronze_Oncology_Clinical", "Bronze_Oncology_Genomics", "Bronze_Oncology_Imaging"]


def inventory(ws_id: str) -> pd.DataFrame:
    """Each source item's tables (bytes in OneLake) and Files area (files and bytes), listed now."""
    def names(path: str) -> list[str]:
        r = requests.get(f"{ONELAKE_DFS}/{ws_id}", params={"resource": "filesystem", "recursive": "false", "directory": path},
                         headers={"Authorization": f"Bearer {storage_token()}", "x-ms-version": "2023-11-03"}, timeout=120)
        return [x["name"].split("/")[-1] for x in r.json().get("paths", [])] if r.ok else []

    items = {i["displayName"]: (i["id"], kind) for kind in ("Lakehouse", "SQLDatabase")
             for i in fabric_list(f"/workspaces/{ws_id}/items?type={kind}") if i["displayName"] in SOURCE_ITEMS}
    jobs = []
    for name, (item_id, kind) in items.items():
        top = names(f"{item_id}/Tables")
        schema = next((s for s in ("dbo", "pacs") if s in top), None)
        under = f"Tables/{schema}" if schema else "Tables"
        jobs += [(name, "table", t, f"{item_id}/{under}/{t}") for t in (names(f"{item_id}/{under}") if schema else top)]
        if kind == "Lakehouse":
            jobs.append((name, "files", "Files", f"{item_id}/Files"))
    with ThreadPoolExecutor(16) as pool:
        usage = list(pool.map(lambda j: onelake_usage(ws_id, j[3]), jobs))
    rows = [{"item": j[0], "kind": j[1], "name": j[2], "files": u[0], "bytes": u[1]} for j, u in zip(jobs, usage)]
    df = pd.DataFrame(rows).astype({"files": "int64", "bytes": "int64"})
    df["measured_at"] = pd.Timestamp.now(tz="UTC").floor("s")
    return df


def copy_requests() -> None:
    """Local copies of what the Cohorts tab reads: the data requests, their patient sets and the patient mapping.
    In Fabric the app reads them where they live (Cohort_Requests and Silver_OMOP)."""
    out = BRONZE / "requests"
    try:
        import cohort_store
        conn = cohort_store.connect(attempts=1)
        frames = {
            "COHORT_REQUEST": "SELECT QUERY_MASTER_ID, PATIENT_SET_RESULT_INSTANCE_ID, TITLE, STATUS, REQUESTED_BY, REQUESTED_AT, "
                              "DECIDED_BY, DECIDED_AT, DELIVERED_AT, DELIVERY_LAKEHOUSE, DELIVERED_PATIENTS FROM crc.COHORT_REQUEST",
            "QT_PATIENT_SET_COLLECTION": "SELECT s.RESULT_INSTANCE_ID, s.SET_INDEX, s.PATIENT_NUM FROM crc.QT_PATIENT_SET_COLLECTION s "
                                         "JOIN crc.COHORT_REQUEST r ON r.PATIENT_SET_RESULT_INSTANCE_ID = s.RESULT_INSTANCE_ID",
            "COHORT_QUERY_CONTEXT": "SELECT QUERY_MASTER_ID, NL_QUESTION, QUERY_SUMMARY FROM crc.COHORT_QUERY_CONTEXT",
        }
        out.mkdir(parents=True, exist_ok=True)
        cur = conn.cursor()
        for name, sql in frames.items():
            cur.execute(sql)
            cols = [c[0] for c in cur.description]
            pd.DataFrame([tuple(r) for r in cur.fetchall()], columns=cols).to_parquet(out / f"{name}.parquet", index=False)
        conn.close()
        n = len(pd.read_parquet(out / "COHORT_REQUEST.parquet"))
        print(f"  data requests: {n} copied from Cohort_Requests")
    except Exception as e:  # noqa: BLE001  (the capacity is paused, or Stage 4 isn't set up)
        kept = "keeping the last copy" if (out / "COHORT_REQUEST.parquet").exists() else "the Cohorts tab stays empty"
        print(f"  data requests: Cohort_Requests not reachable ({type(e).__name__}); {kept}")
    mapping = GEN_DIR / "omop" / "mapping" / "patient_mapping.parquet"
    if mapping.exists():
        (BRONZE / "omop").mkdir(parents=True, exist_ok=True)
        pd.read_parquet(mapping, columns=["patient_num", "patient_ide", "patient_ide_source"]).to_parquet(
            BRONZE / "omop" / "i2b2_patient_mapping.parquet", index=False)


def tidy(df: pd.DataFrame) -> pd.DataFrame:
    """Object columns that mix numbers and strings (the PACS plan) become numbers when they all parse, else text."""
    df = df.copy()
    for col in df.columns[df.dtypes == object]:
        values = df[col].dropna()
        if values.map(lambda v: isinstance(v, str)).all():
            continue
        nums = pd.to_numeric(values, errors="coerce")
        if len(values) and nums.notna().all():
            df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            df[col] = df[col].map(lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))
    return df


def copy_bronze(con: duckdb.DuckDBPyConnection):
    """Clarity CSVs, the PACS index and the document index as Parquet, with the same columns as in Fabric."""
    from epic_schema import CLARITY as SCHEMA  # noqa: PLC0415

    out = BRONZE / "clarity"
    out.mkdir(parents=True, exist_ok=True)
    for table in CLARITY:
        cols = SCHEMA[table]
        types = {"VARCHAR": "VARCHAR", "INT": "INTEGER", "DATE": "DATE", "TIMESTAMP": "TIMESTAMP"}
        spec = ", ".join(f"'{n}': '{types.get(t, 'DOUBLE')}'" for n, t in cols)
        src = GEN_DIR / "clarity" / f"{table}.csv.gz"
        con.execute(f"COPY (SELECT * FROM read_csv('{src}', header=true, columns={{{spec}}})) "
                    f"TO '{out / f'{table}.parquet'}' (FORMAT parquet, COMPRESSION zstd)")
    print(f"  Clarity: {len(CLARITY)} tables")

    import pacs_index  # noqa: PLC0415  (needs data/state.json for the archive's OneLake address)
    out = BRONZE / "pacs"
    out.mkdir(parents=True, exist_ok=True)
    tables = pacs_index.named_tables(skip=())
    for name, df in tables.items():
        tidy(df).to_parquet(out / f"{name}.parquet", index=False)
    print("  PACS: " + ", ".join(f"{n} {len(d):,}" for n, d in tables.items()))

    out = BRONZE / "documents"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("document_index", "document_facts"):
        df = pd.read_csv(GEN_DIR / "documents" / f"{name}.csv", dtype=str, keep_default_na=False)
        df = df.replace({"": None})
        # The same types as the Delta tables written by 11_generate_documents.py
        if name == "document_index":
            df["IsScanned"] = df.IsScanned == "True"
            for col in ("ServiceDateTime", "DocumentDateTime"):
                df[col] = pd.to_datetime(df[col])
            for col in ("SizeBytes", "Words", "PAT_ENC_CSN_ID", "ORDER_PROC_ID"):
                df[col] = pd.to_numeric(df[col]).astype("Int64")
        else:
            df["FactNumber"] = pd.to_numeric(df.FactNumber).astype("Int64")
        df.to_parquet(out / f"{name}.parquet", index=False)
        print(f"  documents: {name} {len(df):,}")


def views(con: duckdb.DuckDBPyConnection):
    for folder in ("clarity", "pacs", "documents"):
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {folder}")
        for f in sorted((BRONZE / folder).glob("*.parquet")):
            con.execute(f"CREATE OR REPLACE VIEW {folder}.{f.stem} AS SELECT * FROM '{f}'")


INDEX_SQL = """
WITH
race AS (SELECT r.PAT_ID, z.NAME AS race FROM clarity.PATIENT_RACE r JOIN clarity.ZC_PATIENT_RACE z USING (PATIENT_RACE_C)
         WHERE r.LINE = 1),
visits AS (SELECT PAT_ID, COUNT(*) AS visits, MIN(CONTACT_DATE) AS first_visit, MAX(CONTACT_DATE) AS last_visit
           FROM clarity.PAT_ENC GROUP BY 1),
stays AS (SELECT PAT_ID, COUNT(*) AS inpatient_stays FROM clarity.PAT_ENC_HSP GROUP BY 1),
labs AS (SELECT PAT_ID, COUNT(*) AS lab_results FROM clarity.ORDER_RESULTS GROUP BY 1),
vitals AS (SELECT r.PAT_ID, COUNT(*) AS vital_signs FROM clarity.IP_FLWSHT_MEAS m JOIN clarity.IP_FLWSHT_REC r USING (FSD_ID)
           GROUP BY 1),
meds AS (SELECT PAT_ID, COUNT(*) AS medication_orders FROM clarity.ORDER_MED GROUP BY 1),
problems AS (
  SELECT p.PAT_ID, e.DX_NAME, e.CURRENT_ICD10_LIST AS icd10, p.NOTED_DATE, p.RESOLVED_DATE
  FROM clarity.PROBLEM_LIST p JOIN clarity.CLARITY_EDG e USING (DX_ID)),
long_term AS (
  SELECT PAT_ID, COUNT(*) AS conditions,
         string_agg(DX_NAME, '; ' ORDER BY NOTED_DATE) FILTER (WHERE RESOLVED_DATE IS NULL) AS active_conditions
  FROM problems GROUP BY 1),
cancer AS (
  SELECT PAT_ID, string_agg(DISTINCT DX_NAME, '; ') AS cancers, MIN(NOTED_DATE) AS first_cancer_date
  FROM problems
  WHERE lower(DX_NAME) NOT LIKE '%suspected%'
    AND (icd10 LIKE 'C%' OR icd10 LIKE 'D0%' OR regexp_matches(lower(DX_NAME), 'malignant|carcinoma|lymphoma|leuka?emia|melanoma'))
  GROUP BY 1),
pacs_pat AS (SELECT PatientKey, PatientID AS mrn FROM pacs.Patient),
studies AS (
  SELECT p.mrn,
         COUNT(*) AS studies,
         COUNT(*) FILTER (WHERE s.InstanceAvailability = 'ONLINE') AS studies_online,
         COUNT(*) FILTER (WHERE s.InstanceAvailability = 'ONLINE' AND s.ModalitiesInStudy LIKE '%CT%') AS ct_online,
         COUNT(*) FILTER (WHERE s.InstanceAvailability = 'ONLINE' AND s.ModalitiesInStudy LIKE '%MR%') AS mr_online,
         COUNT(*) FILTER (WHERE s.InstanceAvailability = 'ONLINE'
                          AND (s.ModalitiesInStudy LIKE '%DX%' OR s.ModalitiesInStudy LIKE '%CR%')) AS xray_online,
         COUNT(*) FILTER (WHERE s.InstanceAvailability = 'ONLINE' AND s.ModalitiesInStudy LIKE '%SM%') AS slides_online,
         string_agg(DISTINCT s.ModalitiesInStudy, ',') AS modalities
  FROM pacs.Study s JOIN pacs_pat p USING (PatientKey) GROUP BY 1),
nodules AS (
  SELECT p.mrn, COUNT(*) AS nodules, MAX(n.DiameterMM) AS largest_nodule_mm
  FROM pacs.NoduleFinding n JOIN pacs.Study s USING (StudyKey) JOIN pacs_pat p USING (PatientKey) GROUP BY 1),
docs AS (
  SELECT PAT_ID, COUNT(*) AS documents,
         COUNT(*) FILTER (WHERE IsScanned) AS scanned_documents,
         COUNT(*) FILTER (WHERE DocumentType = 'Radiology Report') AS radiology_reports,
         COUNT(*) FILTER (WHERE DocumentType = 'Pathology Report') AS pathology_reports,
         COUNT(*) FILTER (WHERE DocumentType = 'Progress Note') AS progress_notes
  FROM documents.document_index GROUP BY 1),
xw_path AS (SELECT PAT_ID, string_agg(tcga_patient, ', ' ORDER BY tcga_patient) AS tcga_patient,
                   string_agg(DISTINCT cohort, ', ') AS cohort
            FROM read_csv('{crosswalk}/pathology_cases.csv', all_varchar=true) GROUP BY 1),
xw_lidc AS (SELECT PAT_ID, string_agg(lidc_patient, ', ') AS lidc_patient
            FROM read_csv('{crosswalk}/lidc_subjects.csv', all_varchar=true) GROUP BY 1)
SELECT
  pt.PAT_ID AS patient_id, 'epic' AS source, pt.PAT_MRN_ID AS mrn,
  pt.PAT_FIRST_NAME || ' ' || pt.PAT_LAST_NAME AS display_name, pt.PAT_NAME AS epic_name,
  sx.NAME AS sex, pt.BIRTH_DATE AS birth_date, pt.DEATH_DATE AS death_date,
  CAST(date_diff('year', pt.BIRTH_DATE, coalesce(pt.DEATH_DATE, current_date)) AS INTEGER) AS age,
  race.race, eg.NAME AS ethnicity, pt.CITY AS city, pt.STATE AS state,
  coalesce(visits.visits, 0) AS visits, visits.first_visit, visits.last_visit,
  coalesce(stays.inpatient_stays, 0) AS inpatient_stays,
  coalesce(labs.lab_results, 0) AS lab_results, coalesce(vitals.vital_signs, 0) AS vital_signs,
  coalesce(meds.medication_orders, 0) AS medication_orders,
  coalesce(long_term.conditions, 0) AS conditions, long_term.active_conditions,
  cancer.cancers, cancer.first_cancer_date,
  coalesce(studies.studies, 0) AS studies, coalesce(studies.studies_online, 0) AS studies_online,
  coalesce(studies.ct_online, 0) AS ct_online, coalesce(studies.mr_online, 0) AS mr_online,
  coalesce(studies.xray_online, 0) AS xray_online, coalesce(studies.slides_online, 0) AS slides_online,
  studies.modalities, coalesce(nodules.nodules, 0) AS nodules, nodules.largest_nodule_mm,
  coalesce(docs.documents, 0) AS documents, coalesce(docs.scanned_documents, 0) AS scanned_documents,
  coalesce(docs.radiology_reports, 0) AS radiology_reports, coalesce(docs.pathology_reports, 0) AS pathology_reports,
  coalesce(docs.progress_notes, 0) AS progress_notes,
  xw_path.tcga_patient AS tcga_barcode, xw_path.cohort AS pathology_cohort, xw_lidc.lidc_patient AS lidc_subject,
  (coalesce(studies.ct_online, 0) > 0)::INT + (coalesce(studies.mr_online, 0) > 0)::INT
    + (coalesce(studies.xray_online, 0) > 0)::INT + (coalesce(studies.slides_online, 0) > 0)::INT AS online_kinds
FROM clarity.PATIENT pt
LEFT JOIN clarity.ZC_SEX sx ON sx.RCPT_MEM_SEX_C = pt.SEX_C
LEFT JOIN clarity.ZC_ETHNIC_GROUP eg ON eg.ETHNIC_GROUP_C = pt.ETHNIC_GROUP_C
LEFT JOIN race USING (PAT_ID) LEFT JOIN visits USING (PAT_ID) LEFT JOIN stays USING (PAT_ID)
LEFT JOIN labs USING (PAT_ID) LEFT JOIN vitals USING (PAT_ID) LEFT JOIN meds USING (PAT_ID)
LEFT JOIN long_term USING (PAT_ID) LEFT JOIN cancer USING (PAT_ID)
LEFT JOIN studies ON studies.mrn = pt.PAT_MRN_ID LEFT JOIN nodules ON nodules.mrn = pt.PAT_MRN_ID
LEFT JOIN docs USING (PAT_ID)
LEFT JOIN xw_path USING (PAT_ID) LEFT JOIN xw_lidc USING (PAT_ID)
ORDER BY pt.PAT_ID
"""


RESEARCH = GEN_DIR / "research"

RESEARCH_SQL = """
WITH sl AS (SELECT patient_id, COUNT(*) AS slides FROM '{r}/imaging/tables/pathology_slide.parquet' GROUP BY 1),
     rs AS (SELECT patient_id, COUNT(*) FILTER (WHERE modality = 'CT') AS ct, COUNT(*) FILTER (WHERE modality = 'MR') AS mr
            FROM '{r}/imaging/tables/radiology_series.parquet' GROUP BY 1),
     st AS (SELECT patient_id, COUNT(*) AS studies FROM '{r}/imaging/tables/radiology_study.parquet' GROUP BY 1),
     en AS (SELECT patient_id, COUNT(*) AS visits, MIN(start) AS first_visit FROM '{r}/clinical/tables/encounter.parquet' GROUP BY 1),
     ob AS (SELECT patient_id, COUNT(*) AS lab_results FROM '{r}/clinical/tables/observation.parquet' GROUP BY 1),
     md AS (SELECT patient_id, COUNT(*) AS medication_orders FROM '{r}/clinical/tables/medication.parquet' GROUP BY 1),
     cd AS (SELECT patient_id, COUNT(*) AS conditions,
                   string_agg(DISTINCT description, '; ') FILTER (WHERE resolved IS NULL) AS active_conditions
            FROM '{r}/clinical/tables/condition.parquet' GROUP BY 1),
     rp AS (SELECT patient_id, COUNT(DISTINCT pdf_path) AS reports FROM '{r}/clinical/tables/pathology_report.parquet' GROUP BY 1)
SELECT p.patient_id, 'research' AS source, NULL AS mrn, p.display_name, p.display_name AS epic_name, p.sex,
       NULL::DATE AS birth_date, TRY_CAST(p.death_date AS DATE) AS death_date,
       CAST(p.age_at_diagnosis + COALESCE(p.days_to_last_contact, 0) / 365.25 AS INTEGER) AS age,
       p.race, p.ethnicity, NULL AS city, p.country AS state,
       COALESCE(en.visits, 0) AS visits, CAST(en.first_visit AS DATE) AS first_visit, TRY_CAST(p.last_contact_date AS DATE) AS last_visit,
       0 AS inpatient_stays, COALESCE(ob.lab_results, 0) AS lab_results, 0 AS vital_signs,
       COALESCE(md.medication_orders, 0) AS medication_orders, COALESCE(cd.conditions, 0) AS conditions, cd.active_conditions,
       p.cancer_type AS cancers, TRY_CAST(p.diagnosis_date AS DATE) AS first_cancer_date,
       COALESCE(st.studies, 0) AS studies, COALESCE(st.studies, 0) AS studies_online,
       COALESCE(rs.ct, 0) AS ct_online, COALESCE(rs.mr, 0) AS mr_online, 0 AS xray_online, COALESCE(sl.slides, 0) AS slides_online,
       NULL AS modalities, 0 AS nodules, NULL::DOUBLE AS largest_nodule_mm,
       COALESCE(rp.reports, 0) AS documents, COALESCE(rp.reports, 0) AS scanned_documents, 0 AS radiology_reports,
       COALESCE(rp.reports, 0) AS pathology_reports, 0 AS progress_notes,
       p.patient_id AS tcga_barcode, lower(p.organ) AS pathology_cohort, NULL AS lidc_subject,
       (COALESCE(rs.ct, 0) > 0)::INT + (COALESCE(rs.mr, 0) > 0)::INT + (COALESCE(sl.slides, 0) > 0)::INT AS online_kinds
FROM '{r}/clinical/tables/patient.parquet' p
LEFT JOIN sl USING (patient_id) LEFT JOIN rs USING (patient_id) LEFT JOIN st USING (patient_id) LEFT JOIN en USING (patient_id)
LEFT JOIN ob USING (patient_id) LEFT JOIN md USING (patient_id) LEFT JOIN cd USING (patient_id) LEFT JOIN rp USING (patient_id)
"""


# The patient list's oncology columns, as the reference app showed them for its fifteen patients.
DRIVER_FIRST = {"TP53", "KRAS", "EGFR", "PIK3CA", "VHL", "ERBB2", "BRAF", "SPOP", "MET", "POLE", "APC", "PTEN", "BAP1",
                "ARID1A", "CDKN2A", "MTOR", "SETD2", "PBRM1"}
NOT_PROTEIN = {"Silent", "Intron", "3'UTR", "5'UTR", "RNA", "IGR", "5'Flank", "3'Flank"}
ROMAN = {"1": "I", "2": "II", "3": "III", "4": "IV"}


def cancer_name(dx: str) -> str | None:
    """A problem-list cancer as the list names it; metastases and secondaries are not cancers of their own."""
    d = dx.lower()
    if "metastasis" in d or "secondary" in d:
        return None
    if "non-small cell" in d:
        return "Non-small cell lung cancer"
    if "small cell" in d:
        return "Small cell lung cancer"
    if "in situ of prostate" in d:
        return "Prostate carcinoma in situ"
    for organ in ("breast", "colon", "prostate"):
        if organ in d:
            return f"{organ.capitalize()} cancer"
    return dx[:1].upper() + dx[1:].lower()


def epic_stage(flowsheet: str | None, names: list[str]) -> str | None:
    """'Stage 3C (qualifier value)' -> 'Stage IIIC'; else the stage a problem name carries ('... TNM stage 1')."""
    m = re.match(r"Stage (\d)([A-C]?)", flowsheet or "")
    if not m:
        m = next((re.search(r"TNM stage (\d)()", n) for n in names if re.search(r"TNM stage \d", n)), None)
    return f"Stage {ROMAN[m.group(1)]}{m.group(2)}" if m else None


def key_alterations(genomes: pd.DataFrame) -> tuple[dict[str, str], dict[str, dict]]:
    """Each TCGA case's top three protein-changing mutations in driver genes (the best-known first, then by allele
    fraction), and its profile."""
    tables = RESEARCH / "genomics" / "tables"
    if not (tables / "somatic_mutation.parquet").exists():
        return {}, {}
    sm = pd.read_parquet(tables / "somatic_mutation.parquet",
                         columns=["patient_id", "gene", "protein_change", "mutation_type", "vaf", "is_driver_gene"])
    sm = sm[sm.is_driver_gene.astype(bool) & ~sm.mutation_type.isin(NOT_PROTEIN)].copy()
    sm["later"] = ~sm.gene.isin(DRIVER_FIRST)
    sm = sm.sort_values(["patient_id", "later", "vaf"], ascending=[True, True, False])
    sm["label"] = sm.gene + " " + sm.protein_change.fillna("").str.replace("p.", "", regex=False)
    drivers = {k: [s.strip() for s in g.label.head(3)] for k, g in sm.groupby("patient_id")}
    prof = pd.read_parquet(tables / "molecular_profile.parquet", columns=["patient_id", "tmb", "msi_status"])
    return drivers, prof.set_index("patient_id").to_dict("index")


def list_columns(con: duckdb.DuckDBPyConnection, df: pd.DataFrame, genomes: pd.DataFrame) -> pd.DataFrame:
    """Cancer, stage, outcome, key alterations, mutations per Mb, slide gigapixels and CT and MRI series for every
    patient. Hospital patients': the problem list, the cancer flowsheets, the PACS and the genomes of their slides'
    TCGA cases. Research patients': their registry, diagnostic slide and scans."""
    rows = con.execute("""
        SELECT p.PAT_ID AS patient_id, e.DX_NAME AS dx FROM clarity.PROBLEM_LIST p JOIN clarity.CLARITY_EDG e USING (DX_ID)
        WHERE lower(e.DX_NAME) NOT LIKE '%suspected%'
          AND (e.CURRENT_ICD10_LIST LIKE 'C%' OR e.CURRENT_ICD10_LIST LIKE 'D0%'
               OR regexp_matches(lower(e.DX_NAME), 'malignant|carcinoma|lymphoma|leuka?emia|melanoma'))
        ORDER BY p.PAT_ID, p.NOTED_DATE""").df()
    names = rows.groupby("patient_id").dx.apply(list).to_dict()
    stage = dict(con.execute("""
        SELECT rc.PAT_ID, arg_max(m.MEAS_VALUE, m.RECORDED_TIME)
        FROM clarity.IP_FLWSHT_REC rc JOIN clarity.IP_FLWSHT_MEAS m USING (FSD_ID) JOIN clarity.IP_FLO_GP_DATA g USING (FLO_MEAS_ID)
        WHERE g.LOINC_CODE = '21908-9' AND m.MEAS_VALUE IS NOT NULL GROUP BY 1""").fetchall())
    images = con.execute("""
        WITH px AS (SELECT SeriesKey, MAX(TotalPixelMatrixColumns)::DOUBLE * MAX(TotalPixelMatrixRows) AS px
                    FROM pacs.Instance GROUP BY 1)
        SELECT pp.PatientID AS mrn, SUM(px.px) FILTER (WHERE se.Modality = 'SM') / 1e9 AS slide_gigapixels,
               COUNT(*) FILTER (WHERE se.Modality IN ('CT', 'MR')) AS scan_series
        FROM pacs.Series se JOIN pacs.Study st USING (StudyKey) JOIN pacs.Patient pp USING (PatientKey)
        LEFT JOIN px USING (SeriesKey)
        WHERE st.InstanceAvailability = 'ONLINE' GROUP BY 1""").df().set_index("mrn")
    drivers, profiles = key_alterations(genomes)
    cases = genomes.sort_values(["patient_id", "ordinal"]).groupby("patient_id").tcga_barcode.apply(list).to_dict()
    research = RESEARCH / "clinical" / "tables" / "patient.parquet"
    reg = pd.read_parquet(research).set_index("patient_id") if research.exists() else pd.DataFrame()
    if len(reg):
        sl = pd.read_parquet(RESEARCH / "imaging" / "tables" / "pathology_slide.parquet")
        sl = sl[sl.role == "diagnostic"].assign(gp=lambda d: d.width.astype(float) * d.height / 1e9).groupby("patient_id").gp.sum()
        rs = pd.read_parquet(RESEARCH / "imaging" / "tables" / "radiology_series.parquet").groupby("patient_id").size()

    out = []
    for r in df.itertuples():
        pid = r.patient_id
        if r.source == "research" and pid in reg.index:
            p = reg.loc[pid]
            cancer, stg = p.cancer_type, p.stage
            vital = "Dead" if p.vital_status == "Dead" else "Alive"
            days = p.days_to_last_contact
            gp, scans, barcodes = sl.get(pid), int(rs.get(pid, 0)), [pid]
        else:
            dx = names.get(pid, [])
            cancer = "; ".join(dict.fromkeys(c for c in map(cancer_name, dx) if c)) or None
            stg = epic_stage(stage.get(pid), dx) if dx else None
            vital = "Dead" if pd.notna(r.death_date) else "Alive"
            end = r.death_date if pd.notna(r.death_date) else r.last_visit
            days = (pd.Timestamp(end) - pd.Timestamp(r.first_cancer_date)).days if dx and pd.notna(r.first_cancer_date) and pd.notna(end) else None
            img = images.loc[r.mrn] if r.mrn in images.index else None
            gp = img.slide_gigapixels if img is not None else None
            scans = int(img.scan_series) if img is not None else 0
            barcodes = cases.get(pid, [])
        alts = [a for b in barcodes for a in drivers.get(b, [])][:3]
        first = profiles.get(barcodes[0], {}) if barcodes else {}
        out.append({"patient_id": pid, "cancer_type": cancer, "stage": stg, "vital_status": vital,
                    "days_from_diagnosis": None if days is None or pd.isna(days) else int(days),
                    "key_alterations": "; ".join(alts) or None, "tmb": first.get("tmb"), "msi_status": first.get("msi_status"),
                    "slide_gigapixels": None if gp is None or pd.isna(gp) else round(float(gp), 2), "scan_series": scans})
    df = df.merge(pd.DataFrame(out), on="patient_id", how="left")
    return with_showcase(df)


# The imaging-demo studies attached to demo patients (scripts/30_patient360_showcase.py), as the list names them.
SHOWCASE_SHORT = {"lung-4dct": "4D CT", "lung-4dcbct": "treatment-day cone-beam CTs", "petct-whole-body": "PET/CT",
                  "brain-tractography": "brain wiring atlas", "breast-brca": "slide with AI layers",
                  "fetal-brain-atlas": "fetal brain atlas", "colon-cycif": "36-marker immunofluorescence"}


def with_showcase(df: pd.DataFrame) -> pd.DataFrame:
    """Adds the showcase studies to the list's slide gigapixels and scans, and names them."""
    df["showcase"] = None
    path = P360 / "p360_showcase.parquet"
    if not path.exists():
        return df
    sc = pd.read_parquet(path)
    for pid, g in sc.groupby("patient_id"):
        i = df.index[df.patient_id == pid]
        if not len(i):
            continue
        gp = float(g.gigapixels.fillna(0).sum())
        scans = int(((g.section == "radiology") & ~g.atlas.astype(bool)).sum())
        df.loc[i, "slide_gigapixels"] = round(float(df.loc[i, "slide_gigapixels"].fillna(0).iloc[0] + gp), 2)
        df.loc[i, "scan_series"] = int(df.loc[i, "scan_series"].fillna(0).iloc[0]) + scans
        df.loc[i, "showcase"] = "; ".join(SHOWCASE_SHORT.get(x, x) for x in g.sort_values("date").study_id)
    return df


def genome_links() -> pd.DataFrame:
    """Each Epic patient's tumour genomes: the TCGA cases behind their biopsy slides that the genomics silo holds
    (scripts/29_patient360_genomics.py), with the slide each came from."""
    cols = ["patient_id", "tcga_barcode", "cohort", "specimen", "slide_series_uid", "ordinal"]
    profiles = RESEARCH / "genomics" / "tables" / "molecular_profile.parquet"
    if not profiles.exists():
        return pd.DataFrame(columns=cols)
    have = set(pd.read_parquet(profiles, columns=["patient_id"]).patient_id)
    xw = pd.read_csv(GEN_DIR / "crosswalk" / "pathology_cases.csv", dtype=str)
    xw = xw[xw.tcga_patient.isin(have)].rename(columns={"PAT_ID": "patient_id", "tcga_patient": "tcga_barcode"})
    xw = xw.sort_values(["patient_id", "tcga_barcode"])
    xw["ordinal"] = xw.groupby("patient_id").cumcount() + 1
    return xw[cols].reset_index(drop=True)


def build_index(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    df = con.execute(INDEX_SQL.format(crosswalk=GEN_DIR / "crosswalk")).df()
    if (RESEARCH / "clinical" / "tables" / "patient.parquet").exists():
        research = con.execute(RESEARCH_SQL.format(r=RESEARCH)).df()
        df = pd.concat([df, research[df.columns.tolist()]], ignore_index=True)
    demo = json.loads(DEMO_FILE.read_text()) if DEMO_FILE.exists() else {"patients": []}
    demo["patients"] = demo["patients"] + [r for r in demo.get("research", []) if r["patient_id"] in set(df.patient_id)]
    order = {d["patient_id"]: i + 1 for i, d in enumerate(demo["patients"])}
    df["demo_order"] = df.patient_id.map(order).astype("Int64")
    df["demo_title"] = df.patient_id.map({d["patient_id"]: d["title"] for d in demo["patients"]})
    df["demo_why"] = df.patient_id.map({d["patient_id"]: d["why"] for d in demo["patients"]})
    genomes = genome_links()
    df["has_genome"] = ((df.source == "research") | df.patient_id.isin(genomes.patient_id)).astype(int)
    df = list_columns(con, df, genomes)
    df.to_parquet(P360 / "p360_patient.parquet", index=False)
    genomes.to_parquet(P360 / "p360_genome.parquet", index=False)
    pd.DataFrame([{"demo_order": i + 1, **d} for i, d in enumerate(demo["patients"])],
                 columns=["demo_order", "patient_id", "title", "why"]).to_parquet(P360 / "p360_demo.parquet",
                                                                                  index=False)
    missing = sorted(set(order) - set(df.patient_id))
    if missing:
        print(f"  demo patients not in the index: {', '.join(missing)}", file=sys.stderr)
    return df


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index-only", action="store_true", help="rebuild the patient index from the existing copy")
    ap.add_argument("--fabric", action="store_true", help="also write the index and demo tables to the Patient360 lakehouse")
    args = ap.parse_args()
    ensure_openssl()  # the data requests are read with the SQL driver (macOS restarts Python here once)
    P360.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    t0 = time.time()
    if not args.index_only:
        print("Bronze tables")
        copy_bronze(con)
    views(con)
    copy_requests()
    print("Patient index")
    df = build_index(con)
    print(f"  {len(df):,} patients; {int((df.online_kinds >= 2).sum()):,} with two or more kinds of online image; "
          f"{int(df.demo_order.notna().sum())} demo patients ({time.time() - t0:.0f} s)")
    if args.fabric:
        print("Patient360 lakehouse")
        ws_id, lh_id = ensure_lakehouse("Patient360", "Patient 360: the patient index, demo patients and viewer files")
        write_tables(ws_id, lh_id, {"p360_patient": pd.read_parquet(P360 / "p360_patient.parquet"),
                                    "p360_demo": pd.read_parquet(P360 / "p360_demo.parquet"),
                                    "p360_genome": pd.read_parquet(P360 / "p360_genome.parquet"), **time_tables()})
        print("Measuring the source items in OneLake")
        inv = inventory(ws_id)
        write_tables(ws_id, lh_id, {"p360_inventory": inv})
        for item, g in inv.groupby("item"):
            print(f"  {item:<26} {int((g.kind == 'table').sum()):>3} tables {g.bytes.sum() / 1e9:>8.2f} GB "
                  f"{int(g[g.kind == 'files'].files.sum()):>9,} files")


if __name__ == "__main__":
    main()
