"""Stage 4, step 1: the two semantic models (Direct Lake on OneLake).

- "Cohort Discovery (i2b2)" over Gold_i2b2: what GitHub Copilot queries for cohort counts. No source identifiers,
  dates of birth/death or ZIP codes; patient_num and encounter_num are random surrogates. AI instructions tell an
  assistant (Fabric IQ MCP, option 2) how to count cohorts and to report obfuscated counts only.
- "Research Data (OMOP)" over Silver_OMOP + Bronze_PACS (Fabric SQL database) + Bronze_ClinicalDocuments: patient-level
  data for approved requests and the honest broker. One model across three Fabric items.

Run after 14/15 have uploaded Silver_OMOP and Gold_i2b2; the capacity must be running.
"""
from __future__ import annotations

import semantic_models as sm
from common import load_state, settings

OBFUSCATED = ("VAR n = DISTINCTCOUNT(observation_fact[patient_num]) RETURN IF(n <= 3, 0, "
              "MAX(0, ROUND(n + NORM.INV(RAND(), 0, 1.323), 0)))")

DISCOVERY_INSTRUCTIONS = """
This model is an i2b2 cohort-discovery data mart (synthetic patients of the fictional Contoso Health). Use it to
answer "how many patients ..." questions. Never list or return patient_num or encounter_num values; return counts only.

Data model (i2b2 CRC star schema):
- observation_fact holds every observation as one row (entity-attribute-value). concept_cd is an ACT-style code:
  ICD10CM:E11.9 (diagnosis), LOINC:4548-4 (lab or assessment), RXNORM:197361 (drug), SNOMED:... (procedure or
  finding), DICOM:CT|SNOMED:51185008 (imaging study by modality and body site), NOTE:..., SPECIMEN:..., LIDC:...
  Coded answers are concept_cd 'question|answer', e.g. 'LOINC:72166-2|LOINC:LA15920-4' = smoking status: former smoker.
- modifier_cd '@' is the base fact. Other modifier_cd values qualify a base fact: DXROLE:PRIMARY/SECONDARY/
  PROBLEM_LIST (diagnosis role) and SITE:SNOMED:<code> (lung nodule lobe). Filter modifier_cd = "@" unless asked.
- Numeric values: valtype_cd = "N" and nval_num (units_cd). Dates: start_date.
- patient_dimension: sex_cd (F/M), age_in_years_num, race_cd, vital_status_cd (Y = deceased).
- visit_dimension: inout_cd I (inpatient), O (outpatient), E (emergency), T (telehealth).
- i2b2_ontology is the concept tree (c_fullname paths such as \\i2b2\\Diagnoses\\C00-D49\\C34\\). To find codes for a
  term, search i2b2_ontology[c_name]; then select all concept_cd in concept_dimension whose concept_path starts with
  that node's c_fullname (this includes every code below a folder).

How to count a cohort: build one patient set per criterion, e.g.
  CALCULATETABLE(VALUES(observation_fact[patient_num]), TREATAS(<codes>, observation_fact[concept_cd]),
                 observation_fact[modifier_cd] = "@")
  combine criteria with INTERSECT (AND), UNION (OR) and EXCEPT (NOT), then COUNTROWS.
Report counts the way i2b2 does for an obfuscated user: true counts of 3 or fewer as 0, otherwise add Gaussian noise
(sigma 1.323) and round; the measure [Patients (obfuscated)] does this for a filter context. Say "about N (±3)".
"""


