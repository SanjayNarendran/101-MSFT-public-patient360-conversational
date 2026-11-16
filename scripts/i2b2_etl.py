"""Silver OMOP -> Gold i2b2 (DuckDB SQL): the i2b2 CRC star schema plus an i2b2 ontology for cohort discovery.

Reads the OMOP tables registered as views omop.<table> and the vocabularies as vocab.<table>; writes gold.<table>:
- observation_fact, patient_dimension, visit_dimension, provider_dimension, concept_dimension, modifier_dimension:
  the i2b2 CRC data model (https://community.i2b2.org).
- i2b2_ontology and table_access: the ontology metadata the i2b2 query tool browses, with patient counts
  (c_totalnum) on every node.

Ontology layout (concept codes follow the ACT convention VOCABULARY:code):
  Demographics: sex, race, vital status, age (patient_dimension columns), ethnicity (facts)
  Visit Details: visit type (visit_dimension.inout_cd)
  Diagnoses: ICD-10-CM chapter > category > code
  Medications: ATC 1st > 2nd > 3rd > 4th > RxNorm ingredient > drug
  Labs: LOINC tests, with value metadata for numeric constraints
  Vital Signs and Assessments: LOINC observations, with answer leaves for coded values
  Procedures: imaging / pathology / clinical procedures (SNOMED)
  Imaging: studies by modality and body site, image availability, LIDC lung nodule measurements
  Clinical Notes and Specimens
Modifiers: diagnosis role (primary, secondary, problem list) and lung nodule location (lobe).

patient_num and encounter_num are random surrogate keys, as in i2b2, so Gold carries no source identifiers. The
mappings to Epic and OMOP IDs (patient_mapping, encounter_mapping) are written to schema `mapping` and kept on the
protected Silver side. A rebuild reuses the surrogates of an earlier mapping registered as prior.<table>.
"""
from __future__ import annotations

import random
import time
from datetime import date

import duckdb

from epic_reference import ICD10_CHAPTERS
from omop_schema import B, F, I, TS, V, _t, ddl

GOLD = {
    "observation_fact": _t(f"""encounter_num {B}, patient_num {B}, concept_cd {V}, provider_id {V}, start_date {TS},
        modifier_cd {V}, instance_num {I}, valtype_cd {V}, tval_char {V}, nval_num {F}, valueflag_cd {V},
        quantity_num {F}, units_cd {V}, end_date {TS}, location_cd {V}, observation_blob {V}, confidence_num {F},
        update_date {TS}, download_date {TS}, import_date {TS}, sourcesystem_cd {V}, upload_id {I},
        text_search_index {B}"""),
    "patient_dimension": _t(f"""patient_num {B}, vital_status_cd {V}, birth_date {TS}, death_date {TS}, sex_cd {V},
        age_in_years_num {I}, language_cd {V}, race_cd {V}, marital_status_cd {V}, religion_cd {V}, zip_cd {V},
        statecityzip_path {V}, income_cd {V}, patient_blob {V}, update_date {TS}, download_date {TS},
        import_date {TS}, sourcesystem_cd {V}, upload_id {I}"""),
    "visit_dimension": _t(f"""encounter_num {B}, patient_num {B}, active_status_cd {V}, start_date {TS},
        end_date {TS}, inout_cd {V}, location_cd {V}, location_path {V}, length_of_stay {I}, visit_blob {V},
        update_date {TS}, download_date {TS}, import_date {TS}, sourcesystem_cd {V}, upload_id {I}"""),
    "provider_dimension": _t(f"""provider_id {V}, provider_path {V}, name_char {V}, provider_blob {V},
        update_date {TS}, download_date {TS}, import_date {TS}, sourcesystem_cd {V}, upload_id {I}"""),
    "concept_dimension": _t(f"""concept_path {V}, concept_cd {V}, name_char {V}, concept_blob {V}, update_date {TS},
        download_date {TS}, import_date {TS}, sourcesystem_cd {V}, upload_id {I}"""),
    "modifier_dimension": _t(f"""modifier_path {V}, modifier_cd {V}, name_char {V}, modifier_blob {V},
        update_date {TS}, download_date {TS}, import_date {TS}, sourcesystem_cd {V}, upload_id {I}"""),
    "i2b2_ontology": _t(f"""c_hlevel {I}, c_fullname {V}, c_name {V}, c_synonym_cd {V}, c_visualattributes {V},
        c_totalnum {I}, c_basecode {V}, c_metadataxml {V}, c_facttablecolumn {V}, c_tablename {V},
        c_columnname {V}, c_columndatatype {V}, c_operator {V}, c_dimcode {V}, c_comment {V}, c_tooltip {V},
        m_applied_path {V}, update_date {TS}, download_date {TS}, import_date {TS}, sourcesystem_cd {V},
        valuetype_cd {V}, m_exclusion_cd {V}, c_path {V}, c_symbol {V}"""),
    "table_access": _t(f"""c_table_cd {V}, c_table_name {V}, c_protected_access {V}, c_ontology_protection {V},
        c_hlevel {I}, c_fullname {V}, c_name {V}, c_synonym_cd {V}, c_visualattributes {V}, c_totalnum {I},
        c_basecode {V}, c_metadataxml {V}, c_facttablecolumn {V}, c_dimtablename {V}, c_columnname {V},
        c_columndatatype {V}, c_operator {V}, c_dimcode {V}, c_comment {V}, c_tooltip {V}, c_entry_date {TS},
        c_change_date {TS}, c_status_cd {V}, valuetype_cd {V}"""),
}

# Source-ID mappings: written to the protected Silver side (Silver_OMOP.i2b2_<name>), never to Gold
MAPPING = {
    "patient_mapping": _t(f"""patient_ide {V}, patient_ide_source {V}, patient_num {B}, patient_ide_status {V},
        project_id {V}, upload_date {TS}, update_date {TS}, download_date {TS}, import_date {TS},
        sourcesystem_cd {V}, upload_id {I}"""),
    "encounter_mapping": _t(f"""encounter_ide {V}, encounter_ide_source {V}, project_id {V}, encounter_num {B},
        patient_ide {V}, patient_ide_source {V}, encounter_ide_status {V}, upload_date {TS}, update_date {TS},
        download_date {TS}, import_date {TS}, sourcesystem_cd {V}, upload_id {I}"""),
}
# Ranges outside the Epic ID ranges (7-digit PAT_ID numbers, 9-digit CSNs), so no surrogate equals a source ID
PATIENT_RANGE, ENCOUNTER_RANGE = (10_000_000, 100_000_000), (1_000_000_000, 10_000_000_000)

ROOT = "\\i2b2\\"
CATEGORIES = ["Demographics", "Visit Details", "Diagnoses", "Medications", "Labs", "Vital Signs and Assessments",
              "Procedures", "Imaging", "Clinical Notes", "Specimens"]
