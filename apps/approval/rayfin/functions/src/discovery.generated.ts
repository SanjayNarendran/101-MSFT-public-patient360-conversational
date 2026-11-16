// Written by scripts/22_approval_app.py: the Cohort Discovery (i2b2) semantic model, for describe_model.
export const MODEL_DESCRIPTION = {
 "model": "Cohort Discovery (i2b2)",
 "instructions": "This model is an i2b2 cohort-discovery data mart (synthetic patients of the fictional Contoso Health). Use it to\nanswer \"how many patients ...\" questions. Never list or return patient_num or encounter_num values; return counts only.\n\nData model (i2b2 CRC star schema):\n- observation_fact holds every observation as one row (entity-attribute-value). concept_cd is an ACT-style code:\n  ICD10CM:E11.9 (diagnosis), LOINC:4548-4 (lab or assessment), RXNORM:197361 (drug), SNOMED:... (procedure or\n  finding), DICOM:CT|SNOMED:51185008 (imaging study by modality and body site), NOTE:..., SPECIMEN:..., LIDC:...\n  Coded answers are concept_cd 'question|answer', e.g. 'LOINC:72166-2|LOINC:LA15920-4' = smoking status: former smoker.\n- modifier_cd '@' is the base fact. Other modifier_cd values qualify a base fact: DXROLE:PRIMARY/SECONDARY/\n  PROBLEM_LIST (diagnosis role) and SITE:SNOMED:<code> (lung nodule lobe). Filter modifier_cd = \"@\" unless asked.\n- Numeric values: valtype_cd = \"N\" and nval_num (units_cd). Dates: start_date.\n- patient_dimension: sex_cd (F/M), age_in_years_num, race_cd, vital_status_cd (Y = deceased).\n- visit_dimension: inout_cd I (inpatient), O (outpatient), E (emergency), T (telehealth).\n- i2b2_ontology is the concept tree (c_fullname paths such as \\i2b2\\Diagnoses\\C00-D49\\C34\\). To find codes for a\n  term, search i2b2_ontology[c_name]; then select all concept_cd in concept_dimension whose concept_path starts with\n  that node's c_fullname (this includes every code below a folder).\n\nHow to count a cohort: build one patient set per criterion, e.g.\n  CALCULATETABLE(VALUES(observation_fact[patient_num]), TREATAS(<codes>, observation_fact[concept_cd]),\n                 observation_fact[modifier_cd] = \"@\")\n  combine criteria with INTERSECT (AND), UNION (OR) and EXCEPT (NOT), then COUNTROWS.\nReport counts the way i2b2 does for an obfuscated user: true counts of 3 or fewer as 0, otherwise add Gaussian noise\n(sigma 1.323) and round; the measure [Patients (obfuscated)] does this for a filter context. Say \"about N (\u00b13)\".",
 "relationships": [
  [
   "observation_fact.patient_num",
   "patient_dimension.patient_num"
  ],
  [
   "observation_fact.encounter_num",
   "visit_dimension.encounter_num"
  ]
 ],
 "tables": [
  {
   "name": "observation_fact",
   "description": "i2b2 fact table: one row per observation. concept_cd is an ACT-style code; modifier_cd '@' marks the base fact.",
   "columns": [
    "patient_num",
    "encounter_num",
    "concept_cd",
    "modifier_cd",
    "start_date",
    "end_date",
    "provider_id",
    "instance_num",
    "valtype_cd",
    "nval_num",
    "tval_char",
    "units_cd",
    "valueflag_cd"
   ],
   "column_descriptions": {
    "patient_num": "Random surrogate patient key. Count it; never list it.",
    "encounter_num": "Random surrogate encounter key (-1 = no encounter).",
    "concept_cd": "ACT-style code, e.g. ICD10CM:E11.9, LOINC:4548-4, RXNORM:197361; coded answers as 'question|answer'.",
    "modifier_cd": "'@' = base fact; DXROLE:* = diagnosis role; SITE:SNOMED:* = nodule lobe.",
    "nval_num": "Numeric value when valtype_cd = 'N'.",
    "valueflag_cd": "H = above reference range, L = below."
   },
   "measures": [
    {
     "name": "Patients",
     "description": "Exact number of distinct patients with matching facts."
    },
    {
     "name": "Patients (obfuscated)",
     "description": "i2b2 DATA_OBFSC count: 0 if 3 or fewer, else count plus Gaussian noise (sigma 1.323), rounded."
    }
   ]
  },
  {
   "name": "patient_dimension",
   "description": "One row per patient. Demographics used by the Demographics ontology folders.",
   "columns": [
    "patient_num",
    "sex_cd",
    "age_in_years_num",
    "race_cd",
    "vital_status_cd",
    "language_cd"
   ],
   "column_descriptions": {
    "sex_cd": "F or M.",
    "vital_status_cd": "Y = deceased, N = living.",
    "race_cd": "white, black, asian, amer. indian, pac islander, other."
   },
   "measures": [
    {
     "name": "Patients in database",
     "description": ""
    }
   ]
  },
  {
   "name": "visit_dimension",
   "description": "One row per encounter.",
   "columns": [
    "encounter_num",
    "patient_num",
    "start_date",
    "end_date",
    "inout_cd",
    "location_path",
    "length_of_stay"
   ],
   "column_descriptions": {
    "inout_cd": "I inpatient, O outpatient, E emergency, T telehealth."
   },
   "measures": []
  },
  {
   "name": "concept_dimension",
   "description": "Maps ontology paths to concept codes. A folder's codes are the rows whose concept_path starts with the folder path.",
   "columns": [
    "concept_path",
    "concept_cd",
    "name_char"
   ],
   "column_descriptions": {},
   "measures": []
  },
  {
   "name": "modifier_dimension",
   "description": "Maps modifier paths to modifier codes.",
   "columns": [
    "modifier_path",
    "modifier_cd",
    "name_char"
   ],
   "column_descriptions": {},
   "measures": []
  },
  {
   "name": "i2b2_ontology",
   "description": "The i2b2 ontology (concept tree) with patient counts per node (c_totalnum). Search c_name to find concepts.",
   "columns": [
    "c_hlevel",
    "c_fullname",
    "c_name",
    "c_visualattributes",
    "c_totalnum",
    "c_basecode",
    "c_tablename",
    "c_columnname",
    "c_operator",
    "c_dimcode",
    "c_columndatatype",
    "c_facttablecolumn",
    "c_metadataxml",
    "c_tooltip",
    "m_applied_path"
   ],
   "column_descriptions": {
    "c_fullname": "Path of the node, e.g. \\i2b2\\Diagnoses\\C00-D49\\C34\\.",
    "c_visualattributes": "FA = folder, LA = leaf, CA = container, DA/RA = modifier.",
    "c_totalnum": "Patients with any fact at or below this node."
   },
   "measures": []
  },
  {
   "name": "table_access",
   "description": "Top-level ontology folders; item keys are \\\\c_table_cd + c_fullname.",
   "columns": [
    "c_table_cd",
    "c_fullname",
    "c_name"
   ],
   "column_descriptions": {},
   "measures": []
  }
 ]
};