def discovery(state: dict, cfg: dict) -> sm.ModelSpec:
    src = "DirectLake - Gold_i2b2"
    return sm.ModelSpec(
        name=cfg["SEMANTIC_MODEL_DISCOVERY"],
        description="Cohort discovery over the i2b2 Gold layer: counts only, surrogate patient keys.",
        sources={src: state["lakehouses"][cfg["LAKEHOUSE_GOLD_I2B2"]]},
        instructions=DISCOVERY_INSTRUCTIONS,
        tables=[
            sm.Table("observation_fact", src, "observation_fact",
                     columns=["patient_num", "encounter_num", "concept_cd", "modifier_cd", "start_date", "end_date",
                      "provider_id", "instance_num", "valtype_cd", "nval_num", "tval_char", "units_cd",
                      "valueflag_cd"],
                     description="i2b2 fact table: one row per observation. concept_cd is an ACT-style code; "
                                 "modifier_cd '@' marks the base fact.",
                     column_descriptions={
                         "patient_num": "Random surrogate patient key. Count it; never list it.",
                         "encounter_num": "Random surrogate encounter key (-1 = no encounter).",
                         "concept_cd": "ACT-style code, e.g. ICD10CM:E11.9, LOINC:4548-4, RXNORM:197361; "
                                       "coded answers as 'question|answer'.",
                         "modifier_cd": "'@' = base fact; DXROLE:* = diagnosis role; SITE:SNOMED:* = nodule lobe.",
                         "nval_num": "Numeric value when valtype_cd = 'N'.",
                         "valueflag_cd": "H = above reference range, L = below."},
                     measures=[sm.Measure("Patients", "DISTINCTCOUNT(observation_fact[patient_num])",
                                          description="Exact number of distinct patients with matching facts."),
                               sm.Measure("Patients (obfuscated)", OBFUSCATED,
                                          description="i2b2 DATA_OBFSC count: 0 if 3 or fewer, else count plus "
                                                      "Gaussian noise (sigma 1.323), rounded.")]),
            sm.Table("patient_dimension", src, "patient_dimension",
                     columns=["patient_num", "sex_cd", "age_in_years_num", "race_cd", "vital_status_cd", "language_cd"],
                     description="One row per patient. Demographics used by the Demographics ontology folders.",
                     column_descriptions={"sex_cd": "F or M.", "vital_status_cd": "Y = deceased, N = living.",
                                          "race_cd": "white, black, asian, amer. indian, pac islander, other."},
                     measures=[sm.Measure("Patients in database", "COUNTROWS(patient_dimension)")]),
            sm.Table("visit_dimension", src, "visit_dimension",
                     columns=["encounter_num", "patient_num", "start_date", "end_date", "inout_cd", "location_path",
                      "length_of_stay"],
                     description="One row per encounter.",
                     column_descriptions={"inout_cd": "I inpatient, O outpatient, E emergency, T telehealth."}),
            sm.Table("concept_dimension", src, "concept_dimension", columns=["concept_path", "concept_cd", "name_char"],
                     description="Maps ontology paths to concept codes. A folder's codes are the rows whose "
                                 "concept_path starts with the folder path."),
            sm.Table("modifier_dimension", src, "modifier_dimension", columns=["modifier_path", "modifier_cd", "name_char"],
                     description="Maps modifier paths to modifier codes."),
            sm.Table("i2b2_ontology", src, "i2b2_ontology",
                     columns=["c_hlevel", "c_fullname", "c_name", "c_visualattributes", "c_totalnum", "c_basecode",
                      "c_tablename", "c_columnname", "c_operator", "c_dimcode", "c_columndatatype",
                      "c_facttablecolumn", "c_metadataxml", "c_tooltip", "m_applied_path"],
                     description="The i2b2 ontology (concept tree) with patient counts per node (c_totalnum). "
                                 "Search c_name to find concepts.",
                     column_descriptions={
                         "c_fullname": "Path of the node, e.g. \\i2b2\\Diagnoses\\C00-D49\\C34\\.",
                         "c_visualattributes": "FA = folder, LA = leaf, CA = container, DA/RA = modifier.",
                         "c_totalnum": "Patients with any fact at or below this node."}),
            sm.Table("table_access", src, "table_access", columns=["c_table_cd", "c_fullname", "c_name"],
                     description="Top-level ontology folders; item keys are \\\\c_table_cd + c_fullname."),
        ],
        relationships=[("observation_fact.patient_num", "patient_dimension.patient_num"),
                       ("observation_fact.encounter_num", "visit_dimension.encounter_num")])


