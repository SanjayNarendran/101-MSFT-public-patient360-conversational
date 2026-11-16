"""Stage 3 verification: Silver_OMOP and Gold_i2b2 in Fabric match the local build, and cohort queries work across
Silver, Gold and Bronze through the SQL analytics endpoint.

Checks:
1. Every Silver (OMOP + vocabulary) and Gold (i2b2) table has the same row count in Fabric as the local Parquet build.
2. Standard-concept coverage per OMOP clinical table.
3. A cohort defined in OMOP (concept IDs + the vocabulary hierarchy) and the same cohort defined in i2b2 (ontology
   paths) return the same patients.
4. One query from the OMOP cohort to the Bronze_PACS series and the radiology report of each finding.
"""
import os
import sys
import time

# mssql-python needs OpenSSL; on macOS point the loader at Homebrew's copy before the driver loads.
_SSL = "/opt/homebrew/opt/openssl@3/lib"
if sys.platform == "darwin" and os.path.isdir(_SSL) and _SSL not in os.environ.get("DYLD_LIBRARY_PATH", ""):
    os.environ["DYLD_LIBRARY_PATH"] = _SSL
    os.execv(sys.executable, [sys.executable] + sys.argv)

import duckdb  # noqa: E402
import mssql_python  # noqa: E402

import i2b2_etl  # noqa: E402
from common import GEN_DIR, fabric, fabric_list, load_state, settings  # noqa: E402
from omop_schema import CDM, EXTENSIONS, VOCAB, VOCAB_FILES  # noqa: E402

# Cohort: adults 50+ who are former smokers and have a CT lung nodule of 6 mm or more
OMOP_COHORT = """
WITH smoker AS (
    SELECT DISTINCT o.person_id FROM {silver}.dbo.observation o
    JOIN {silver}.dbo.concept q ON q.concept_id = o.observation_concept_id AND q.vocabulary_id = 'LOINC'
         AND q.concept_code = '72166-2'
    JOIN {silver}.dbo.concept a ON a.concept_id = o.value_as_concept_id AND a.concept_code = 'LA15920-4'),
nodule AS (
    SELECT DISTINCT m.person_id FROM {silver}.dbo.measurement m
    JOIN {silver}.dbo.concept c ON c.concept_id = m.measurement_concept_id AND c.vocabulary_id = 'SNOMED'
         AND c.concept_code = '246120007'
    WHERE m.value_as_number >= 6)
SELECT COUNT(*) FROM {silver}.dbo.person p
JOIN smoker s ON s.person_id = p.person_id JOIN nodule n ON n.person_id = p.person_id
WHERE DATEDIFF(year, p.birth_datetime, GETDATE()) >= 50
"""
I2B2_COHORT = """
WITH smoker AS (
    SELECT DISTINCT f.patient_num FROM {gold}.dbo.observation_fact f
    WHERE f.concept_cd IN (SELECT concept_cd FROM {gold}.dbo.concept_dimension
                           WHERE concept_path LIKE '\\i2b2\\Vital Signs and Assessments\\LOINC_72166-2\\LOINC_LA15920-4\\%')),
nodule AS (
    SELECT DISTINCT f.patient_num FROM {gold}.dbo.observation_fact f
    WHERE f.concept_cd = 'SNOMED:246120007' AND f.modifier_cd = '@' AND f.valtype_cd = 'N' AND f.nval_num >= 6)
SELECT COUNT(*) FROM {gold}.dbo.patient_dimension p
JOIN smoker s ON s.patient_num = p.patient_num JOIN nodule n ON n.patient_num = p.patient_num
WHERE DATEDIFF(year, p.birth_date, GETDATE()) >= 50
"""
# The vocabulary hierarchy at work: every descendant of SNOMED "Malignant neoplastic disease" counts
HIERARCHY = """
SELECT COUNT(DISTINCT co.person_id) AS Patients, COUNT(DISTINCT co.condition_concept_id) AS DistinctCancerConcepts
FROM {silver}.dbo.condition_occurrence co
JOIN {silver}.dbo.concept_ancestor ca ON ca.descendant_concept_id = co.condition_concept_id
JOIN {silver}.dbo.concept anc ON anc.concept_id = ca.ancestor_concept_id AND anc.vocabulary_id = 'SNOMED'
     AND anc.concept_code = '363346000'
"""
TO_BRONZE = """
SELECT TOP 8 p.person_source_value AS PatId, m.value_as_number AS NoduleMm, lobe.concept_name AS Lobe,
       io.modality_source_value AS Modality, s.NumberOfSeriesRelatedInstances AS Images, n.note_title AS Report,
       io.local_path AS SeriesFolder
FROM {silver}.dbo.measurement m
JOIN {silver}.dbo.image_feature f ON f.image_feature_event_id = m.measurement_id
JOIN {silver}.dbo.image_occurrence io ON io.image_occurrence_id = f.image_occurrence_id
JOIN {silver}.dbo.person p ON p.person_id = m.person_id
JOIN {silver}.dbo.concept lobe ON lobe.concept_id = f.anatomic_site_concept_id
JOIN {pacs}.pacs.Series s ON s.SeriesInstanceUID = io.image_series_uid
LEFT JOIN {silver}.dbo.note n ON n.note_event_id = io.procedure_occurrence_id AND n.note_class_concept_id = 3009854
WHERE m.measurement_concept_id = 4078486 AND m.value_as_number >= 6 AND io.local_path IS NOT NULL
ORDER BY m.value_as_number DESC
"""