SOURCE = "OMOP_SILVER"
RACE_CD = {8527: "white", 8516: "black", 8515: "asian", 8657: "amer. indian", 8557: "pac islander"}
NODULES = "Lung nodule findings (LIDC)"

PREFIX = """CASE {v} WHEN 'RxNorm' THEN 'RXNORM' WHEN 'RxNorm Extension' THEN 'RXNORM_EXT'
            ELSE upper(replace({v}, ' ', '_')) END"""


def _code(alias: str) -> str:
    """ACT-style concept code (VOCABULARY:code) for a vocab.concept alias."""
    return f"({PREFIX.format(v=alias + '.vocabulary_id')} || ':' || {alias}.concept_code)"


def _s(expr: str) -> str:
    """A concept code made safe as an ontology path segment."""
    return f"replace(replace({expr}, ':', '_'), '|', '-')"


def _p(*segments: str) -> str:
    """SQL expression for an ontology path: ROOT + segments + trailing backslash (segments are SQL expressions)."""
    return f"'{ROOT}' || " + " || '\\' || ".join(segments) + " || '\\'"


def _q(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _xml(text: str) -> str:
    return f"replace(replace(replace({text}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')"


def _value_xml(code: str, name: str, unit: str) -> str:
    """i2b2 value metadata so the query tool offers numeric constraints (e.g. HbA1c > 6.5)."""
    return (f"'<?xml version=\"1.0\"?><ValueMetadata><Version>3.02</Version><CreationDateTime>{date.today()}"
            f"</CreationDateTime><TestID>' || {_xml(code)} || '</TestID><TestName>' || {_xml(name)} || '</TestName>"
            f"<DataType>Float</DataType><CodeType>GRP</CodeType><Flagstouse>HL</Flagstouse><Oktousevalues>Y"
            f"</Oktousevalues><UnitValues><NormalUnits>' || COALESCE({_xml(unit)}, '') || '</NormalUnits>"
            f"</UnitValues></ValueMetadata>'")


def build_gold(con: duckdb.DuckDBPyConnection, log=print) -> None:
    """Builds every i2b2 table in the DuckDB schema `gold` from the views omop.* and vocab.*."""
    con.execute("SET TimeZone = 'UTC'")
    con.execute("CREATE SCHEMA IF NOT EXISTS gold")
    con.execute("CREATE SCHEMA IF NOT EXISTS i2s")
    con.execute("CREATE SCHEMA IF NOT EXISTS mapping")
    for name, cols in GOLD.items():
        con.execute(ddl("gold", name, cols))
    for name, cols in MAPPING.items():
        con.execute(ddl("mapping", name, cols))
    for name, fn in [("surrogate keys", _surrogates), ("dimensions", _dimensions),
                     ("facts and ontology leaves", _facts), ("ontology", _ontology)]:
        start = time.time()
        fn(con)
        log(f"  {name:<45} {time.time() - start:6.1f}s")


def _assign(existing: dict, keys: list, bounds: tuple[int, int]) -> dict:
    """Keeps existing surrogates and draws unused random numbers in `bounds` for new keys."""
    out = {k: existing[k] for k in keys if k in existing}
    new = [k for k in keys if k not in out]
    used, rng = set(existing.values()), random.SystemRandom()
    draws = [n for n in rng.sample(range(*bounds), len(new) + len(used)) if n not in used][:len(new)]
    out.update(zip(new, draws))
    return out


def _prior(con, name: str, source: str) -> dict:
    exists = con.execute("SELECT count(*) FROM duckdb_views() WHERE schema_name = 'prior' AND view_name = ?",
                         [name]).fetchone()[0] + con.execute(
        "SELECT count(*) FROM duckdb_tables() WHERE schema_name = 'prior' AND table_name = ?", [name]).fetchone()[0]
    if not exists:
        return {}
    num = "patient_num" if name == "patient_mapping" else "encounter_num"
    ide = "patient_ide" if name == "patient_mapping" else "encounter_ide"
    return dict(con.execute(f"SELECT CAST({ide} AS BIGINT), {num} FROM prior.{name} "
                            f"WHERE {ide}_source = ?", [source]).fetchall())


def _surrogates(con):
    """i2s.pmap (person_id -> patient_num) and i2s.emap (visit_occurrence_id -> encounter_num), plus the mappings."""
    import pandas as pd
    persons = [r[0] for r in con.execute("SELECT person_id FROM omop.person ORDER BY 1").fetchall()]
    visits = [r[0] for r in con.execute("SELECT visit_occurrence_id FROM omop.visit_occurrence ORDER BY 1").fetchall()]
    pmap = _assign(_prior(con, "patient_mapping", "OMOP_PERSON_ID"), persons, PATIENT_RANGE)
    emap = _assign(_prior(con, "encounter_mapping", "OMOP_VISIT_OCCURRENCE_ID"), visits, ENCOUNTER_RANGE)
    for name, data, cols in (("pmap", pmap, ["person_id", "patient_num"]),
                             ("emap", emap, ["visit_occurrence_id", "encounter_num"])):
        con.register("surrogate_src", pd.DataFrame(list(data.items()), columns=cols))
        con.execute(f"CREATE OR REPLACE TABLE i2s.{name} AS SELECT * FROM surrogate_src")
        con.unregister("surrogate_src")
    today = f"TIMESTAMP '{date.today()}'"
    con.execute(f"""
        INSERT INTO mapping.patient_mapping BY NAME
        SELECT patient_ide, patient_ide_source, m.patient_num, 'A' AS patient_ide_status,
               'COHORT_DEMO' AS project_id, {today} AS import_date, '{SOURCE}' AS sourcesystem_cd
        FROM (SELECT person_source_value AS patient_ide, 'EPIC_PAT_ID' AS patient_ide_source, person_id
              FROM omop.person
              UNION ALL SELECT CAST(person_id AS VARCHAR), 'OMOP_PERSON_ID', person_id FROM omop.person) x
        JOIN i2s.pmap m ON m.person_id = x.person_id""")
    con.execute(f"""
        INSERT INTO mapping.encounter_mapping BY NAME
        SELECT encounter_ide, encounter_ide_source, 'COHORT_DEMO' AS project_id, m.encounter_num,
               p.person_source_value AS patient_ide, 'EPIC_PAT_ID' AS patient_ide_source, 'A' AS encounter_ide_status,
               {today} AS import_date, '{SOURCE}' AS sourcesystem_cd
        FROM (SELECT CAST(visit_occurrence_id AS VARCHAR) AS encounter_ide, 'EPIC_CSN' AS encounter_ide_source,
                     visit_occurrence_id, person_id FROM omop.visit_occurrence
              UNION ALL SELECT CAST(visit_occurrence_id AS VARCHAR), 'OMOP_VISIT_OCCURRENCE_ID', visit_occurrence_id,
                     person_id FROM omop.visit_occurrence) x
        JOIN i2s.emap m ON m.visit_occurrence_id = x.visit_occurrence_id
        JOIN omop.person p ON p.person_id = x.person_id""")


def _dimensions(con):
    today = f"TIMESTAMP '{date.today()}'"
    race = " ".join(f"WHEN {k} THEN '{v}'" for k, v in RACE_CD.items())
    con.execute(f"""
        INSERT INTO gold.patient_dimension BY NAME
        WITH p AS (
            SELECT p.*, CAST(p.birth_datetime AS DATE) AS born, d.death_date,
                   COALESCE(d.death_date, CURRENT_DATE) AS as_of, l.zip, l.city, l.state
            FROM omop.person p LEFT JOIN omop.death d ON d.person_id = p.person_id
            LEFT JOIN omop.location l ON l.location_id = p.location_id)
        SELECT m.patient_num, CASE WHEN death_date IS NOT NULL THEN 'Y' ELSE 'N' END AS vital_status_cd,
               birth_datetime AS birth_date, CAST(death_date AS TIMESTAMP) AS death_date,
               CASE gender_concept_id WHEN 8532 THEN 'F' WHEN 8507 THEN 'M' ELSE 'U' END AS sex_cd,
               CAST(date_diff('year', born, as_of)
                    - CASE WHEN strftime(as_of, '%m%d') < strftime(born, '%m%d') THEN 1 ELSE 0 END AS INTEGER)
                   AS age_in_years_num,
               'english' AS language_cd, CASE race_concept_id {race} ELSE 'other' END AS race_cd, zip AS zip_cd,
               '\\' || state || '\\' || city || '\\' || COALESCE(zip, '') || '\\' AS statecityzip_path,
               {today} AS update_date, {today} AS import_date, '{SOURCE}' AS sourcesystem_cd
        FROM p JOIN i2s.pmap m ON m.person_id = p.person_id""")
    con.execute(f"""
        INSERT INTO gold.visit_dimension BY NAME
        SELECT e.encounter_num, m.patient_num, 'YY' AS active_status_cd,
               v.visit_start_datetime AS start_date, v.visit_end_datetime AS end_date,
               CASE v.visit_concept_id WHEN 9201 THEN 'I' WHEN 9203 THEN 'E' WHEN 5083 THEN 'T' ELSE 'O' END
                   AS inout_cd,
               CAST(v.care_site_id AS VARCHAR) AS location_cd, cs.care_site_name AS location_path,
               CAST(date_diff('day', v.visit_start_date, v.visit_end_date) AS INTEGER) AS length_of_stay,
               v.visit_source_value AS visit_blob, {today} AS import_date, '{SOURCE}' AS sourcesystem_cd
        FROM omop.visit_occurrence v LEFT JOIN omop.care_site cs ON cs.care_site_id = v.care_site_id
        JOIN i2s.emap e ON e.visit_occurrence_id = v.visit_occurrence_id
        JOIN i2s.pmap m ON m.person_id = v.person_id""")
    con.execute(f"""
        INSERT INTO gold.provider_dimension BY NAME
        SELECT CAST(provider_id AS VARCHAR) AS provider_id,
               '\\Providers\\' || COALESCE(specialty_source_value, 'Unknown') || '\\' || provider_name || '\\'
                   AS provider_path,
               provider_name AS name_char, {today} AS import_date, '{SOURCE}' AS sourcesystem_cd
        FROM omop.provider""")


def _facts(con):
    """Builds i2s.fact (one row per fact), i2s.leaf (ontology leaves) and i2s.folder (names for folder nodes)."""
    con.execute("""
        CREATE OR REPLACE TABLE i2s.fact (person_id BIGINT, visit_occurrence_id BIGINT, provider_id BIGINT,
            start_date TIMESTAMPTZ, end_date TIMESTAMPTZ, concept_cd VARCHAR, category VARCHAR, grp VARCHAR,
            concept_name VARCHAR, value_name VARCHAR, source_value VARCHAR, nval_num DOUBLE, units_cd VARCHAR,
            tval_char VARCHAR, valueflag_cd VARCHAR, modifier_role VARCHAR, modifier_site VARCHAR)""")
    con.execute("CREATE OR REPLACE TABLE i2s.leaf (concept_cd VARCHAR, path VARCHAR, name VARCHAR, metadataxml VARCHAR)")
    con.execute("CREATE OR REPLACE TABLE i2s.folder (path VARCHAR, name VARCHAR, basecode VARCHAR)")
    for fn in (_diagnoses, _medications, _observations, _procedures, _imaging_notes_specimens, _observation_fact):
        start = time.time()
        fn(con)
        print(f"    {fn.__name__[1:]:<43} {time.time() - start:6.1f}s", flush=True)


def _diagnoses(con):
    con.execute("CREATE OR REPLACE TABLE i2s.chapter (lo VARCHAR, hi VARCHAR, name VARCHAR)")
    con.executemany("INSERT INTO i2s.chapter VALUES (?, ?, ?)", ICD10_CHAPTERS)
    # ICD-10-CM source codes of conditions, and of diagnoses OMOP routed to other domains (findings, assessments)
    con.execute("""
        INSERT INTO i2s.fact BY NAME
        WITH dx AS (
            SELECT person_id, visit_occurrence_id, provider_id,
                   COALESCE(condition_start_datetime, CAST(condition_start_date AS TIMESTAMPTZ)) AS start_date,
                   CAST(condition_end_date AS TIMESTAMPTZ) AS end_date, condition_source_concept_id AS src,
                   CASE WHEN condition_type_concept_id = 32840 THEN 'DXROLE:PROBLEM_LIST'
                        WHEN condition_status_concept_id = 32902 THEN 'DXROLE:PRIMARY'
                        ELSE 'DXROLE:SECONDARY' END AS role
            FROM omop.condition_occurrence
            UNION ALL
            SELECT person_id, visit_occurrence_id, provider_id,
                   COALESCE(observation_datetime, CAST(observation_date AS TIMESTAMPTZ)), NULL,
                   observation_source_concept_id, NULL FROM omop.observation
            UNION ALL
            SELECT person_id, visit_occurrence_id, provider_id,
                   COALESCE(measurement_datetime, CAST(measurement_date AS TIMESTAMPTZ)), NULL,
                   measurement_source_concept_id, NULL FROM omop.measurement)
        SELECT dx.person_id, dx.visit_occurrence_id, dx.provider_id, dx.start_date, dx.end_date,
               'ICD10CM:' || s.concept_code AS concept_cd, 'Diagnoses' AS category, s.concept_name,
               dx.role AS modifier_role
        FROM dx JOIN vocab.concept s ON s.concept_id = dx.src AND s.vocabulary_id = 'ICD10CM'""")
    chapter = "COALESCE(ch.lo || '-' || ch.hi, 'Other')"
    con.execute(f"""
        CREATE OR REPLACE TABLE i2s.dx_code AS
        SELECT c.code, c.cat, {chapter} AS chapter, COALESCE(ch.name, 'Other diagnoses') AS chapter_name
        FROM (SELECT DISTINCT substr(concept_cd, 9) AS code, split_part(substr(concept_cd, 9), '.', 1) AS cat
              FROM i2s.fact WHERE category = 'Diagnoses') c
        LEFT JOIN i2s.chapter ch ON c.cat BETWEEN ch.lo AND ch.hi""")
    con.execute(f"""
        INSERT INTO i2s.leaf BY NAME
        SELECT 'ICD10CM:' || d.code AS concept_cd,
               CASE WHEN d.code = d.cat THEN {_p("'Diagnoses'", 'd.chapter', 'd.cat')}
                    ELSE {_p("'Diagnoses'", 'd.chapter', 'd.cat', 'd.code')} END AS path,
               d.code || ' ' || COALESCE(k.concept_name, '') AS name
        FROM i2s.dx_code d LEFT JOIN vocab.concept k ON k.vocabulary_id = 'ICD10CM' AND k.concept_code = d.code""")
    con.execute(f"""
        INSERT INTO i2s.folder BY NAME
        SELECT DISTINCT {_p("'Diagnoses'", 'chapter')} AS path, chapter || ' ' || chapter_name AS name,
               NULL AS basecode
        FROM i2s.dx_code
        UNION ALL
        SELECT DISTINCT {_p("'Diagnoses'", 'd.chapter', 'd.cat')}, d.cat || ' ' || COALESCE(k.concept_name, ''),
               'ICD10CM:' || d.cat
        FROM i2s.dx_code d LEFT JOIN vocab.concept k ON k.vocabulary_id = 'ICD10CM' AND k.concept_code = d.cat""")


def _medications(con):
    con.execute(f"""
        INSERT INTO i2s.fact BY NAME
        SELECT d.person_id, d.visit_occurrence_id, d.provider_id,
               COALESCE(d.drug_exposure_start_datetime, CAST(d.drug_exposure_start_date AS TIMESTAMPTZ)) AS start_date,
               CAST(d.drug_exposure_end_date AS TIMESTAMPTZ) AS end_date, {_code('c')} AS concept_cd,
               'Medications' AS category, c.concept_name
        FROM omop.drug_exposure d JOIN vocab.concept c ON c.concept_id = d.drug_concept_id
        WHERE d.drug_concept_id <> 0""")
    # Each drug sits under each of its ingredients; an ingredient sits under the ATC 4th class(es) of its narrowest
    # ATC 5th class(es), e.g. acetaminophen -> N02BE01 "paracetamol" -> N02BE (ties keep every class)
    con.execute(f"""
        CREATE OR REPLACE TABLE i2s.drug AS
        WITH drugs AS (SELECT DISTINCT drug_concept_id AS drug_id FROM omop.drug_exposure WHERE drug_concept_id <> 0),
        ing AS (
            SELECT drugs.drug_id, i.concept_id AS ing_id, i.concept_code AS ing_code, i.concept_name AS ing_name
            FROM drugs JOIN vocab.concept_ancestor ca ON ca.descendant_concept_id = drugs.drug_id
            JOIN vocab.concept i ON i.concept_id = ca.ancestor_concept_id AND i.concept_class_id = 'Ingredient'
                 AND i.standard_concept = 'S'),
        atc5 AS (
            SELECT ing.ing_id, a.concept_id AS atc5_id, a.concept_code
            FROM (SELECT DISTINCT ing_id FROM ing) ing
            JOIN vocab.concept_ancestor ca ON ca.descendant_concept_id = ing.ing_id
            JOIN vocab.concept a ON a.concept_id = ca.ancestor_concept_id AND a.vocabulary_id = 'ATC'
                 AND a.concept_class_id = 'ATC 5th'),
        width AS (
            SELECT ca.ancestor_concept_id AS atc5_id, count(DISTINCT ca.descendant_concept_id) AS n
            FROM vocab.concept_ancestor ca
            JOIN vocab.concept i ON i.concept_id = ca.descendant_concept_id AND i.concept_class_id = 'Ingredient'
                 AND i.standard_concept = 'S'
            WHERE ca.ancestor_concept_id IN (SELECT atc5_id FROM atc5) GROUP BY 1),
        atc AS (
            SELECT DISTINCT ing_id, left(concept_code, 5) AS atc4 FROM (
                SELECT atc5.*, rank() OVER (PARTITION BY atc5.ing_id ORDER BY w.n) AS r
                FROM atc5 JOIN width w ON w.atc5_id = atc5.atc5_id)
            WHERE r = 1)
        SELECT drugs.drug_id, ing.ing_id, ing.ing_code, ing.ing_name, atc.atc4, {_code('dc')} AS drug_cd,
               dc.concept_name AS drug_name, dc.concept_class_id = 'Ingredient' AS is_ingredient
        FROM drugs LEFT JOIN ing ON ing.drug_id = drugs.drug_id LEFT JOIN atc ON atc.ing_id = ing.ing_id
        JOIN vocab.concept dc ON dc.concept_id = drugs.drug_id""")
    atc = "CASE WHEN atc4 IS NULL THEN 'Other' ELSE left(atc4, 1) || '\\' || left(atc4, 3) || '\\' || " \
          "left(atc4, 4) || '\\' || atc4 END"
    ingredient = _p("'Medications'", atc, "'RXNORM_' || ing_code")
    con.execute(f"""
        INSERT INTO i2s.leaf BY NAME
        SELECT DISTINCT drug_cd AS concept_cd,
               CASE WHEN ing_code IS NULL THEN {_p("'Medications'", "'Other'", _s('drug_cd'))}
                    WHEN is_ingredient THEN {ingredient}
                    ELSE {_p("'Medications'", atc, "'RXNORM_' || ing_code", _s('drug_cd'))} END AS path,
               drug_name AS name
        FROM i2s.drug""")
    levels = " UNION ALL ".join(
        f"SELECT DISTINCT {_p(_q('Medications'), *[f'left(d.atc4, {n})' for n in lengths])} AS path, "
        f"a.concept_code || ' ' || a.concept_name AS name FROM i2s.drug d JOIN vocab.concept a "
        f"ON a.vocabulary_id = 'ATC' AND a.concept_code = left(d.atc4, {lengths[-1]})"
        for lengths in ([1], [1, 3], [1, 3, 4], [1, 3, 4, 5]))
    con.execute(f"""
        INSERT INTO i2s.folder BY NAME
        SELECT path, name, NULL AS basecode FROM ({levels})
        UNION ALL SELECT {_p("'Medications'", "'Other'")}, 'Other (no ATC class)', NULL
        UNION ALL SELECT DISTINCT {ingredient}, ing_name, 'RXNORM:' || ing_code FROM i2s.drug
        WHERE ing_code IS NOT NULL""")


def _observations(con):
    """Labs, vital signs/assessments and LIDC nodule measurements (from MEASUREMENT and OBSERVATION)."""
    lidc = "'LIDC:' || trim(regexp_replace(upper(replace(m.measurement_source_value, 'LIDC ', '')), " \
           "'[^A-Z0-9]+', '_', 'g'), '_')"
    con.execute(f"""
        INSERT INTO i2s.fact BY NAME
        SELECT m.person_id, m.visit_occurrence_id, m.provider_id,
               COALESCE(m.measurement_datetime, CAST(m.measurement_date AS TIMESTAMPTZ)) AS start_date,
               CASE WHEN m.measurement_concept_id <> 0 THEN {_code('c')} ELSE {lidc} END
                   || COALESCE('|' || {_code('v')}, '') AS concept_cd,
               CASE WHEN m.measurement_type_concept_id = 32856 THEN 'Labs'
                    WHEN m.measurement_type_concept_id = 32841 THEN 'Imaging'
                    WHEN s.vocabulary_id = 'SNOMED' THEN 'Procedures' ELSE 'Vital Signs and Assessments' END
                   AS category,
               c.concept_name, v.concept_name AS value_name, m.measurement_source_value AS source_value,
               m.value_as_number AS nval_num, m.unit_source_value AS units_cd,
               CASE WHEN m.value_as_number > m.range_high THEN 'H' WHEN m.value_as_number < m.range_low THEN 'L' END
                   AS valueflag_cd,
               CASE WHEN m.value_as_number IS NULL THEN m.value_source_value END AS tval_char,
               CASE WHEN m.measurement_type_concept_id = 32841 THEN 'SITE:SNOMED:' || site.concept_code END
                   AS modifier_site
        FROM omop.measurement m
        LEFT JOIN vocab.concept c
               ON c.concept_id = CASE WHEN m.measurement_concept_id <> 0 THEN m.measurement_concept_id END
        LEFT JOIN vocab.concept s ON s.concept_id = m.measurement_source_concept_id
        LEFT JOIN vocab.concept v
               ON v.concept_id = CASE WHEN m.value_as_number IS NULL THEN m.value_as_concept_id END
        LEFT JOIN omop.image_feature f ON f.image_feature_event_id = m.measurement_id
        LEFT JOIN vocab.concept site ON site.concept_id = f.anatomic_site_concept_id
        WHERE (m.measurement_concept_id <> 0 OR m.measurement_type_concept_id = 32841)
          AND (s.vocabulary_id IS NULL OR s.vocabulary_id <> 'ICD10CM')""")
    con.execute(f"""
        INSERT INTO i2s.fact BY NAME
        SELECT o.person_id, o.visit_occurrence_id, o.provider_id,
               COALESCE(o.observation_datetime, CAST(o.observation_date AS TIMESTAMPTZ)) AS start_date,
               {_code('c')} || COALESCE('|' || {_code('v')}, '') AS concept_cd,
               CASE WHEN s.vocabulary_id = 'SNOMED' THEN 'Procedures' ELSE 'Vital Signs and Assessments' END
                   AS category,
               c.concept_name, v.concept_name AS value_name, o.observation_source_value AS source_value,
               o.value_as_number AS nval_num, o.unit_source_value AS units_cd,
               CASE WHEN o.value_as_number IS NULL THEN o.value_as_string END AS tval_char
        FROM omop.observation o
        JOIN vocab.concept c ON c.concept_id = o.observation_concept_id
        LEFT JOIN vocab.concept s ON s.concept_id = o.observation_source_concept_id
        LEFT JOIN vocab.concept v ON v.concept_id = o.value_as_concept_id
        WHERE o.observation_concept_id <> 0 AND (s.vocabulary_id IS NULL OR s.vocabulary_id <> 'ICD10CM')""")
    # A coded question becomes a folder with one leaf per answer; a numeric test is a leaf with value metadata
    numeric = _value_xml("q", "COALESCE(q_name, source_value)", "unit")
    question = f"""CASE category WHEN 'Imaging' THEN {_p("'Imaging'", _q(NODULES), _s('q'))}
                   WHEN 'Procedures' THEN {_p("'Procedures'", "'Clinical procedures'", _s('q'))}
                   ELSE {_p('category', _s('q'))} END"""
    con.execute(f"""
        INSERT INTO i2s.leaf BY NAME
        WITH f AS (
            SELECT category, split_part(concept_cd, '|', 1) AS q, concept_cd, any_value(concept_name) AS q_name,
                   any_value(value_name) AS a_name, any_value(source_value) AS source_value,
                   count(nval_num) > 0 AS is_numeric, mode(units_cd) AS unit
            FROM i2s.fact WHERE category IN ('Labs', 'Vital Signs and Assessments', 'Imaging', 'Procedures')
            GROUP BY ALL)
        SELECT concept_cd,
               CASE WHEN concept_cd = q THEN {question}
                    ELSE rtrim({question}, '\\') || '\\' || {_s("split_part(concept_cd, '|', 2)")} || '\\' END AS path,
               CASE WHEN concept_cd = q THEN COALESCE(q_name, source_value) ELSE a_name END AS name,
               CASE WHEN is_numeric THEN {numeric} END AS metadataxml
        FROM f""")
    con.execute(f"""
        INSERT INTO i2s.folder BY NAME
        SELECT {question} AS path, any_value(COALESCE(concept_name, source_value)) AS name, q AS basecode
        FROM (SELECT *, split_part(concept_cd, '|', 1) AS q FROM i2s.fact
              WHERE category IN ('Labs', 'Vital Signs and Assessments', 'Imaging', 'Procedures')
                AND concept_cd LIKE '%|%')
        GROUP BY ALL""")


def _procedures(con):
    con.execute(f"""
        INSERT INTO i2s.fact BY NAME
        SELECT p.person_id, p.visit_occurrence_id, p.provider_id,
               COALESCE(p.procedure_datetime, CAST(p.procedure_date AS TIMESTAMPTZ)) AS start_date,
               {_code('c')} AS concept_cd, 'Procedures' AS category, c.concept_name,
               CASE WHEN p.procedure_occurrence_id IN (SELECT procedure_occurrence_id FROM omop.image_occurrence)
                    THEN 'Imaging procedures'
                    WHEN p.procedure_occurrence_id IN (SELECT specimen_id FROM omop.specimen)
                    THEN 'Pathology procedures' ELSE 'Clinical procedures' END AS grp
        FROM omop.procedure_occurrence p JOIN vocab.concept c ON c.concept_id = p.procedure_concept_id
        WHERE p.procedure_concept_id <> 0""")
    con.execute(f"""
        INSERT INTO i2s.leaf BY NAME
        SELECT DISTINCT concept_cd, {_p("'Procedures'", 'grp', _s('concept_cd'))} AS path, concept_name AS name
        FROM i2s.fact WHERE category = 'Procedures' AND grp IS NOT NULL""")
    con.execute(f"""
        INSERT INTO i2s.folder BY NAME
        SELECT {_p("'Procedures'", 'g')} AS path, g AS name
        FROM (SELECT unnest(['Imaging procedures', 'Pathology procedures', 'Clinical procedures']) AS g)""")


def _imaging_notes_specimens(con):
    con.execute("""
        INSERT INTO i2s.fact BY NAME
        WITH s AS (
            SELECT person_id, visit_occurrence_id, image_study_uid, modality_source_value AS modality,
                   any_value(modality_concept_id) AS modality_id, any_value(anatomic_site_concept_id) AS site_id,
                   min(image_occurrence_date) AS d, count(local_path) > 0 AS online
            FROM omop.image_occurrence GROUP BY ALL)
        SELECT s.person_id, s.visit_occurrence_id, CAST(s.d AS TIMESTAMPTZ) AS start_date,
               'DICOM:' || s.modality || '|' || COALESCE('SNOMED:' || site.concept_code, 'UNSPECIFIED') AS concept_cd,
               'Imaging' AS category, 'modality:' || s.modality AS grp, COALESCE(m.concept_name, s.modality)
                   AS concept_name,
               COALESCE(site.concept_name, 'Unspecified site') AS value_name
        FROM s LEFT JOIN vocab.concept m ON m.concept_id = s.modality_id
        LEFT JOIN vocab.concept site ON site.concept_id = s.site_id
        UNION ALL BY NAME
        SELECT person_id, visit_occurrence_id, CAST(d AS TIMESTAMPTZ) AS start_date,
               CASE WHEN online THEN 'IMG:ONLINE' ELSE 'IMG:OFFLINE' END AS concept_cd, 'Imaging' AS category,
               'availability' AS grp,
               CASE WHEN online THEN 'Images available online (OneLake)' ELSE 'Images offline (legacy archive)' END
                   AS concept_name
        FROM s
        UNION ALL BY NAME
        SELECT n.person_id, n.visit_occurrence_id, n.provider_id, n.note_datetime AS start_date,
               'NOTE:' || c.concept_code AS concept_cd, 'Clinical Notes' AS category, 'type' AS grp,
               CASE c.concept_code WHEN '18748-4' THEN 'Radiology reports' WHEN '11526-1' THEN 'Pathology reports'
                    WHEN '11506-3' THEN 'Progress notes' ELSE t.concept_name END AS concept_name
        FROM omop.note n JOIN vocab.concept c ON c.concept_id = n.note_class_concept_id
        JOIN vocab.concept t ON t.concept_id = n.note_type_concept_id
        UNION ALL BY NAME
        SELECT person_id, visit_occurrence_id, provider_id, note_datetime AS start_date, 'NOTE:SCANNED' AS concept_cd,
               'Clinical Notes' AS category, 'scanned' AS grp, 'Scanned document (text needs OCR)' AS concept_name
        FROM omop.note WHERE note_text IS NULL
        UNION ALL BY NAME
        SELECT s.person_id, s.specimen_datetime AS start_date,
               'SPECIMEN:' || COALESCE('SNOMED:' || site.concept_code, 'UNSPECIFIED') AS concept_cd,
               'Specimens' AS category, 'site' AS grp,
               'Tumor tissue, ' || lower(COALESCE(site.concept_name, 'unspecified site')) AS concept_name
        FROM omop.specimen s LEFT JOIN vocab.concept site ON site.concept_id = s.anatomic_site_concept_id
        UNION ALL BY NAME
        SELECT p.person_id, p.birth_datetime AS start_date,
               'DEM|ETHNICITY:' || CASE p.ethnicity_concept_id WHEN 38003563 THEN 'HISPANIC'
                                         WHEN 38003564 THEN 'NOT_HISPANIC' ELSE 'UNKNOWN' END AS concept_cd,
               'Demographics' AS category, 'ethnicity' AS grp, COALESCE(c.concept_name, 'Unknown') AS concept_name
        FROM omop.person p LEFT JOIN vocab.concept c ON c.concept_id = p.ethnicity_concept_id""")
    modality = "substr(grp, 10)"
    con.execute(f"""
        INSERT INTO i2s.leaf BY NAME
        SELECT DISTINCT concept_cd,
               CASE WHEN grp LIKE 'modality:%'
                    THEN {_p("'Imaging'", "'Studies'", modality, _s("split_part(concept_cd, '|', 2)"))}
                    WHEN grp = 'availability' THEN {_p("'Imaging'", "'Image availability'", _s('concept_cd'))}
                    WHEN grp = 'ethnicity' THEN {_p("'Demographics'", "'Ethnicity'", _s('concept_cd'))}
                    ELSE {_p('category', _s('concept_cd'))} END AS path,
               CASE WHEN grp LIKE 'modality:%' THEN value_name ELSE concept_name END AS name
        FROM i2s.fact WHERE category IN ('Imaging', 'Clinical Notes', 'Specimens', 'Demographics')
          AND grp IS NOT NULL""")
    con.execute(f"""
        INSERT INTO i2s.folder BY NAME
        SELECT DISTINCT {_p("'Imaging'", "'Studies'", modality)} AS path, concept_name AS name
        FROM i2s.fact WHERE grp LIKE 'modality:%'
        UNION ALL SELECT {_p("'Imaging'", "'Studies'")}, 'Imaging studies by modality and body site'
        UNION ALL SELECT {_p("'Imaging'", "'Image availability'")}, 'Image availability'
        UNION ALL SELECT {_p("'Imaging'", _q(NODULES))}, {_q(NODULES)}
        UNION ALL SELECT {_p("'Demographics'", "'Ethnicity'")}, 'Ethnicity'""")


def _observation_fact(con):
    """One row per fact, plus a modifier row for diagnosis roles and nodule locations."""
    today = f"TIMESTAMP '{date.today()}'"
    con.execute(f"""
        INSERT INTO gold.observation_fact BY NAME
        WITH f AS (
            SELECT m.patient_num, COALESCE(e.encounter_num, -1) AS encounter_num,
                   COALESCE(CAST(provider_id AS VARCHAR), '@') AS provider_id, start_date, end_date, concept_cd,
                   nval_num, tval_char, units_cd, valueflag_cd, modifier_role, modifier_site, category
            FROM i2s.fact x JOIN i2s.pmap m ON m.person_id = x.person_id
            LEFT JOIN i2s.emap e ON e.visit_occurrence_id = x.visit_occurrence_id
            WHERE start_date IS NOT NULL),
        r AS (
            SELECT *, '@' AS modifier_cd FROM f
            UNION ALL SELECT *, modifier_role FROM f WHERE modifier_role IS NOT NULL
            UNION ALL SELECT *, modifier_site FROM f WHERE modifier_site IS NOT NULL)
        SELECT encounter_num, patient_num, concept_cd, provider_id, start_date, modifier_cd,
               CAST(row_number() OVER (PARTITION BY patient_num, concept_cd, modifier_cd, start_date, encounter_num,
                                       provider_id ORDER BY nval_num, tval_char) AS INTEGER) AS instance_num,
               CASE WHEN modifier_cd <> '@' THEN '@' WHEN nval_num IS NOT NULL THEN 'N'
                    WHEN tval_char IS NOT NULL THEN 'T' ELSE '@' END AS valtype_cd,
               CASE WHEN modifier_cd <> '@' THEN NULL WHEN nval_num IS NOT NULL THEN 'E' ELSE tval_char END AS tval_char,
               CASE WHEN modifier_cd = '@' THEN nval_num END AS nval_num,
               CASE WHEN modifier_cd = '@' THEN COALESCE(valueflag_cd, '@') END AS valueflag_cd,
               CASE WHEN modifier_cd = '@' THEN units_cd END AS units_cd, end_date,
               {today} AS import_date, '{SOURCE}:' || category AS sourcesystem_cd,
               row_number() OVER (ORDER BY patient_num, start_date, concept_cd, modifier_cd) AS text_search_index
        FROM r""")


def _ontology(con):
    today = f"TIMESTAMP '{date.today()}'"
    # Nodes = leaf paths + every intermediate folder (levels below the category root). A path that is both a leaf
    # and a parent becomes a folder that keeps its code (e.g. ICD-10 J01 with J01.90 below it).
    con.execute(r"""
        CREATE OR REPLACE TABLE i2s.node AS
        WITH leaf AS (SELECT path, any_value(name) AS name, any_value(concept_cd) AS basecode,
                             any_value(metadataxml) AS metadataxml FROM i2s.leaf GROUP BY path),
        prefix AS (
            SELECT DISTINCT array_to_string(segs[1:k], '\') || '\' AS path, segs[k] AS seg
            FROM (SELECT string_split(rtrim(path, '\'), '\') AS segs FROM leaf),
                 LATERAL (SELECT unnest(range(4, len(segs))) AS k)),
        folder AS (SELECT path, any_value(name) AS name, any_value(basecode) AS basecode FROM i2s.folder GROUP BY path)
        SELECT p.path, COALESCE(l.name, f.name, p.seg) AS name, COALESCE(l.basecode, f.basecode) AS basecode,
               FALSE AS is_leaf, NULL AS metadataxml
        FROM prefix p LEFT JOIN leaf l ON l.path = p.path LEFT JOIN folder f ON f.path = p.path
        UNION ALL
        SELECT path, name, basecode, TRUE, metadataxml FROM leaf WHERE path NOT IN (SELECT path FROM prefix)""")
    con.execute(f"""
        INSERT INTO gold.concept_dimension BY NAME
        SELECT path AS concept_path, basecode AS concept_cd, name AS name_char, {today} AS import_date,
               '{SOURCE}' AS sourcesystem_cd
        FROM i2s.node WHERE basecode IS NOT NULL""")
    # Patient counts: a leaf's patients count toward the leaf and every folder above it
    con.execute(r"""
        CREATE OR REPLACE TABLE i2s.counts AS
        WITH pc AS (SELECT DISTINCT patient_num, concept_cd FROM gold.observation_fact WHERE modifier_cd = '@'),
        anc AS (
            SELECT DISTINCT cd.concept_cd, array_to_string(segs[1:k], '\') || '\' AS path
            FROM (SELECT concept_cd, string_split(rtrim(concept_path, '\'), '\') AS segs
                  FROM gold.concept_dimension) cd,
                 LATERAL (SELECT unnest(range(3, len(segs) + 1)) AS k))
        SELECT anc.path, count(DISTINCT pc.patient_num) AS n FROM anc JOIN pc ON pc.concept_cd = anc.concept_cd
        GROUP BY anc.path""")
    roots = " UNION ALL ".join(f"SELECT {_q(ROOT + c + chr(92))} AS path, {_q(c)} AS name"
                               for c in CATEGORIES if c not in ("Demographics", "Visit Details"))
    con.execute(f"""
        INSERT INTO gold.i2b2_ontology BY NAME
        SELECT len(string_split(rtrim(path, '\\'), '\\')) - 2 AS c_hlevel, path AS c_fullname, name AS c_name,
               'N' AS c_synonym_cd, visual AS c_visualattributes, COALESCE(c.n, 0) AS c_totalnum,
               basecode AS c_basecode, metadataxml AS c_metadataxml, 'concept_cd' AS c_facttablecolumn,
               'concept_dimension' AS c_tablename, 'concept_path' AS c_columnname, 'T' AS c_columndatatype,
               'LIKE' AS c_operator, path AS c_dimcode, name AS c_tooltip, '@' AS m_applied_path,
               {today} AS update_date, {today} AS import_date, '{SOURCE}' AS sourcesystem_cd
        FROM (SELECT path, name, basecode, metadataxml, CASE WHEN is_leaf THEN 'LA ' ELSE 'FA ' END AS visual
              FROM i2s.node
              UNION ALL SELECT path, name, NULL, NULL, 'CA ' FROM ({roots})) n
        LEFT JOIN i2s.counts c USING (path)""")
    _dimension_nodes(con, today)
    _modifiers(con, today)
    con.execute(f"""
        INSERT INTO gold.table_access BY NAME
        SELECT 'i2b2_' || lower(replace(c_name, ' ', '_')) AS c_table_cd, 'I2B2_ONTOLOGY' AS c_table_name,
               'N' AS c_protected_access, c_hlevel, c_fullname, c_name, 'N' AS c_synonym_cd,
               c_visualattributes, c_totalnum, c_facttablecolumn, c_tablename AS c_dimtablename, c_columnname,
               c_columndatatype, c_operator, c_dimcode, c_tooltip, {today} AS c_entry_date
        FROM gold.i2b2_ontology WHERE c_hlevel = 1 AND c_fullname LIKE {_q(ROOT + '%')} ORDER BY c_fullname""")


def _dimension_nodes(con, today):
    """Demographics and visit nodes that query patient_dimension / visit_dimension columns directly."""
    rows = [("Demographics", None, "Demographics", "CA ", None, None, None, None),
            ("Demographics\\Sex", None, "Sex", "FA ", None, None, None, None),
            ("Demographics\\Sex\\Female", "DEM|SEX:F", "Female", "LA ", "patient_dimension", "sex_cd", "=", "F"),
            ("Demographics\\Sex\\Male", "DEM|SEX:M", "Male", "LA ", "patient_dimension", "sex_cd", "=", "M"),
            ("Demographics\\Race", None, "Race", "FA ", None, None, None, None)]
    rows += [(f"Demographics\\Race\\{v.title()}", f"DEM|RACE:{v}", v.title(), "LA ", "patient_dimension", "race_cd",
              "=", v) for v in list(RACE_CD.values()) + ["other"]]
    rows += [("Demographics\\Vital Status", None, "Vital Status", "FA ", None, None, None, None),
             ("Demographics\\Vital Status\\Deceased", "DEM|VITAL:Y", "Deceased", "LA ", "patient_dimension",
              "vital_status_cd", "=", "Y"),
             ("Demographics\\Vital Status\\Living", "DEM|VITAL:N", "Living", "LA ", "patient_dimension",
              "vital_status_cd", "=", "N"),
             ("Demographics\\Age", None, "Age", "FA ", None, None, None, None)]
    for lo, hi in [(0, 17), (18, 34), (35, 49), (50, 64), (65, 79), (80, 150)]:
        label = f"{lo}-{hi} years old" if hi < 150 else f"{lo} years old and over"
        rows.append((f"Demographics\\Age\\{label}", f"DEM|AGE:{lo}-{hi}", label, "LA ", "patient_dimension",
                     "age_in_years_num", "BETWEEN", f"{lo} AND {hi}"))
    rows += [("Visit Details", None, "Visit Details", "CA ", None, None, None, None),
             ("Visit Details\\Visit type", None, "Visit type", "FA ", None, None, None, None)]
    for code, label in [("I", "Inpatient"), ("O", "Outpatient"), ("E", "Emergency"), ("T", "Telehealth")]:
        rows.append((f"Visit Details\\Visit type\\{label}", f"VISIT|TYPE:{code}", label, "LA ", "visit_dimension",
                     "inout_cd", "=", code))

    records = []
    patients = con.execute("SELECT count(*) FROM gold.patient_dimension").fetchone()[0]
    for path, code, name, visual, table, column, op, value in rows:
        if table:
            cond = f"{column} BETWEEN {value}" if op == "BETWEEN" else f"{column} = '{value}'"
            n = con.execute(f"SELECT count(DISTINCT patient_num) FROM gold.{table} WHERE {cond}").fetchone()[0]
        else:
            n = patients
        records.append((len(path.split("\\")), ROOT + path + "\\", name, visual, n, code,
                        "encounter_num" if table == "visit_dimension" else "patient_num",
                        table or "patient_dimension", column or "patient_num", "N" if op == "BETWEEN" else "T",
                        op or "IN", value if table else "(SELECT patient_num FROM patient_dimension)", name))
    con.execute("""CREATE OR REPLACE TABLE i2s.dim_node (c_hlevel INTEGER, c_fullname VARCHAR, c_name VARCHAR,
                   c_visualattributes VARCHAR, c_totalnum INTEGER, c_basecode VARCHAR, c_facttablecolumn VARCHAR,
                   c_tablename VARCHAR, c_columnname VARCHAR, c_columndatatype VARCHAR, c_operator VARCHAR,
                   c_dimcode VARCHAR, c_tooltip VARCHAR)""")
    con.executemany(f"INSERT INTO i2s.dim_node VALUES ({', '.join(['?'] * 13)})", records)
    con.execute(f"""
        INSERT INTO gold.i2b2_ontology BY NAME
        SELECT *, 'N' AS c_synonym_cd, '@' AS m_applied_path, {today} AS update_date, {today} AS import_date,
               '{SOURCE}' AS sourcesystem_cd
        FROM i2s.dim_node""")


def _modifiers(con, today):
    roles = [("DXROLE:PRIMARY", "Primary diagnosis"), ("DXROLE:SECONDARY", "Secondary diagnosis"),
             ("DXROLE:PROBLEM_LIST", "Problem list entry")]
    sites = con.execute("""
        SELECT DISTINCT f.modifier_cd, c.concept_name FROM gold.observation_fact f
        LEFT JOIN vocab.concept c ON c.vocabulary_id = 'SNOMED' AND c.concept_code = substr(f.modifier_cd, 13)
        WHERE f.modifier_cd LIKE 'SITE:SNOMED:%' ORDER BY 1""").fetchall()
    dx_applied, nodule_applied = f"{ROOT}Diagnoses\\%", f"{ROOT}Imaging\\{NODULES}\\%"
    mods = [("\\Diagnosis role\\", None, "Diagnosis role", "DA ", dx_applied)]
    mods += [(f"\\Diagnosis role\\{label}\\", code, label, "RA ", dx_applied) for code, label in roles]
    mods += [("\\Nodule location\\", None, "Nodule location", "DA ", nodule_applied)]
    mods += [(f"\\Nodule location\\{name or code}\\", code, name or code, "RA ", nodule_applied)
             for code, name in sites]
    con.execute("""CREATE OR REPLACE TABLE i2s.modifier (path VARCHAR, code VARCHAR, name VARCHAR, visual VARCHAR,
                   applied VARCHAR)""")
    con.executemany("INSERT INTO i2s.modifier VALUES (?, ?, ?, ?, ?)", mods)
    con.execute(f"""
        INSERT INTO gold.modifier_dimension BY NAME
        SELECT path AS modifier_path, code AS modifier_cd, name AS name_char, {today} AS import_date,
               '{SOURCE}' AS sourcesystem_cd FROM i2s.modifier WHERE code IS NOT NULL""")
    con.execute(f"""
        INSERT INTO gold.i2b2_ontology BY NAME
        WITH n AS (SELECT modifier_cd, count(DISTINCT patient_num) AS n FROM gold.observation_fact
                   WHERE modifier_cd <> '@' GROUP BY 1)
        SELECT len(string_split(trim(m.path, '\\'), '\\')) AS c_hlevel, m.path AS c_fullname, m.name AS c_name,
               'N' AS c_synonym_cd, m.visual AS c_visualattributes,
               COALESCE(n.n, (SELECT count(DISTINCT patient_num) FROM gold.observation_fact f
                              WHERE f.modifier_cd IN (SELECT code FROM i2s.modifier x
                                                      WHERE starts_with(x.path, m.path) AND x.code IS NOT NULL)))
                   AS c_totalnum,
               m.code AS c_basecode, 'modifier_cd' AS c_facttablecolumn, 'modifier_dimension' AS c_tablename,
               'modifier_path' AS c_columnname, 'T' AS c_columndatatype, 'LIKE' AS c_operator, m.path AS c_dimcode,
               m.name AS c_tooltip, m.applied AS m_applied_path, {today} AS update_date, {today} AS import_date,
               '{SOURCE}' AS sourcesystem_cd
        FROM i2s.modifier m LEFT JOIN n ON n.modifier_cd = m.code""")