def research(state: dict, cfg: dict) -> sm.ModelSpec:
    silver, pacs, docs = "DirectLake - Silver_OMOP", "DirectLake - Bronze_PACS", "DirectLake - Bronze_Documents"
    omop = lambda name, entity=None, desc="", **kw: sm.Table(name, silver, entity or name, description=desc, **kw)
    facts = ["visit_occurrence", "condition_occurrence", "drug_exposure", "procedure_occurrence", "measurement",
             "observation", "note", "specimen", "image_occurrence", "condition_era", "drug_era", "death",
             "observation_period"]
    concept_links = {"condition_occurrence": "condition_concept_id", "drug_exposure": "drug_concept_id",
                     "procedure_occurrence": "procedure_concept_id", "measurement": "measurement_concept_id",
                     "observation": "observation_concept_id", "condition_era": "condition_concept_id",
                     "drug_era": "drug_concept_id", "visit_occurrence": "visit_concept_id"}
    return sm.ModelSpec(
        name=cfg["SEMANTIC_MODEL_RESEARCH"],
        description="Patient-level research data (OMOP CDM v5.4) with the PACS index and clinical documents. "
                    "Restricted: honest broker and approved data deliveries.",
        sources={silver: state["lakehouses"][cfg["LAKEHOUSE_SILVER_OMOP"]], pacs: state["pacs_database"]["id"],
                 docs: state["lakehouses"][cfg["LAKEHOUSE_DOCUMENTS"]]},
        tables=[omop("person", desc="OMOP PERSON (Silver_OMOP).",
                     measures=[sm.Measure("Persons", "DISTINCTCOUNT(person[person_id])")]),
                *[omop(t, desc=f"OMOP {t.upper()} (Silver_OMOP).") for t in facts],
                omop("image_feature", desc="OMOP medical imaging extension: features (LIDC nodule measurements) "
                                           "linked to an image_occurrence and a measurement."),
                omop("provider"), omop("care_site"),
                omop("cohort", desc="Approved cohorts (cohort_definition_id = i2b2 QUERY_MASTER_ID)."),
                omop("cohort_definition"),
                omop("concept", "concept_in_use", "OMOP concepts used in this database, plus their ancestors."),
                omop("concept_ancestor", "concept_ancestor_in_use",
                     "Hierarchy rows between the concepts in use: every descendant of an ancestor concept."),
                sm.Table("PACS Study", pacs, "Study", schema="pacs",
                         description="Bronze_PACS (Fabric SQL database) study index.",
                         columns=["StudyKey", "StudyInstanceUID", "AccessionNumber", "StudyDateTime",
                                  "StudyDescription", "ModalitiesInStudy", "BodyPartExamined",
                                  "NumberOfStudyRelatedSeries", "NumberOfStudyRelatedInstances", "StudySizeMB",
                                  "InstanceAvailability", "SourceCollection", "SourceLicense"]),
                sm.Table("PACS Series", pacs, "Series", schema="pacs",
                         description="Bronze_PACS series index; image_occurrence.image_series_uid joins here.",
                         columns=["SeriesKey", "SeriesInstanceUID", "StudyKey", "Modality", "SeriesDescription",
                                  "BodyPartExamined", "Manufacturer", "NumberOfSeriesRelatedInstances",
                                  "SeriesSizeMB", "InstanceAvailability"]),
                sm.Table("Clinical document", docs, "document_index",
                         description="Bronze_ClinicalDocuments index: reports, notes and scanned PDFs in OneLake.",
                         columns=["DocumentId", "DocumentType", "Title", "Format", "IsScanned", "AccessionNumber",
                                  "StudyInstanceUID", "ServiceDateTime", "DocumentDateTime", "AuthorName",
                                  "Department", "OneLakePath", "SizeBytes", "Words"])],
        relationships=[*[(f"{t}.person_id", "person.person_id") for t in facts],
                       ("cohort.subject_id", "person.person_id"),
                       *[(f"{t}.{c}", "concept.concept_id") for t, c in concept_links.items()],
                       ("image_feature.image_occurrence_id", "image_occurrence.image_occurrence_id"),
                       ("image_occurrence.image_series_uid", "PACS Series.SeriesInstanceUID"),
                       ("PACS Series.StudyKey", "PACS Study.StudyKey"),
                       ("note.note_source_value", "Clinical document.DocumentId")])


def main():
    state, cfg = load_state(), settings()
    for spec in (discovery(state, cfg), research(state, cfg)):
        model_id = sm.deploy(spec)
        print(f"  {spec.name}: {model_id}")


if __name__ == "__main__":
    main()