def local_counts() -> dict[tuple[str, str], int]:
    con = duckdb.connect()
    counts = {}
    for name in {**CDM, **EXTENSIONS}:
        counts[("silver", name)] = con.execute(
            f"SELECT count(*) FROM '{GEN_DIR / 'omop' / 'cdm' / name}.parquet'").fetchone()[0]
    for name in VOCAB:
        counts[("silver", name)] = con.execute(
            f"SELECT count(*) FROM '{GEN_DIR / 'omop' / 'vocab' / name}.parquet'").fetchone()[0] \
            if name in VOCAB_FILES else 0
    for name in i2b2_etl.GOLD:
        counts[("gold", name)] = con.execute(
            f"SELECT count(*) FROM '{GEN_DIR / 'i2b2' / name}.parquet'").fetchone()[0]
    for name in i2b2_etl.MAPPING:
        counts[("silver", f"i2b2_{name}")] = con.execute(
            f"SELECT count(*) FROM '{GEN_DIR / 'omop' / 'mapping' / name}.parquet'").fetchone()[0]
    return counts


def refresh(ws_id):
    for ep in fabric_list(f"/workspaces/{ws_id}/sqlEndpoints"):
        fabric("POST", f"/workspaces/{ws_id}/sqlEndpoints/{ep['id']}/refreshMetadata", {})


def main():
    cfg, state = settings(), load_state()
    names = {"silver": cfg["LAKEHOUSE_SILVER_OMOP"], "gold": cfg["LAKEHOUSE_GOLD_I2B2"], "pacs": cfg["PACS_DATABASE"]}
    ws_id = state["workspace_id"]
    refresh(ws_id)
    lh = fabric("GET", f"/workspaces/{ws_id}/lakehouses/{state['lakehouses'][names['silver']]}")
    host = lh["properties"]["sqlEndpointProperties"]["connectionString"]
    conn = mssql_python.connect(f"Server={host};Database={names['silver']};Authentication=ActiveDirectoryDefault;"
                                "Encrypt=yes;")
    cur = conn.cursor()

    expected = local_counts()
    failures = 0
    for attempt in range(10):
        seen = {}
        for (layer, table) in expected:
            try:
                cur.execute(f"SELECT COUNT_BIG(*) FROM {names[layer]}.dbo.{table}")
                seen[(layer, table)] = cur.fetchone()[0]
            except Exception:
                seen[(layer, table)] = None
        missing = [k for k in expected if seen[k] != expected[k]]
        if not missing:
            break
        print(f"  waiting for the SQL endpoint ({len(missing)} tables not in sync yet)")
        time.sleep(30)
        refresh(ws_id)
    print("Row counts (Fabric vs local build):")
    for key, n in expected.items():
        ok = seen[key] == n
        failures += not ok
        shown = "missing" if seen[key] is None else f"{seen[key]:,}"
        print(f"  {'OK ' if ok else 'FAIL'} {names[key[0]]}.{key[1]:<24} {shown:>12} (local {n:,})")

    print("\nStandard-concept coverage (Silver_OMOP):")
    for table, col in [("condition_occurrence", "condition_concept_id"), ("drug_exposure", "drug_concept_id"),
                       ("procedure_occurrence", "procedure_concept_id"), ("measurement", "measurement_concept_id"),
                       ("observation", "observation_concept_id"), ("visit_occurrence", "visit_concept_id")]:
        cur.execute(f"SELECT COUNT_BIG(*), SUM(CASE WHEN {col} <> 0 THEN 1 ELSE 0 END) FROM {names['silver']}.dbo.{table}")
        n, mapped = cur.fetchone()
        print(f"  {table:<22} {mapped / n:7.1%} of {n:,}")

    cur.execute(HIERARCHY.format(**names))
    patients, concepts = cur.fetchone()
    print(f"\nVocabulary hierarchy: {patients:,} patients have a diagnosis below SNOMED 'Malignant neoplastic disease' "
          f"({concepts} distinct cancer concepts)")

    cur.execute(OMOP_COHORT.format(**names))
    omop_n = cur.fetchone()[0]
    cur.execute(I2B2_COHORT.format(**names))
    i2b2_n = cur.fetchone()[0]
    ok = omop_n == i2b2_n and omop_n > 0
    failures += not ok
    print(f"\nCohort 'age 50+, former smoker, CT lung nodule >= 6 mm': OMOP {omop_n:,} patients, i2b2 {i2b2_n:,} "
          f"patients -> {'OK' if ok else 'MISMATCH'}")

    print("\nFrom the OMOP cohort to the Bronze_PACS series and the radiology report:")
    cur.execute(TO_BRONZE.format(**names))
    cols = [c[0] for c in cur.description]
    print("  " + " | ".join(cols))
    rows = cur.fetchall()
    for row in rows:
        print("  " + " | ".join(str(v)[:70] for v in row))
    failures += not rows
    conn.close()
    if failures:
        raise SystemExit(f"{failures} check(s) failed")
    print("\nStage 3 verified.")


if __name__ == "__main__":
    main()
