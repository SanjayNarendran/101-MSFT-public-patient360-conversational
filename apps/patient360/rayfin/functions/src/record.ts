/**
 * Patient 360's data layer, shared by the Rayfin Functions (T-SQL on the Patient360 lakehouse's SQL endpoint) and
 * local mode (DuckDB over data/generated/p360, see local/api.ts). Both run the same SQL text: local mode attaches
 * DuckDB catalogs with the Fabric item names (Bronze_Clarity.dbo.PATIENT, Bronze_PACS.pacs.Study, ...), so only
 * the dialect helpers below differ. The bundle a patient page receives is assembled here too, so both back ends
 * return identical shapes.
 *
 * No imports: the functions compile this with Node16 resolution and the browser bundles it with Vite.
 */

/* ================================================================== types */

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type Dialect = 'tsql' | 'duckdb';

/** Where data is read from. Each is a Fabric item (or a folder of one) and, locally, a DuckDB catalog. */
export type SourceId =
  | 'clarity'
  | 'pacs'
  | 'archive'
  | 'documents'
  | 'p360'
  | 'oncology'
  | 'genomics'
  | 'research_imaging'
  | 'requests'
  | 'omop';
/** The silos of the oncology research data imported from the reference app (TCGA patients). */
export type Silo = 'clinical' | 'genomics' | 'imaging';

export type QueryTrace = { id: string; sources: SourceId[]; tables: string[]; rows: number; ms: number };
export type Provenance = {
  workspace: string;
  endpoint: string;
  database: string;
  queries: QueryTrace[];
  totalMs: number;
  showcaseSql: string;
  servedAt: string;
};
/** A read-only link to a folder or file in an item's Files area: `${baseUrl}/${path}?${query}`. */
export type FileAccess = {
  baseUrl: string;
  query: string;
  expiresOn: string;
  scope: string;
  source: SourceId;
  error?: string;
};

export type Names = {
  clarity: string;
  pacs: string;
  archive: string;
  documents: string;
  p360: string;
  oncology: string;
  genomics: string;
  researchImaging: string;
  /** The cohort data requests (i2b2 CRC store, a Fabric SQL database) and the OMOP layer that maps their patients. */
  requests: string;
  omop: string;
};

/** Item names in the workspace (config/settings.env). The functions' config block can override them. */
export const DEFAULT_NAMES: Names = {
  clarity: 'Bronze_Clarity',
  pacs: 'Bronze_PACS',
  archive: 'Bronze_ImagingArchive',
  documents: 'Bronze_ClinicalDocuments',
  p360: 'Patient360',
  oncology: 'Bronze_Oncology_Clinical',
  genomics: 'Bronze_Oncology_Genomics',
  researchImaging: 'Bronze_Oncology_Imaging',
  requests: 'Cohort_Requests',
  omop: 'Silver_OMOP',
};

export const SOURCE_INFO: Record<SourceId, { label: string; system: string; colour: string }> = {
  clarity: { label: 'Epic Clarity', system: 'Delta tables in a lakehouse', colour: 'var(--c-clin)' },
  pacs: { label: 'PACS index', system: 'Fabric SQL database', colour: 'var(--c-rad)' },
  archive: { label: 'Imaging archive', system: 'DICOM files in OneLake', colour: 'var(--c-rad)' },
  documents: { label: 'Clinical documents', system: 'Lakehouse: text, scanned PDFs, facts', colour: 'var(--ink-2)' },
  p360: { label: 'Patient 360', system: 'Lakehouse: patient index and viewer files', colour: 'var(--accent)' },
  oncology: { label: 'Oncology registry', system: 'Lakehouse: TCGA clinical records', colour: 'var(--c-clin)' },
  genomics: { label: 'Tumour genomics', system: 'Lakehouse: TCGA sequencing', colour: 'var(--c-gen)' },
  research_imaging: { label: 'Research imaging', system: 'Lakehouse: slides and volumes', colour: 'var(--c-path)' },
  requests: { label: 'Data requests', system: 'Fabric SQL database: i2b2 queries and requests', colour: 'var(--ink-2)' },
  omop: { label: 'OMOP (Silver)', system: 'Lakehouse: the i2b2 patient mapping', colour: 'var(--ink-2)' },
};

export type PatientSource = 'epic' | 'research';

/** One row of the patient list (the index joined live to Clarity, PACS and the documents). */
export type PatientListRow = Row;

export type SearchRequest = {
  q?: string;
  /** Any of: ct, nodules, mri, xray, slide, scanned, genome */
  has?: string[];
  cancer?: string;
  sex?: string;
  ageMin?: number;
  ageMax?: number;
  vital?: 'living' | 'deceased';
  demo?: boolean;
  source?: PatientSource;
  /** Exactly these patients (Ask's patient cards). */
  ids?: string[];
  /** The patients of an approved or delivered data request (its QUERY_MASTER_ID). */
  request?: number;
  offset?: number;
  limit?: number;
};
export type SearchResult = { patients: PatientListRow[]; total: number; offset: number; limit: number; provenance: Provenance };

export type PatientBundle = {
  source: PatientSource;
  patient: Row;
  /** The patient's row in the Patient 360 index (counts, what is online, demo order). */
  index: Row | null;
  header: Row;
  diagnoses: Row[];
  treatments: Row[];
  followUps: Row[];
  biomarkers: Row[];
  observations: Row[];
  encounters: Row[];
  conditions: Row[];
  medications: Row[];
  immunizations: Row[];
  allergies: Row[];
  procedures: Row[];
  careplans: Row[];
  report: { text: string; pdfPath: string | null; pdfBytes: number | null; gdcFileId: string | null; source: string | null };
  summary: Row | null;
  profile: Row | null;
  drivers: Row[];
  mutationMap: { chromosomes: string[]; positions: number[]; types: number[]; typeNames: string[] };
  mutationCounts: Row[];
  segments: Row[];
  copyNumber: Row[];
  expression: Row[];
  immuneCells: Row[];
  reference: Row[];
  /** Every tumour genome of the patient, one per sequenced tumour (an Epic patient can have two or three). The flat
   * fields above (profile to reference) are the first one's. */
  genomes: Genome[];
  slide: Row | null;
  slides: Row[];
  radiologyStudies: Row[];
  radiologySeries: Row[];
  /** Every study in the PACS index, online or archived offline. */
  studies: Row[];
  nodules: Row[];
  documents: Row[];
  /** Diagnoses recorded at each visit (Clarity PAT_ENC_DX). */
  visitDiagnoses: Row[];
  /** Approved and delivered data requests whose cohort includes the patient. */
  cohorts: Row[];
  /** Studies from the imaging demo attached to this demo patient (scripts/30_patient360_showcase.py); `meta_json` is
   * the study in the imaging demo's catalog shape, with paths relative to `folder`. */
  showcase: Row[];
  access: { slide: FileAccess; radiology: FileAccess; report: FileAccess; documents: FileAccess; archive: FileAccess };
  provenance: Provenance;
};

export type DocumentText = { document: Row; text: string; facts: Row[]; access: FileAccess; provenance: Provenance };

/** One tumour's genome in the genomics silo, keyed by its TCGA case. */
export type Genome = {
  barcode: string;
  /** The cancer it is compared with in TCGA, e.g. "breast". */
  cancer: string;
  /** Epic patients: the biopsy slide (PACS series) whose TCGA case was sequenced. */
  slideSeriesUid: string | null;
  profile: Row;
  drivers: Row[];
  mutationMap: PatientBundle['mutationMap'];
  mutationCounts: Row[];
  segments: Row[];
  copyNumber: Row[];
  expression: Row[];
  immuneCells: Row[];
  reference: Row[];
};

/** A bundle's flat genome fields (profile to reference) for one genome, or empty. */
export function genomeFields(g: Genome | undefined) {
  if (!g) {
    return {
      profile: null,
      drivers: [],
      mutationMap: { chromosomes: [], positions: [], types: [], typeNames: [] },
      mutationCounts: [],
      segments: [],
      copyNumber: [],
      expression: [],
      immuneCells: [],
      reference: [],
    };
  }
  const { profile, drivers, mutationMap, mutationCounts, segments, copyNumber, expression, immuneCells, reference } = g;
  return { profile, drivers, mutationMap, mutationCounts, segments, copyNumber, expression, immuneCells, reference };
}

/** The bundle as if this genome were the patient's only one (what the genome views read). */
export function withGenome(b: PatientBundle, g: Genome | undefined): PatientBundle {
  return g ? { ...b, ...genomeFields(g) } : b;
}

/** The cancers of the PanCancer Atlas studies the genomes are compared with. */
const STUDY_CANCER: Record<string, string> = {
  brca: 'breast', coadread: 'colorectal', luad: 'lung adenocarcinoma', lusc: 'lung squamous cell', prad: 'prostate',
};

function mutationMap(positions: Row[]): PatientBundle['mutationMap'] {
  const types = [...new Set(positions.map((r) => String(r.mutation_type)))];
  return {
    chromosomes: positions.map((r) => String(r.chromosome)),
    positions: positions.map((r) => Number(r.start_pos)),
    types: positions.map((r) => types.indexOf(String(r.mutation_type))),
    typeNames: types,
  };
}

/* ================================================================== SQL helpers */

export const PATIENT_ID = /^(Z\d{7}|TCGA-[A-Z0-9]{2}-[A-Z0-9]{4})$/;

export function sqlNames(n: Names) {
  return {
    clarity: `${n.clarity}.dbo`,
    pacs: `${n.pacs}.pacs`,
    docs: `${n.documents}.dbo`,
    p360: `${n.p360}.dbo`,
    onc: `${n.oncology}.dbo`,
    gen: `${n.genomics}.dbo`,
    rimg: `${n.researchImaging}.dbo`,
    crc: `${n.requests}.crc`,
    omop: `${n.omop}.dbo`,
  };
}

/**
 * Time columns that can be written as timestamp_ntz (the documents index always is): lakehouse SQL analytics
 * endpoints leave timestamp_ntz columns out. In Fabric they come from companion tables in Patient360 (p360_time_<table>, written
 * by scripts/24_patient360_data.py --fabric, which keeps the same list), joined back under the table's alias, so every
 * query reads the same columns in both back ends.
 */
export const HIDDEN_TIMES = {
  PAT_ENC: { silo: 'clarity', key: ['PAT_ENC_CSN_ID'], times: ['APPT_TIME', 'ENC_CLOSE_TIME'] },
  PAT_ENC_HSP: { silo: 'clarity', key: ['PAT_ENC_CSN_ID'], times: ['HOSP_ADMSN_TIME', 'HOSP_DISCH_TIME'] },
  ORDER_RESULTS: { silo: 'clarity', key: ['ORDER_PROC_ID', 'LINE'], times: ['RESULT_TIME'] },
  IP_FLWSHT_MEAS: { silo: 'clarity', key: ['FSD_ID', 'LINE', 'FLO_MEAS_ID'], times: ['RECORDED_TIME'] },
  ORDER_PROC: { silo: 'clarity', key: ['ORDER_PROC_ID'], times: ['ORDER_INST', 'PROC_START_TIME'] },
  document_index: { silo: 'docs', key: ['DocumentId'], times: ['ServiceDateTime', 'DocumentDateTime'] },
} as const satisfies Record<string, { silo: 'clarity' | 'docs'; key: readonly string[]; times: readonly string[] }>;

/** A table with its time columns: the table itself, or in T-SQL the table joined to its Patient360 companion. */
export function timed(d: Dialect, n: Names, table: keyof typeof HIDDEN_TIMES): string {
  const s = sqlNames(n);
  const h = HIDDEN_TIMES[table];
  const base = `${s[h.silo]}.${table}`;
  if (d !== 'tsql') return base;
  const on = h.key.map((k) => `t.${k} = b.${k}`).join(' AND ');
  return `(SELECT b.*, ${h.times.map((c) => `t.${c}`).join(', ')} FROM ${base} b LEFT JOIN ${s.p360}.p360_time_${table.toLowerCase()} t ON ${on})`;
}

/** The date-and-time type (TIMESTAMP is rowversion in T-SQL). */
export const datetime = (d: Dialect) => (d === 'tsql' ? 'DATETIME2' : 'TIMESTAMP');

/** A named parameter: @id in T-SQL, $id in DuckDB. */
export const param = (d: Dialect, name: string) => (d === 'tsql' ? `@${name}` : `$${name}`);

/** Paging after ORDER BY. */
export const page = (d: Dialect, offset: number, limit: number) =>
  d === 'tsql' ? `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : `LIMIT ${limit} OFFSET ${offset}`;

/** Case-insensitive LIKE. Lakehouse SQL endpoints compare with a binary, case-sensitive collation
 * (Latin1_General_100_BIN2_UTF8), so T-SQL lowers both sides; DuckDB here is set to compare without case. */
export const like = (d: Dialect, expr: string, p: string) => (d === 'tsql' ? `LOWER(${expr}) LIKE LOWER(${p})` : `${expr} LIKE ${p}`);

/** A SQL string literal. */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/* ================================================================== the patient list */

const MODALITY_FILTER: Record<string, string> = {
  ct: 'x.ct_online > 0',
  nodules: 'x.nodules > 0',
  mri: 'x.mr_online > 0',
  xray: 'x.xray_online > 0',
  slide: 'x.slides_online > 0',
  scanned: 'x.scanned_documents > 0',
  genome: 'x.has_genome = 1',
};

/**
 * The patient list: filters on the Patient 360 index, then for the page shown, one statement joins Epic
 * (name, MRN, visits), the PACS database (studies online) and the documents lakehouse (documents).
 * Research patients (TCGA) are in the index only.
 */
/** The Epic patients of a data request, only once it is approved or delivered (Cohort Discovery stays counts-only). */
function requestPatientsSql(n: Names, queryMasterId: number) {
  const s = sqlNames(n);
  return `SELECT m.patient_ide FROM ${s.crc}.COHORT_REQUEST r
    JOIN ${s.crc}.QT_PATIENT_SET_COLLECTION ps ON ps.RESULT_INSTANCE_ID = r.PATIENT_SET_RESULT_INSTANCE_ID
    JOIN ${s.omop}.i2b2_patient_mapping m ON m.patient_num = ps.PATIENT_NUM AND m.patient_ide_source = 'EPIC_PAT_ID'
    WHERE r.QUERY_MASTER_ID = ${queryMasterId} AND r.STATUS IN ('APPROVED', 'DELIVERED')`;
}

/** The approved and delivered data requests, newest first, with the size of each cohort. */
export function requestsSql(n: Names): string {
  const s = sqlNames(n);
  return `
SELECT r.QUERY_MASTER_ID AS query_master_id, r.TITLE AS title, r.STATUS AS status, r.DECIDED_AT AS decided_at,
       r.DELIVERED_AT AS delivered_at,
       (SELECT COUNT(*) FROM ${s.crc}.QT_PATIENT_SET_COLLECTION ps WHERE ps.RESULT_INSTANCE_ID = r.PATIENT_SET_RESULT_INSTANCE_ID) AS patients
FROM ${s.crc}.COHORT_REQUEST r                                         -- the cohort requests database
WHERE r.STATUS IN ('APPROVED', 'DELIVERED')
ORDER BY r.QUERY_MASTER_ID DESC`;
}

export function searchSql(d: Dialect, n: Names, r: SearchRequest): { where: string; count: string; list: string; params: Record<string, string> } {
  const s = sqlNames(n);
  const params: Record<string, string> = {};
  const where: string[] = [];
  const q = (r.q ?? '').trim();
  if (q) {
    params.q = `%${q.replace(/[%_[\]]/g, '')}%`;
    const p = param(d, 'q');
    where.push(
      `(${[
        'x.display_name', 'x.patient_id', 'x.mrn', 'x.tcga_barcode', 'x.active_conditions', 'x.cancers', 'x.demo_title',
      ].map((c) => like(d, c, p)).join(' OR ')}
        OR EXISTS (SELECT 1 FROM ${s.clarity}.PROBLEM_LIST pl JOIN ${s.clarity}.CLARITY_EDG e ON e.DX_ID = pl.DX_ID
                   WHERE pl.PAT_ID = x.patient_id AND ${like(d, 'e.DX_NAME', p)}))`
    );
  }
  for (const h of r.has ?? []) if (MODALITY_FILTER[h]) where.push(MODALITY_FILTER[h]);
  if (r.cancer) {
    params.cancer = `%${r.cancer}%`;
    where.push(`(${like(d, 'x.cancers', param(d, 'cancer'))} OR ${like(d, 'x.pathology_cohort', param(d, 'cancer'))})`);
  }
  if (r.sex) {
    params.sex = r.sex;
    where.push(`x.sex = ${param(d, 'sex')}`);
  }
  if (typeof r.ageMin === 'number') where.push(`x.age >= ${Math.floor(r.ageMin)}`);
  if (typeof r.ageMax === 'number') where.push(`x.age <= ${Math.floor(r.ageMax)}`);
  if (r.vital === 'living') where.push('x.death_date IS NULL');
  if (r.vital === 'deceased') where.push('x.death_date IS NOT NULL');
  if (r.demo) where.push('x.demo_order IS NOT NULL');
  if (r.source) {
    params.source = r.source;
    where.push(`x.source = ${param(d, 'source')}`);
  }
  if (r.request !== undefined) {
    const qm = Math.floor(Number(r.request));
    where.push(Number.isFinite(qm) && qm > 0 ? `x.patient_id IN (${requestPatientsSql(n, qm)})` : '1 = 0');
  }
  const ids = (r.ids ?? []).filter((x) => PATIENT_ID.test(x)).slice(0, 50);
  if (r.ids) {
    ids.forEach((x, i) => (params[`id${i}`] = x));
    where.push(ids.length ? `x.patient_id IN (${ids.map((_, i) => param(d, `id${i}`)).join(', ')})` : '1 = 0');
  }
  const w = where.length ? `WHERE ${where.join('\n  AND ')}` : '';
  const order = 'ORDER BY CASE WHEN x.demo_order IS NULL THEN 1 ELSE 0 END, x.demo_order, x.online_kinds DESC, x.documents DESC, x.patient_id';
  const offset = Math.max(0, Math.floor(r.offset ?? 0));
  const limit = Math.min(50, Math.max(1, Math.floor(r.limit ?? 10)));
  const list = `
WITH shown AS (
  SELECT x.* FROM ${s.p360}.p360_patient x                          -- Patient 360 index
  ${w}
  ${order}
  ${page(d, offset, limit)}
)
SELECT x.patient_id, x.source, COALESCE(p.PAT_MRN_ID, x.mrn) AS mrn,
       CASE WHEN p.PAT_ID IS NULL THEN x.display_name ELSE CONCAT(p.PAT_FIRST_NAME, ' ', p.PAT_LAST_NAME) END AS display_name,
       x.sex, x.age, x.birth_date, x.death_date, x.active_conditions, x.cancers, x.pathology_cohort, x.tcga_barcode,
       x.ct_online, x.nodules, x.largest_nodule_mm, x.mr_online, x.xray_online, x.slides_online, x.online_kinds,
       x.has_genome, x.scanned_documents, x.demo_order, x.demo_title, x.demo_why,
       x.race, x.cancer_type, x.stage, x.vital_status, x.days_from_diagnosis, x.key_alterations, x.tmb, x.msi_status,
       x.slide_gigapixels, x.scan_series, x.showcase,
       CASE WHEN x.source = 'research' THEN x.visits ELSE
         (SELECT COUNT(*) FROM ${s.clarity}.PAT_ENC e WHERE e.PAT_ID = x.patient_id) END AS visits,          -- Epic
       (SELECT COUNT(*) FROM ${s.pacs}.Study st JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey
         WHERE pp.PatientID = p.PAT_MRN_ID) + CASE WHEN x.source = 'research' THEN x.studies ELSE 0 END AS studies,  -- PACS
       (SELECT COUNT(*) FROM ${s.pacs}.Study st JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey
         WHERE pp.PatientID = p.PAT_MRN_ID AND st.InstanceAvailability = 'ONLINE')
         + CASE WHEN x.source = 'research' THEN x.studies_online ELSE 0 END AS studies_online,
       (SELECT COUNT(*) FROM ${s.docs}.document_index di WHERE di.PAT_ID = x.patient_id)
         + CASE WHEN x.source = 'research' THEN x.documents ELSE 0 END AS documents                       -- documents lakehouse
FROM shown x
LEFT JOIN ${s.clarity}.PATIENT p ON p.PAT_ID = x.patient_id
${order}`;
  const count = `SELECT COUNT(*) AS n FROM ${s.p360}.p360_patient x ${w}`;
  return { where: w, count, list, params };
}

/* ================================================================== one Epic patient */

export type QueryDef = { id: string; sources: SourceId[]; tables: string[]; sql: string };

export function epicQueries(d: Dialect, n: Names): QueryDef[] {
  const s = sqlNames(n);
  const id = param(d, 'id');
  const mrn = param(d, 'mrn');
  const studiesOf = `SELECT st.StudyKey FROM ${s.pacs}.Study st JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey WHERE pp.PatientID = ${mrn}`;
  return [
    {
      id: 'patient',
      sources: ['clarity'],
      tables: ['PATIENT', 'PATIENT_RACE', 'ZC_SEX', 'ZC_ETHNIC_GROUP', 'ZC_MARITAL_STATUS', 'CLARITY_SER'],
      sql: `
SELECT p.PAT_ID AS patient_id, p.PAT_MRN_ID AS mrn, CONCAT(p.PAT_FIRST_NAME, ' ', p.PAT_LAST_NAME) AS display_name,
       p.PAT_NAME AS epic_name, sx.NAME AS sex, p.BIRTH_DATE AS birth_date, p.DEATH_DATE AS death_date,
       zr.NAME AS race, eg.NAME AS ethnicity, ms.NAME AS marital_status, p.CITY AS city, p.STATE AS state,
       p.COUNTY AS county, pcp.PROV_NAME AS pcp, pcp.SPECIALTY AS pcp_specialty
FROM ${s.clarity}.PATIENT p
LEFT JOIN ${s.clarity}.ZC_SEX sx ON sx.RCPT_MEM_SEX_C = p.SEX_C
LEFT JOIN ${s.clarity}.ZC_ETHNIC_GROUP eg ON eg.ETHNIC_GROUP_C = p.ETHNIC_GROUP_C
LEFT JOIN ${s.clarity}.ZC_MARITAL_STATUS ms ON ms.MARITAL_STATUS_C = p.MARITAL_STATUS_C
LEFT JOIN ${s.clarity}.PATIENT_RACE r ON r.PAT_ID = p.PAT_ID AND r.LINE = 1
LEFT JOIN ${s.clarity}.ZC_PATIENT_RACE zr ON zr.PATIENT_RACE_C = r.PATIENT_RACE_C
LEFT JOIN ${s.clarity}.CLARITY_SER pcp ON pcp.PROV_ID = p.CUR_PCP_PROV_ID
WHERE p.PAT_ID = ${id}`,
    },
    { id: 'index', sources: ['p360'], tables: ['p360_patient'], sql: `SELECT * FROM ${s.p360}.p360_patient WHERE patient_id = ${id}` },
    {
      id: 'encounters',
      sources: ['clarity'],
      tables: ['PAT_ENC', 'PAT_ENC_HSP', 'PAT_ENC_DX', 'CLARITY_EDG', 'CLARITY_SER', 'CLARITY_DEP', 'ZC_DISP_ENC_TYPE', 'ZC_PAT_CLASS'],
      sql: `
SELECT CAST(e.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id,
       COALESCE(h.HOSP_ADMSN_TIME, e.APPT_TIME, CAST(e.CONTACT_DATE AS ${datetime(d)})) AS start,
       COALESCE(h.HOSP_DISCH_TIME, e.ENC_CLOSE_TIME) AS stop,
       t.NAME AS encounter_type, pc.NAME AS patient_class, ad.NAME AS admission_source, dd.NAME AS discharge_disposition,
       dx.DX_NAME AS reason, dx.CURRENT_ICD10_LIST AS reason_icd10,
       sv.PROV_NAME AS provider, sv.SPECIALTY AS provider_specialty, sv.CLINICIAN_TITLE AS provider_title,
       dp.DEPARTMENT_NAME AS department, dp.SPECIALTY AS department_specialty, dp.REV_LOC_NAME AS organization,
       dp.CITY AS city, e.APPT_STATUS_C AS appt_status
FROM ${timed(d, n, 'PAT_ENC')} e
LEFT JOIN ${s.clarity}.ZC_DISP_ENC_TYPE t ON t.DISP_ENC_TYPE_C = e.ENC_TYPE_C
LEFT JOIN ${timed(d, n, 'PAT_ENC_HSP')} h ON h.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID
LEFT JOIN ${s.clarity}.ZC_PAT_CLASS pc ON pc.ADT_PAT_CLASS_C = h.ADT_PAT_CLASS_C
LEFT JOIN ${s.clarity}.ZC_ADM_SOURCE ad ON ad.ADMIT_SOURCE_C = h.ADMIT_SOURCE_C
LEFT JOIN ${s.clarity}.ZC_DISCH_DISP dd ON dd.DISCH_DISP_C = h.DISCH_DISP_C
LEFT JOIN ${s.clarity}.PAT_ENC_DX x ON x.PAT_ENC_CSN_ID = e.PAT_ENC_CSN_ID AND x.PRIMARY_DX_YN = 'Y'
LEFT JOIN ${s.clarity}.CLARITY_EDG dx ON dx.DX_ID = x.DX_ID
LEFT JOIN ${s.clarity}.CLARITY_SER sv ON sv.PROV_ID = e.VISIT_PROV_ID
LEFT JOIN ${s.clarity}.CLARITY_DEP dp ON dp.DEPARTMENT_ID = e.DEPARTMENT_ID
WHERE e.PAT_ID = ${id}
ORDER BY start`,
    },
    {
      id: 'labs',
      sources: ['clarity'],
      tables: ['ORDER_RESULTS', 'CLARITY_COMPONENT', 'ZC_RESULT_FLAG'],
      sql: `
SELECT r.RESULT_TIME AS date, CAST(r.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id, 'laboratory' AS category,
       c.NAME AS epic_name, c.LOINC_CODE AS code, r.ORD_NUM_VALUE AS value, r.ORD_VALUE AS value_text,
       COALESCE(r.REFERENCE_UNIT, c.DEFAULT_UNIT) AS units, r.REFERENCE_LOW AS ref_low, r.REFERENCE_HIGH AS ref_high,
       f.NAME AS result_flag, CAST(r.ORDER_PROC_ID AS VARCHAR(20)) AS order_id
FROM ${timed(d, n, 'ORDER_RESULTS')} r
JOIN ${s.clarity}.CLARITY_COMPONENT c ON c.COMPONENT_ID = r.COMPONENT_ID
LEFT JOIN ${s.clarity}.ZC_RESULT_FLAG f ON f.RESULT_FLAG_C = r.RESULT_FLAG_C
WHERE r.PAT_ID = ${id}
ORDER BY date`,
    },
    {
      id: 'vitals',
      sources: ['clarity'],
      tables: ['IP_FLWSHT_MEAS', 'IP_FLWSHT_REC', 'IP_FLO_GP_DATA', 'PAT_ENC'],
      sql: `
SELECT m.RECORDED_TIME AS date, CAST(e.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id, g.FLO_MEAS_NAME AS epic_name,
       g.DISP_NAME AS display_name, g.LOINC_CODE AS code, g.UNITS AS units, g.VAL_TYPE AS value_type,
       m.MEAS_VALUE AS value_text, TRY_CAST(m.MEAS_VALUE AS FLOAT) AS value
FROM ${s.clarity}.IP_FLWSHT_REC rc
JOIN ${timed(d, n, 'IP_FLWSHT_MEAS')} m ON m.FSD_ID = rc.FSD_ID
JOIN ${s.clarity}.IP_FLO_GP_DATA g ON g.FLO_MEAS_ID = m.FLO_MEAS_ID
LEFT JOIN ${s.clarity}.PAT_ENC e ON e.INPATIENT_DATA_ID = rc.INPATIENT_DATA_ID
WHERE rc.PAT_ID = ${id}
ORDER BY date`,
    },
    {
      id: 'conditions',
      sources: ['clarity'],
      tables: ['PROBLEM_LIST', 'CLARITY_EDG', 'ZC_PROBLEM_STATUS'],
      sql: `
SELECT CAST(pl.DIAG_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id, pl.NOTED_DATE AS onset, pl.RESOLVED_DATE AS resolved,
       e.DX_NAME AS description, e.CURRENT_ICD10_LIST AS icd10, e.SNOMED_CT_CODE AS snomed, z.NAME AS status,
       CAST(pl.PROBLEM_LIST_ID AS VARCHAR(20)) AS problem_id
FROM ${s.clarity}.PROBLEM_LIST pl
JOIN ${s.clarity}.CLARITY_EDG e ON e.DX_ID = pl.DX_ID
LEFT JOIN ${s.clarity}.ZC_PROBLEM_STATUS z ON z.PROBLEM_STATUS_C = pl.PROBLEM_STATUS_C
WHERE pl.PAT_ID = ${id}
ORDER BY onset`,
    },
    {
      id: 'visitDiagnoses',
      sources: ['clarity'],
      tables: ['PAT_ENC_DX', 'CLARITY_EDG'],
      sql: `
SELECT CAST(x.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id, x.CONTACT_DATE AS date, x.LINE AS line,
       x.PRIMARY_DX_YN AS is_primary, e.DX_NAME AS description, e.CURRENT_ICD10_LIST AS icd10
FROM ${s.clarity}.PAT_ENC_DX x
JOIN ${s.clarity}.CLARITY_EDG e ON e.DX_ID = x.DX_ID
WHERE x.PAT_ID = ${id}
ORDER BY date, line`,
    },
    {
      id: 'cohorts',
      sources: ['requests', 'omop'],
      tables: ['COHORT_REQUEST', 'QT_PATIENT_SET_COLLECTION', 'COHORT_QUERY_CONTEXT', 'i2b2_patient_mapping'],
      sql: `
SELECT r.QUERY_MASTER_ID AS query_master_id, r.TITLE AS title, r.STATUS AS status, r.REQUESTED_BY AS requested_by,
       r.REQUESTED_AT AS requested_at, r.DECIDED_BY AS decided_by, r.DECIDED_AT AS decided_at,
       r.DELIVERED_AT AS delivered_at, r.DELIVERY_LAKEHOUSE AS delivery_lakehouse, r.DELIVERED_PATIENTS AS delivered_patients,
       (SELECT COUNT(*) FROM ${s.crc}.QT_PATIENT_SET_COLLECTION p2 WHERE p2.RESULT_INSTANCE_ID = r.PATIENT_SET_RESULT_INSTANCE_ID) AS patients,
       c.NL_QUESTION AS question, c.QUERY_SUMMARY AS summary,
       (SELECT MAX(CAST(m2.patient_ide AS BIGINT)) FROM ${s.omop}.i2b2_patient_mapping m2
         WHERE m2.patient_num = ps.PATIENT_NUM AND m2.patient_ide_source = 'OMOP_PERSON_ID') AS person_id
FROM ${s.crc}.COHORT_REQUEST r                                         -- the cohort requests database
JOIN ${s.crc}.QT_PATIENT_SET_COLLECTION ps ON ps.RESULT_INSTANCE_ID = r.PATIENT_SET_RESULT_INSTANCE_ID
JOIN ${s.omop}.i2b2_patient_mapping m ON m.patient_num = ps.PATIENT_NUM AND m.patient_ide_source = 'EPIC_PAT_ID'
LEFT JOIN ${s.crc}.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = r.QUERY_MASTER_ID
WHERE m.patient_ide = ${id} AND r.STATUS IN ('APPROVED', 'DELIVERED')
ORDER BY r.QUERY_MASTER_ID DESC`,
    },
    {
      id: 'medications',
      sources: ['clarity'],
      tables: ['ORDER_MED', 'CLARITY_MEDICATION', 'ORDER_DX_MED', 'CLARITY_EDG', 'ZC_ORDER_STATUS', 'CLARITY_SER'],
      sql: `
SELECT CAST(o.ORDER_MED_ID AS VARCHAR(20)) AS order_id, CAST(o.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id,
       COALESCE(o.START_DATE, o.ORDERING_DATE) AS start, o.END_DATE AS stop, m.NAME AS epic_name,
       m.GENERIC_NAME AS generic_name, m.STRENGTH AS strength, m.FORM AS form, m.THERA_CLASS AS therapeutic_class,
       m.PHARM_CLASS AS pharmaceutical_class, m.RXNORM_CODE AS rxnorm, dx.DX_NAME AS reason, st.NAME AS status,
       o.REFILLS AS refills, sv.PROV_NAME AS prescriber
FROM ${s.clarity}.ORDER_MED o
JOIN ${s.clarity}.CLARITY_MEDICATION m ON m.MEDICATION_ID = o.MEDICATION_ID
LEFT JOIN ${s.clarity}.ORDER_DX_MED om ON om.ORDER_MED_ID = o.ORDER_MED_ID AND om.LINE = 1
LEFT JOIN ${s.clarity}.CLARITY_EDG dx ON dx.DX_ID = om.DX_ID
LEFT JOIN ${s.clarity}.ZC_ORDER_STATUS st ON st.ORDER_STATUS_C = o.ORDER_STATUS_C
LEFT JOIN ${s.clarity}.CLARITY_SER sv ON sv.PROV_ID = o.AUTHRZING_PROV_ID
WHERE o.PAT_ID = ${id}
ORDER BY start`,
    },
    {
      id: 'procedures',
      sources: ['clarity'],
      tables: ['ORDER_PROC', 'CLARITY_EAP', 'ORDER_DX_PROC', 'CLARITY_EDG', 'ZC_ORDER_TYPE', 'ORDER_RAD_ACC_NUM'],
      sql: `
SELECT CAST(o.ORDER_PROC_ID AS VARCHAR(20)) AS order_id, CAST(o.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id,
       COALESCE(o.PROC_START_TIME, o.ORDER_INST, CAST(o.ORDERING_DATE AS ${datetime(d)})) AS date,
       o.DESCRIPTION AS epic_name, ap.PROC_CODE AS code, ap.CODE_TYPE AS code_type, ap.PROC_CAT_NAME AS category,
       ot.NAME AS order_type, dx.DX_NAME AS reason, a.ACC_NUM AS accession
FROM ${timed(d, n, 'ORDER_PROC')} o
LEFT JOIN ${s.clarity}.CLARITY_EAP ap ON ap.PROC_ID = o.PROC_ID
LEFT JOIN ${s.clarity}.ZC_ORDER_TYPE ot ON ot.ORDER_TYPE_C = o.ORDER_TYPE_C
LEFT JOIN ${s.clarity}.ORDER_DX_PROC op ON op.ORDER_PROC_ID = o.ORDER_PROC_ID AND op.LINE = 1
LEFT JOIN ${s.clarity}.CLARITY_EDG dx ON dx.DX_ID = op.DX_ID
LEFT JOIN ${s.clarity}.ORDER_RAD_ACC_NUM a ON a.ORDER_PROC_ID = o.ORDER_PROC_ID AND a.LINE = 1
WHERE o.PAT_ID = ${id} AND (ot.NAME IS NULL OR ot.NAME <> 'Lab')
ORDER BY date`,
    },
    {
      id: 'studies',
      sources: ['pacs', 'clarity', 'documents'],
      tables: ['Study', 'Patient', 'ArchiveStore', 'ORDER_RAD_ACC_NUM', 'ORDER_PROC', 'document_index'],
      sql: `
SELECT st.StudyInstanceUID AS study_uid, st.AccessionNumber AS accession, st.StudyDateTime AS date,
       st.StudyDescription AS description, st.ModalitiesInStudy AS modalities, st.BodyPartExamined AS body_part,
       st.InstitutionName AS institution, st.ReferringPhysicianName AS referring, st.NumberOfStudyRelatedSeries AS series_count,
       st.NumberOfStudyRelatedInstances AS images, st.StudySizeMB AS size_mb, st.InstanceAvailability AS availability,
       st.SourceCollection AS source_collection, st.SourceLicense AS source_license, st.SourceDOI AS source_doi,
       ar.Name AS archive, CAST(o.ORDER_PROC_ID AS VARCHAR(20)) AS order_id, CAST(o.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id,
       (SELECT MIN(di.DocumentId) FROM ${s.docs}.document_index di WHERE di.AccessionNumber = st.AccessionNumber) AS report_id
FROM ${s.pacs}.Study st                                           -- PACS database
JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey
JOIN ${s.pacs}.ArchiveStore ar ON ar.ArchiveStoreKey = st.ArchiveStoreKey
LEFT JOIN ${s.clarity}.ORDER_RAD_ACC_NUM a ON a.ACC_NUM = st.AccessionNumber  -- Epic order
LEFT JOIN ${s.clarity}.ORDER_PROC o ON o.ORDER_PROC_ID = a.ORDER_PROC_ID
WHERE pp.PatientID = ${mrn}
ORDER BY date`,
    },
    {
      id: 'series',
      sources: ['pacs'],
      tables: ['Series', 'Instance'],
      sql: `
SELECT se.SeriesInstanceUID AS series_uid, st.StudyInstanceUID AS study_uid, se.Modality AS modality,
       se.SeriesNumber AS series_number, se.SeriesDescription AS description, se.BodyPartExamined AS body_part,
       se.Manufacturer AS manufacturer, se.ManufacturerModelName AS model, se.SliceThicknessMM AS slice_mm,
       se.PixelSpacingMM AS pixel_mm, se.NumberOfSeriesRelatedInstances AS instances, se.SeriesSizeMB AS size_mb,
       se.InstanceAvailability AS availability,
       (SELECT MAX(i.TotalPixelMatrixColumns) FROM ${s.pacs}.Instance i WHERE i.SeriesKey = se.SeriesKey) AS width,
       (SELECT MAX(i.TotalPixelMatrixRows) FROM ${s.pacs}.Instance i WHERE i.SeriesKey = se.SeriesKey) AS height
FROM ${s.pacs}.Series se
JOIN ${s.pacs}.Study st ON st.StudyKey = se.StudyKey
WHERE se.StudyKey IN (${studiesOf})
ORDER BY st.StudyDateTime, se.SeriesNumber`,
    },
    {
      id: 'nodules',
      sources: ['pacs'],
      tables: ['NoduleFinding', 'Series'],
      sql: `
SELECT st.StudyInstanceUID AS study_uid, se.SeriesInstanceUID AS series_uid, n.NoduleLabel AS label,
       n.ReaderCount AS readers, n.DiameterMM AS diameter_mm, n.MaxDiameterMM AS max_diameter_mm, n.VolumeMM3 AS volume_mm3,
       n.Texture AS texture, n.Margin AS margin, n.Shape AS shape, n.Calcification AS calcification,
       n.MalignancyScore AS malignancy, n.SpiculationScore AS spiculation, n.Laterality AS laterality, n.Lobe AS lobe
FROM ${s.pacs}.NoduleFinding n
JOIN ${s.pacs}.Study st ON st.StudyKey = n.StudyKey
LEFT JOIN ${s.pacs}.Series se ON se.SeriesKey = n.SeriesKey
WHERE n.StudyKey IN (${studiesOf})
ORDER BY st.StudyDateTime, n.DiameterMM DESC`,
    },
    {
      id: 'showcase',
      sources: ['p360'],
      tables: ['p360_showcase'],
      sql: `
SELECT study_id, kind, section, date, atlas, title, subtitle, modality, description, note, subject, source, source_url,
       license, citation, folder, thumbnail, bytes, gigapixels
FROM ${s.p360}.p360_showcase WHERE patient_id = ${id} ORDER BY date`,
    },
    {
      id: 'showcaseParts',
      sources: ['p360'],
      tables: ['p360_showcase_part'],
      sql: `SELECT study_id, part, meta FROM ${s.p360}.p360_showcase_part WHERE patient_id = ${id} ORDER BY study_id, part`,
    },
    {
      id: 'viewer',
      sources: ['p360'],
      tables: ['p360_viewer_asset'],
      sql: `
SELECT series_uid, kind, folder, meta_json, bytes FROM ${s.p360}.p360_viewer_asset WHERE patient_id = ${id}`,
    },
    {
      id: 'documents',
      sources: ['documents'],
      tables: ['document_index', 'document_facts'],
      sql: `
SELECT di.DocumentId AS document_id, di.DocumentType AS type, di.Title AS title, di.Format AS format,
       di.IsScanned AS scanned, CAST(di.PAT_ENC_CSN_ID AS VARCHAR(20)) AS encounter_id, di.AccessionNumber AS accession,
       di.StudyInstanceUID AS study_uid, di.ServiceDateTime AS date, di.DocumentDateTime AS signed,
       di.AuthorName AS author, di.Department AS department, di.Campus AS campus, di.OneLakePath AS path,
       di.GroundTruthTextPath AS text_path, di.SizeBytes AS bytes, di.Words AS words,
       (SELECT COUNT(*) FROM ${s.docs}.document_facts f WHERE f.DocumentId = di.DocumentId) AS facts
FROM ${timed(d, n, 'document_index')} di
WHERE di.PAT_ID = ${id}
ORDER BY date`,
    },
  ];
}

/** The statement shown in Read in place: one patient's imaging, joining Epic, the PACS database and the documents. */
export function showcaseSql(n: Names): string {
  return epicQueries('tsql', n).find((q) => q.id === 'studies')!.sql.trim();
}

/**
 * An Epic patient's tumour genomes: the TCGA cases behind their biopsy slides (Patient360's p360_genome, from the
 * pathology crosswalk), in the genomics silo. Run only for patients the index flags with a genome.
 */
export function epicGenomeQueries(d: Dialect, n: Names): QueryDef[] {
  const s = sqlNames(n);
  const id = param(d, 'id');
  const cases = `SELECT g.tcga_barcode FROM ${s.p360}.p360_genome g WHERE g.patient_id = ${id}`;
  const q = (qid: string, table: string, sql: string): QueryDef => ({ id: qid, sources: ['p360', 'genomics'], tables: ['p360_genome', table], sql });
  return [
    {
      id: 'genomes',
      sources: ['p360', 'genomics'],
      tables: ['p360_genome', 'molecular_profile'],
      sql: `
SELECT g.tcga_barcode AS barcode, g.cohort, g.specimen, g.slide_series_uid, m.*
FROM ${s.p360}.p360_genome g                                         -- the biopsy slide's TCGA case
JOIN ${s.gen}.molecular_profile m ON m.patient_id = g.tcga_barcode    -- tumour genomics
WHERE g.patient_id = ${id}
ORDER BY g.ordinal`,
    },
    q('genomeMutations', 'somatic_mutation',
      `SELECT m.patient_id AS barcode, m.gene, m.protein_change, m.mutation_type, m.variant_type, m.chromosome, m.start_pos, m.vaf, m.is_driver_gene
       FROM ${s.gen}.somatic_mutation m WHERE m.patient_id IN (${cases})`),
    q('genomeSegments', 'copy_number_segment',
      `SELECT patient_id AS barcode, chromosome, start_pos, end_pos, segment_mean FROM ${s.gen}.copy_number_segment WHERE patient_id IN (${cases})`),
    q('genomeCopyNumber', 'gene_copy_number',
      `SELECT patient_id AS barcode, gene, alteration, "call", is_driver_gene FROM ${s.gen}.gene_copy_number WHERE patient_id IN (${cases})`),
    q('genomeExpression', 'gene_expression',
      `SELECT patient_id AS barcode, gene, z_score FROM ${s.gen}.gene_expression WHERE patient_id IN (${cases})`),
    q('genomeImmune', 'immune_cell_fraction',
      `SELECT patient_id AS barcode, cell_type, fraction FROM ${s.gen}.immune_cell_fraction WHERE patient_id IN (${cases})`),
    {
      id: 'genomeReference',
      sources: ['p360', 'genomics'],
      tables: ['p360_genome', 'cohort_reference', 'molecular_profile'],
      sql: `SELECT m.patient_id AS barcode, r.metric, r.n, r.quantiles_json FROM ${s.gen}.cohort_reference r
            JOIN ${s.gen}.molecular_profile m ON m.cohort_study = r.cohort_study WHERE m.patient_id IN (${cases})`,
    },
  ];
}

/** Queries a record can do without: the data requests (cohort apps) and the genomes (genomics silo). */
export const optional = (queryId: string) => queryId === 'cohorts' || queryId.startsWith('genome') || queryId.startsWith('showcase');

/** The genomes from epicGenomeQueries' rows, in the crosswalk's order. */
function epicGenomes(rows: Record<string, Row[]>): Genome[] {
  const of = (key: string, barcode: string) => (rows[key] ?? []).filter((r) => r.barcode === barcode);
  return (rows.genomes ?? []).map((p): Genome => {
    const barcode = String(p.barcode);
    const muts = of('genomeMutations', barcode);
    const counts = new Map<string, number>();
    for (const m of muts) counts.set(String(m.mutation_type), (counts.get(String(m.mutation_type)) ?? 0) + 1);
    const study = String(p.cohort_study ?? '').replace(/_tcga_pan_can_atlas_2018$/, '');
    return {
      barcode,
      cancer: STUDY_CANCER[study] ?? String(p.cohort ?? 'same-type'),
      slideSeriesUid: str(p.slide_series_uid),
      profile: { ...p, patient_id: barcode },
      drivers: muts.filter((m) => Number(m.is_driver_gene) === 1).sort((a, b) => (num(b.vaf) ?? -1) - (num(a.vaf) ?? -1)),
      mutationMap: mutationMap(muts),
      mutationCounts: [...counts].map(([mutation_type, n]) => ({ mutation_type, n })).sort((a, b) => b.n - a.n),
      segments: of('genomeSegments', barcode),
      copyNumber: of('genomeCopyNumber', barcode),
      expression: of('genomeExpression', barcode),
      immuneCells: of('genomeImmune', barcode),
      reference: of('genomeReference', barcode),
    };
  });
}

/* ================================================================== assembling an Epic patient */

const str = (v: Cell | undefined) => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: Cell | undefined) => {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

const ACRONYMS = new Set([
  'CT', 'MRI', 'MR', 'XR', 'US', 'ECG', 'EKG', 'HIV', 'COPD', 'BMI', 'LDL', 'HDL', 'BUN', 'AST', 'ALT', 'MCV', 'MCH',
  'MCHC', 'RDW', 'MPV', 'PDW', 'WBC', 'RBC', 'TNM', 'PSA', 'DNA', 'RNA', 'ICU', 'ED', 'II', 'III', 'IV', 'COVID-19',
  'SARS-COV-2', 'HPV', 'MMR', 'DTAP', 'TDAP', 'IPV', 'HIB', 'PPD', 'INR', 'TSH', 'A1C', 'EGFR', 'CO2', 'PH',
]);

/** "COMBINED CHEMOTHERAPY AND RADIATION THERAPY" -> "Combined chemotherapy and radiation therapy". */
export function sentence(text: string | null | undefined): string {
  if (!text) return '';
  if (/[a-z]/.test(text)) return text;
  const words = text.toLowerCase().split(/(\s+|\/|-(?=[A-Za-z]))/);
  const out = words.map((w) => (ACRONYMS.has(w.toUpperCase().replace(/[,;:.()]/g, '')) ? w.toUpperCase() : w)).join('');
  // Brand names, as in "[Epogen]"
  const branded = out.replace(/\[([^\]]+)\]/g, (_, b: string) => `[${b.replace(/\b\w/g, (c) => c.toUpperCase())}]`);
  return branded.charAt(0).toUpperCase() + branded.slice(1);
}


/** Campus codes in department names (CMC PRIMARY CARE). */
const CAMPUS = /^(CMC|CBH|CWH|CSC|CCH|CCI|CNS)\b/;

/** "BOTSFORD, SONDRA" -> "Sondra Botsford"; "CONTOSO MEDICAL CENTER" -> "Contoso Medical Center"; departments keep the campus code. */
export function properName(text: string | null | undefined, kind: 'person' | 'place' = 'place'): string | null {
  if (!text) return null;
  if (/[a-z]/.test(text)) return text;
  const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(And|Of|The|For)\b/g, (w) => w.toLowerCase());
  if (kind === 'person') {
    const [last, first] = text.split(/,\s*/);
    const name = first ? `${first} ${last}` : last;
    return title(name).replace(/\b(Md|Do|Np|Pa|Rn)\b/g, (w) => w.toUpperCase());
  }
  const campus = CAMPUS.exec(text)?.[0];
  return campus ? `${campus} ${title(text.slice(campus.length).trim())}` : title(text);
}

/** Epic visit types and patient classes, as the visit classes the timeline draws (lib/clinical.ts VISIT_CLASS). */
export function visitClass(encounterType: string | null, patientClass: string | null): string {
  if (encounterType === 'Hospital Encounter') {
    if (patientClass === 'Emergency') return 'emergency';
    if (patientClass === 'Inpatient' || patientClass === 'Observation') return 'inpatient';
    return 'outpatient';
  }
  switch (encounterType) {
    case 'Preventive Care Visit':
      return 'wellness';
    case 'Office Visit':
      return 'ambulatory';
    case 'Hospital Outpatient Visit':
      return 'outpatient';
    case 'Urgent Care':
      return 'urgentcare';
    case 'Telemedicine':
      return 'virtual';
    case 'Documentation':
      return 'documentation';
    default:
      return 'ambulatory';
  }
}

/**
 * LOINC display names for the results and flowsheet rows in Clarity. The record's vocabulary (src/lib/clinical.ts)
 * names, groups and gives reference ranges by these; the Epic name travels with each row as epic_name.
 */
export const LOINC_NAMES: Record<string, string> = {
  '8302-2': 'Body Height', '29463-7': 'Body Weight', '39156-5': 'Body mass index (BMI) [Ratio]',
  '8480-6': 'Systolic Blood Pressure', '8462-4': 'Diastolic Blood Pressure', '8867-4': 'Heart rate',
  '9279-1': 'Respiratory rate', '8310-5': 'Body temperature', '2708-6': 'Oxygen saturation in Arterial blood',
  '72514-3': 'Pain severity - 0-10 verbal numeric rating [Score] - Reported',
  '9843-4': 'Head Occipital-frontal circumference', '77606-2': 'Weight-for-length Per age and sex',
  '59576-9': 'Body mass index (BMI) [Percentile] Per age and sex', '72166-2': 'Tobacco smoking status',
  '71802-3': 'Housing status', '4548-4': 'Hemoglobin A1c/Hemoglobin.total in Blood',
  '2339-0': 'Glucose [Mass/volume] in Blood', '6299-2': 'Urea nitrogen [Mass/volume] in Blood',
  '38483-4': 'Creatinine [Mass/volume] in Blood',
  '33914-3': 'Glomerular filtration rate/1.73 sq M.predicted [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (MDRD)',
  '2947-0': 'Sodium [Moles/volume] in Blood', '6298-4': 'Potassium [Moles/volume] in Blood',
  '2069-3': 'Chloride [Moles/volume] in Blood', '20565-8': 'Carbon dioxide  total [Moles/volume] in Blood',
  '49765-1': 'Calcium [Mass/volume] in Blood', '2885-2': 'Protein [Mass/volume] in Serum or Plasma',
  '1751-7': 'Albumin [Mass/volume] in Serum or Plasma', '10834-0': 'Globulin [Mass/volume] in Serum by calculation',
  '1975-2': 'Bilirubin.total [Mass/volume] in Serum or Plasma',
  '6768-6': 'Alkaline phosphatase [Enzymatic activity/volume] in Serum or Plasma',
  '1742-6': 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma',
  '1920-8': 'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma',
  '2093-3': 'Cholesterol [Mass/volume] in Serum or Plasma',
  '18262-6': 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by Direct assay',
  '2085-9': 'Cholesterol in HDL [Mass/volume] in Serum or Plasma', '2571-8': 'Triglycerides',
  '718-7': 'Hemoglobin [Mass/volume] in Blood', '4544-3': 'Hematocrit [Volume Fraction] of Blood by Automated count',
  '6690-2': 'Leukocytes [#/volume] in Blood by Automated count', '789-8': 'Erythrocytes [#/volume] in Blood by Automated count',
  '787-2': 'MCV [Entitic volume] by Automated count', '785-6': 'MCH [Entitic mass] by Automated count',
  '786-4': 'MCHC [Mass/volume] by Automated count', '21000-5': 'Erythrocyte [DistWidth] in Blood by Automated count',
  '777-3': 'Platelets [#/volume] in Blood by Automated count',
  '32207-3': 'Platelet distribution width [Entitic volume] in Blood by Automated count',
  '32623-1': 'Platelet [Entitic mean volume] in Blood by Automated count',
  '14959-1': 'Microalbumin/Creatinine [Mass Ratio] in Urine', '5767-9': 'Appearance of Urine',
  '5803-2': 'pH of Urine by Test strip', '5792-7': 'Glucose [Presence] in Urine by Test strip',
  '5794-3': 'Hemoglobin [Presence] in Urine by Test strip', '5799-2': 'Leukocyte esterase [Presence] in Urine by Test strip',
  '2514-8': 'Ketones [Presence] in Urine by Test strip', '32167-9': 'Clarity of Urine',
};

/** LOINC codes of the flowsheet rows that carry the cancer course. */
export const CANCER_LOINC: Record<string, string> = {
  '21908-9': 'stage',
  '21905-5': 'T',
  '21906-3': 'N',
  '21907-1': 'M',
  '88040-1': 'response',
  '59557-9': 'treatment_status',
  '44667-4': 'metastasis_site',
};

/** A cancer on the problem list: ICD-10 C (malignant) or D0 (in situ), or named as one; never a suspicion. */
const isCancer = (name: string | null, icd10: string | null) =>
  !/suspected/i.test(name ?? '') &&
  (!!(icd10 && /^(C|D0)/.test(icd10)) || /malignant|carcinoma|lymphoma|leukemia|leukaemia|melanoma/i.test(name ?? ''));
const CANCER_PROCEDURE = /chemotherapy|radiation|radiotherapy|brachytherapy|excision|resection|mastectomy|lumpectomy|lobectomy|colectomy|prostatectomy|biopsy|teleradiotherapy|ablation/i;
const CANCER_DRUG_CLASS = /antineoplastic/i;

function iso(v: Cell | undefined): string | null {
  const s = str(v);
  return s ? s.slice(0, 10) : null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Builds the record bundle the UI reads from the rows of epicQueries(). The shape follows the reference app's
 * (encounters, observations, conditions, medications, diagnoses, treatments, ...), so its timeline and tabs work;
 * Epic's own names and codes travel with each row.
 */
export function assembleEpic(rows: Record<string, Row[]>, access: PatientBundle['access'], provenance: Provenance): PatientBundle {
  const patient: Row = { ...(rows.patient[0] ?? {}) };
  const index = rows.index[0] ?? null;

  const encounters = rows.encounters.map((e): Row => ({
    ...e,
    encounter_class: visitClass(str(e.encounter_type), str(e.patient_class)),
    description: str(e.encounter_type) === 'Hospital Encounter' && e.patient_class ? `${str(e.patient_class)} stay` : str(e.encounter_type),
    duration_minutes:
      e.start && e.stop ? Math.max(0, Math.round((Date.parse(String(e.stop)) - Date.parse(String(e.start))) / 60_000)) : null,
    reason: sentence(str(e.reason)) || null,
    provider: properName(str(e.provider), 'person'),
    department: properName(str(e.department)),
    organization: properName(str(e.organization)),
    synthetic: true,
  }));

  // Results and flowsheet values as one list of observations; blood pressure is stored as "120/80" in one row.
  const observations: Row[] = [];
  for (const r of rows.labs) {
    observations.push({ ...r, name: LOINC_NAMES[str(r.code) ?? ''] ?? sentence(str(r.epic_name)), source: 'Clarity ORDER_RESULTS', synthetic: true });
  }
  const cancerFacts: Row[] = [];
  for (const r of rows.vitals) {
    const code = str(r.code) ?? '';
    if (CANCER_LOINC[code]) {
      cancerFacts.push({ ...r, fact: CANCER_LOINC[code] });
      continue;
    }
    const text = str(r.value_text);
    if (code.includes('/') && text && /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(text)) {
      const [sys, dia] = text.split('/').map(Number);
      const [c1, c2] = code.split('/');
      observations.push({ ...r, category: 'vital-signs', name: LOINC_NAMES[c1] ?? 'Systolic Blood Pressure', code: c1, value: sys, value_text: null, units: 'mm[Hg]', source: 'Clarity flowsheets', synthetic: true });
      observations.push({ ...r, category: 'vital-signs', name: LOINC_NAMES[c2] ?? 'Diastolic Blood Pressure', code: c2, value: dia, value_text: null, units: 'mm[Hg]', source: 'Clarity flowsheets', synthetic: true });
      continue;
    }
    const category = /SMOKING|ORIENTATION|HOUSING|ABUSE|HIV|INSURANCE|VISIT HISTORY/i.test(str(r.epic_name) ?? '') ? 'survey' : 'vital-signs';
    observations.push({ ...r, category, name: LOINC_NAMES[code] ?? sentence(str(r.display_name) ?? str(r.epic_name)), source: 'Clarity flowsheets', synthetic: true });
  }
  observations.sort((a, z) => String(a.date ?? '').localeCompare(String(z.date ?? '')));

  const conditions = rows.conditions.map((c): Row => ({
    ...c,
    description: sentence(str(c.description)),
    source: 'Clarity PROBLEM_LIST',
    synthetic: true,
  }));
  const medications = rows.medications.map((m): Row => ({
    ...m,
    description: sentence(str(m.epic_name)),
    reason: sentence(str(m.reason)) || null,
    prescriber: properName(str(m.prescriber), 'person'),
    synthetic: true,
  }));
  const procedures = rows.procedures
    .filter((p) => !p.accession)
    .map((p): Row => ({ ...p, description: sentence(str(p.epic_name)), reason: sentence(str(p.reason)) || null, synthetic: true }));

  // ---- Cancer course, when the problem list has a cancer: the first one anchors the course.
  const cancers = conditions.filter((c) => isCancer(str(c.description), str(c.icd10)));
  cancers.sort((a, z) => String(a.onset ?? '').localeCompare(String(z.onset ?? '')));
  const dxDate = iso(cancers[0]?.onset);
  const lastContact =
    [...encounters.map((e) => iso(e.start)), ...rows.studies.map((s) => iso(s.date)), ...rows.documents.map((d) => iso(d.date))]
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null;
  const death = iso(patient.death_date);
  const stageRows = cancerFacts.filter((f) => f.fact === 'stage' && str(f.value_text));
  const tnm = ['T', 'N', 'M']
    .map((k) => cancerFacts.find((f) => f.fact === k && str(f.value_text)))
    .filter(Boolean)
    .map((f) => str(f!.value_text))
    .join(' ');

  const diagnoses: Row[] = [];
  const followUps: Row[] = [];
  const treatments: Row[] = [];
  if (dxDate) {
    cancers.forEach((c, i) =>
      diagnoses.push({
        day: daysBetween(dxDate, iso(c.onset)!),
        classification: i === 0 ? 'Primary' : 'Subsequent primary',
        primary_diagnosis: str(c.description),
        icd10: str(c.icd10),
        site: null,
        date: iso(c.onset),
        resolved: iso(c.resolved),
      })
    );
    for (const f of cancerFacts.filter((x) => x.fact === 'metastasis_site' && str(x.value_text))) {
      diagnoses.push({ day: daysBetween(dxDate, iso(f.date)!), classification: 'Metastasis', site: str(f.value_text), primary_diagnosis: null, date: iso(f.date) });
    }
    for (const f of cancerFacts.filter((x) => x.fact === 'response' && str(x.value_text))) {
      followUps.push({ day: daysBetween(dxDate, iso(f.date)!), disease_response: str(f.value_text), timepoint: 'Treatment response', evidence: 'Clarity flowsheet', date: iso(f.date) });
    }
    // Orders for the same drug, or sessions of the same procedure, less than 45 days apart are one course.
    const courses = new Map<string, { type: string; agent: string | null; site: string | null; source: string; spans: { start: string; end: string; orders: string[] }[] }>();
    const addCourse = (key: string, base: { type: string; agent: string | null; site: string | null; source: string }, start: string, end: string, order: string) => {
      const c = courses.get(key) ?? { ...base, spans: [] };
      courses.set(key, c);
      const last = c.spans[c.spans.length - 1];
      if (last && daysBetween(last.end, start) <= 45) {
        if (end > last.end) last.end = end;
        last.orders.push(order);
      } else c.spans.push({ start, end, orders: [order] });
    };
    const byStart = (a: Row, z: Row) => String(a.start ?? a.date ?? '').localeCompare(String(z.start ?? z.date ?? ''));
    for (const m of medications.filter((x) => CANCER_DRUG_CLASS.test(str(x.therapeutic_class) ?? '')).sort(byStart)) {
      const start = iso(m.start);
      if (!start) continue;
      const agent = sentence(str(m.generic_name));
      const hormone = /leuprolide|exemestane|anastrozole|letrozole|tamoxifen|bicalutamide|goserelin|degarelix|enzalutamide|abiraterone/i.test(agent);
      addCourse(`d:${agent}`, { type: hormone ? 'Hormone Therapy' : 'Chemotherapy', agent, site: null, source: 'Clarity ORDER_MED' }, start, iso(m.stop) ?? start, str(m.order_id) ?? '');
    }
    for (const p of [...procedures].sort(byStart)) {
      const name = str(p.epic_name) ?? '';
      if (!CANCER_PROCEDURE.test(name) || /biopsy/i.test(name)) continue;
      const start = iso(p.date);
      if (!start) continue;
      const radiation = /radiation|radiotherapy|brachy/i.test(name);
      addCourse(`p:${name}`, { type: radiation ? 'Radiation Therapy' : 'Surgery', agent: null, site: sentence(name), source: 'Clarity ORDER_PROC' }, start, start, str(p.order_id) ?? '');
    }
    for (const c of courses.values()) {
      for (const s of c.spans) {
        treatments.push({
          given: true,
          treatment_type: c.type,
          agent: c.agent,
          anatomic_site: c.site,
          start_date: s.start,
          end_date: s.end > s.start ? s.end : null,
          outcome: null,
          orders: s.orders.length,
          order_ids: s.orders.join(','),
          source: c.source,
        });
      }
    }
    treatments.sort((a, z) => String(a.start_date).localeCompare(String(z.start_date)));
  }
  Object.assign(patient, {
    pcp: properName(str(patient.pcp), 'person'),
    vital_status: death ? 'Dead' : 'Alive',
    diagnosis_date: dxDate,
    cancer_type: cancers[0] ? str(cancers[0].description) : null,
    cancers: cancers.map((c) => str(c.description)).join('; ') || null,
    stage: stageRows.length ? str(stageRows[stageRows.length - 1].value_text) : null,
    tnm: tnm || null,
    last_contact_date: death ?? lastContact,
    age: num(index?.age),
    age_at_diagnosis: dxDate && patient.birth_date ? Math.floor(daysBetween(iso(patient.birth_date)!, dxDate) / 365.25) : null,
    days_to_last_contact: dxDate && lastContact ? daysBetween(dxDate, lastContact) : null,
    tcga_barcode: str(index?.tcga_barcode),
    lidc_subject: str(index?.lidc_subject),
  });

  // ---- Imaging: studies from the PACS index; slides are the SM series, everything else radiology. Series with
  // viewer files (scripts/25_patient360_viewers.py) carry where they are and what they hold.
  const viewer = new Map((rows.viewer ?? []).map((v) => [str(v.series_uid), v]));
  const metaOf = (uid: Cell | undefined): Record<string, unknown> | null => {
    const v = viewer.get(str(uid ?? null));
    try {
      return v ? (JSON.parse(String(v.meta_json)) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const folderOf = (uid: Cell | undefined) => str(viewer.get(str(uid ?? null))?.folder);
  const series = rows.series;
  const studies = rows.studies.map((st): Row => ({ ...st, description: str(st.description), date: str(st.date) }));
  const isSlide = (s: Row) => /SM/.test(str(s.modalities) ?? '') || str(s.modality) === 'SM';
  const slideSeries = series.filter((s) => str(s.modality) === 'SM');
  const genomes = epicGenomes(rows);
  const slides = slideSeries.map((s, i) => {
    const st = studies.find((x) => x.study_uid === s.study_uid);
    const meta = metaOf(s.series_uid);
    const folder = folderOf(s.series_uid);
    return {
      ...s,
      ...(meta && folder
        ? {
            tile_root: folder,
            thumbnail_path: `${folder}/${String(meta.thumbnail)}`,
            levels: meta.levels as number,
            tile_count: meta.tileCount as number,
            mpp: (meta.mpp as number) ?? null,
            objective_power: (meta.objectivePower as number) ?? null,
            raw_bytes: meta.rawBytes as number,
            width: (meta.width as number) ?? s.width,
            height: (meta.height as number) ?? s.height,
          }
        : {}),
      slide_id: str(s.series_uid),
      role: 'diagnostic',
      sort_order: i,
      date: iso(st?.date),
      specimen: sentence(str(st?.description)),
      accession: str(st?.accession),
      barcode: str(st?.source_collection),
      report_id: str(st?.report_id),
      // The TCGA case whose tumour this slide is, when the genomics silo has its genome.
      genome: genomes.find((g) => g.slideSeriesUid === s.series_uid)?.barcode ?? null,
    } as Row;
  });
  const radiologyStudies = studies
    .filter((s) => !isSlide(s))
    .map((s): Row => ({
      ...s,
      date: iso(s.date),
      nodules: rows.nodules.filter((n) => n.study_uid === s.study_uid).length,
    }));
  const radiologySeries = series
    .filter((s) => !['SM', 'SEG', 'SR'].includes(str(s.modality) ?? ''))
    .map((s): Row => {
      const date = iso(studies.find((x) => x.study_uid === s.study_uid)?.date);
      const meta = metaOf(s.series_uid);
      const folder = folderOf(s.series_uid);
      const known = (v: Cell | undefined) => (str(v) && str(v)!.toUpperCase() !== 'UNKNOWN' ? str(v) : null);
      const base: Row = {
        ...s,
        description: known(s.description),
        manufacturer: known(s.manufacturer),
        model: known(s.model),
        date,
        day: dxDate && date ? daysBetween(dxDate, date) : null,
        epic: true,
        raw_bytes: (num(s.size_mb) ?? 0) * 1e6,
        raw_files: num(s.instances),
      };
      if (!meta || !folder) return base;
      if (meta.volume) {
        const nodules = (meta.nodules ?? {}) as Record<string, unknown>;
        return {
          ...base,
          series_key: folder.split('/').pop() ?? null,
          volume_path: `${folder}/${String(meta.volume)}`,
          labels_path: meta.labels ? `${folder}/${String(meta.labels)}` : null,
          labels_lut_path: meta.labelsLut ? `${folder}/${String(meta.labelsLut)}` : null,
          labels_kind: 'radiologists',
          ai_measures: Object.keys(nodules).length ? JSON.stringify(nodules) : null,
          ai_algorithm: Object.keys(nodules).length ? 'A voxel is included when at least half of the LIDC radiologists who outlined the nodule drew it.' : null,
          volume_bytes: num(viewer.get(str(s.series_uid))?.bytes),
          dims: meta.dims ? JSON.stringify(meta.dims) : null,
          spacing_mm: meta.spacingMm ? JSON.stringify(meta.spacingMm) : null,
          images: (meta.images as number) ?? num(s.instances),
          slice_thickness_mm: (meta.sliceThicknessMm as number) ?? num(s.slice_mm),
          thumbnail_path: `${folder}/${String(meta.thumbnail)}`,
          geometry_assumed: !!meta.geometryAssumed,
        };
      }
      if (Array.isArray(meta.images)) {
        return { ...base, xray_folder: folder, xray_images: JSON.stringify(meta.images) };
      }
      return base;
    });

  const pathologyReport = rows.documents.find((d) => d.type === 'Pathology Report');

  return {
    source: 'epic',
    patient,
    index,
    header: {
      patient_id: patient.patient_id,
      display_name: patient.display_name,
      observations: observations.length,
      slide_count: slides.length,
      radiology_studies: radiologyStudies.length,
    },
    diagnoses,
    treatments,
    followUps,
    biomarkers: [],
    observations,
    encounters,
    conditions,
    medications,
    immunizations: [],
    allergies: [],
    procedures,
    careplans: [],
    report: {
      text: '',
      pdfPath: pathologyReport && pathologyReport.scanned ? str(pathologyReport.path) : null,
      pdfBytes: pathologyReport ? num(pathologyReport.bytes) : null,
      gdcFileId: null,
      source: pathologyReport ? str(pathologyReport.document_id) : null,
    },
    summary: null,
    ...genomeFields(genomes[0]),
    genomes,
    slide: slides[0] ?? null,
    slides,
    radiologyStudies,
    radiologySeries,
    studies,
    nodules: rows.nodules,
    documents: rows.documents,
    visitDiagnoses: rows.visitDiagnoses.map((v): Row => ({ ...v, description: sentence(str(v.description)) })),
    cohorts: rows.cohorts ?? [],
    showcase: (rows.showcase ?? []).map((r) => ({
      ...r,
      date: iso(r.date),
      meta_json: (rows.showcaseParts ?? [])
        .filter((p) => p.study_id === r.study_id)
        .sort((a, z) => Number(a.part) - Number(z.part))
        .map((p) => String(p.meta ?? ''))
        .join(''),
    })),
    access,
    provenance,
  };
}

/* ================================================================== one document */

export function documentSql(d: Dialect, n: Names): { doc: string; facts: string } {
  const s = sqlNames(n);
  const id = param(d, 'doc');
  return {
    doc: `
SELECT di.DocumentId AS document_id, di.DocumentType AS type, di.Title AS title, di.Format AS format,
       di.IsScanned AS scanned, di.PAT_ID AS patient_id, di.Mrn AS mrn, di.AccessionNumber AS accession,
       di.StudyInstanceUID AS study_uid, di.ServiceDateTime AS date, di.DocumentDateTime AS signed,
       di.AuthorName AS author, di.Department AS department, di.Campus AS campus, di.OneLakePath AS path,
       di.GroundTruthTextPath AS text_path, di.SizeBytes AS bytes, di.Words AS words
FROM ${timed(d, n, 'document_index')} di WHERE di.DocumentId = ${id}`,
    facts: `
SELECT f.FactNumber AS n, f.FactType AS type, f.Text AS text, f.Code AS code, f.Value AS value, f.Unit AS unit,
       f.Site AS site, f.Laterality AS laterality, f.System AS code_system
FROM ${s.docs}.document_facts f WHERE f.DocumentId = ${id} ORDER BY f.FactNumber`,
  };
}

/** The DICOM files of one series in the archive, for viewers that read DICOM in the browser. */
export function seriesFilesSql(d: Dialect, n: Names): string {
  const s = sqlNames(n);
  return `
SELECT i.SOPInstanceUID AS sop_uid, i.InstanceNumber AS instance_number, i.ImagePositionZ AS z, i.StoragePath AS path,
       i.FileSizeBytes AS bytes, i.NumberOfFrames AS frames, i.TotalPixelMatrixColumns AS width, i.TotalPixelMatrixRows AS height,
       i.SOPClassName AS sop_class, i.ImageType AS image_type, i.TransferSyntaxUID AS transfer_syntax
FROM ${s.pacs}.Instance i
JOIN ${s.pacs}.Series se ON se.SeriesKey = i.SeriesKey
JOIN ${s.pacs}.Study st ON st.StudyKey = se.StudyKey
JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey
WHERE se.SeriesInstanceUID = ${param(d, 'series')} AND pp.PatientID = ${param(d, 'mrn')}
ORDER BY i.ImagePositionZ, i.InstanceNumber`;
}

/* ================================================================== one oncology research patient (TCGA) */

/**
 * The fifteen TCGA patients imported from the reference app keep its three silos and schemas: the registry and
 * synthetic primary care (Bronze_Oncology_Clinical), the tumour genome (Bronze_Oncology_Genomics) and the slides and
 * scans (Bronze_Oncology_Imaging). These are the reference app's queries, pointed at those items.
 */
export function researchQueries(d: Dialect, n: Names): QueryDef[] {
  const s = sqlNames(n);
  const id = param(d, 'id');
  const where = `WHERE patient_id = ${id}`;
  const q = (qid: string, source: SourceId, table: string, sql: string): QueryDef => ({ id: qid, sources: [source], tables: [table], sql });
  return [
    {
      id: 'header',
      sources: ['oncology', 'genomics', 'research_imaging'],
      tables: ['patient', 'molecular_profile', 'pathology_slide', 'radiology_study', 'radiology_series', 'observation'],
      sql: `
SELECT p.patient_id, p.display_name, p.cancer_type, p.stage, p.vital_status,
       m.subtype, m.tmb, m.tmb_percentile, m.msi_status, m.mutation_count,
       sl.width, sl.height, sl.tile_count, sl.raw_bytes AS slide_raw_bytes,
       (SELECT COUNT(*) FROM ${s.rimg}.pathology_slide x WHERE x.patient_id = p.patient_id) AS slide_count,
       (SELECT COUNT(*) FROM ${s.rimg}.radiology_study r WHERE r.patient_id = p.patient_id) AS radiology_studies,
       (SELECT SUM(raw_bytes) FROM ${s.rimg}.radiology_series r WHERE r.patient_id = p.patient_id) AS radiology_raw_bytes,
       (SELECT COUNT(*) FROM ${s.onc}.observation o WHERE o.patient_id = p.patient_id) AS observations
FROM ${s.onc}.patient p                                               -- oncology registry
JOIN ${s.gen}.molecular_profile m ON m.patient_id = p.patient_id      -- tumour genomics
JOIN ${s.rimg}.pathology_slide sl ON sl.patient_id = p.patient_id AND sl.role = 'diagnostic'  -- research imaging
WHERE p.patient_id = ${id}`,
    },
    q('patient', 'oncology', 'patient', `SELECT * FROM ${s.onc}.patient ${where}`),
    q('index', 'p360', 'p360_patient', `SELECT * FROM ${s.p360}.p360_patient ${where}`),
    q('diagnoses', 'oncology', 'diagnosis', `SELECT * FROM ${s.onc}.diagnosis ${where} ORDER BY day`),
    q('treatments', 'oncology', 'treatment', `SELECT * FROM ${s.onc}.treatment ${where} ORDER BY start_day`),
    q('followUps', 'oncology', 'follow_up', `SELECT * FROM ${s.onc}.follow_up ${where} ORDER BY day`),
    q('biomarkers', 'oncology', 'biomarker_test', `SELECT * FROM ${s.onc}.biomarker_test ${where} ORDER BY day`),
    q('observations', 'oncology', 'observation',
      `SELECT date, encounter_id, category, name, value, value_text, units, source, synthetic FROM ${s.onc}.observation ${where} ORDER BY date`),
    q('encounters', 'oncology', 'encounter',
      `SELECT encounter_id, start, stop, duration_minutes, encounter_class, description, reason, provider, provider_specialty,
              organization, payer, total_cost, payer_coverage FROM ${s.onc}.encounter ${where} ORDER BY start`),
    q('conditions', 'oncology', 'condition',
      `SELECT encounter_id, onset, resolved, description, source, synthetic FROM ${s.onc}.condition ${where} ORDER BY onset`),
    q('medications', 'oncology', 'medication',
      `SELECT encounter_id, start, stop, description, reason, dispenses, total_cost FROM ${s.onc}.medication ${where} ORDER BY start`),
    q('immunizations', 'oncology', 'immunization', `SELECT encounter_id, date, description FROM ${s.onc}.immunization ${where} ORDER BY date`),
    q('allergies', 'oncology', 'allergy', `SELECT encounter_id, onset, description, category, reaction, severity FROM ${s.onc}.allergy ${where}`),
    q('procedures', 'oncology', 'procedure', `SELECT encounter_id, date, description, reason FROM ${s.onc}."procedure" ${where} ORDER BY date`),
    q('careplans', 'oncology', 'careplan', `SELECT encounter_id, start, stop, description, reason FROM ${s.onc}.careplan ${where} ORDER BY start`),
    q('report', 'oncology', 'pathology_report', `SELECT * FROM ${s.onc}.pathology_report ${where} ORDER BY part`),
    q('summary', 'oncology', 'patient_summary', `SELECT * FROM ${s.onc}.patient_summary ${where}`),
    q('profile', 'genomics', 'molecular_profile', `SELECT * FROM ${s.gen}.molecular_profile ${where}`),
    q('drivers', 'genomics', 'somatic_mutation',
      `SELECT gene, protein_change, mutation_type, variant_type, chromosome, start_pos, vaf FROM ${s.gen}.somatic_mutation ${where} AND is_driver_gene = 1 ORDER BY vaf DESC`),
    q('mutationPositions', 'genomics', 'somatic_mutation', `SELECT chromosome, start_pos, mutation_type FROM ${s.gen}.somatic_mutation ${where}`),
    q('mutationCounts', 'genomics', 'somatic_mutation',
      `SELECT mutation_type, COUNT(*) AS n FROM ${s.gen}.somatic_mutation ${where} GROUP BY mutation_type ORDER BY n DESC`),
    q('segments', 'genomics', 'copy_number_segment', `SELECT chromosome, start_pos, end_pos, segment_mean FROM ${s.gen}.copy_number_segment ${where}`),
    q('copyNumber', 'genomics', 'gene_copy_number', `SELECT gene, alteration, "call", is_driver_gene FROM ${s.gen}.gene_copy_number ${where}`),
    q('expression', 'genomics', 'gene_expression', `SELECT gene, z_score FROM ${s.gen}.gene_expression ${where}`),
    q('immuneCells', 'genomics', 'immune_cell_fraction', `SELECT cell_type, fraction FROM ${s.gen}.immune_cell_fraction ${where}`),
    {
      id: 'reference',
      sources: ['genomics'],
      tables: ['cohort_reference', 'molecular_profile'],
      sql: `SELECT r.metric, r.n, r.quantiles_json FROM ${s.gen}.cohort_reference r
            JOIN ${s.gen}.molecular_profile m ON m.cohort_study = r.cohort_study WHERE m.patient_id = ${id}`,
    },
    q('slides', 'research_imaging', 'pathology_slide', `SELECT * FROM ${s.rimg}.pathology_slide ${where} ORDER BY sort_order`),
    q('radiologyStudies', 'research_imaging', 'radiology_study', `SELECT * FROM ${s.rimg}.radiology_study ${where} ORDER BY date`),
    q('radiologySeries', 'research_imaging', 'radiology_series', `SELECT * FROM ${s.rimg}.radiology_series ${where} ORDER BY date`),
  ];
}

export function assembleResearch(rows: Record<string, Row[]>, access: PatientBundle['access'], provenance: Provenance): PatientBundle {
  const report = rows.report;
  const reportRow = report[0] ?? null;
  const slides = rows.slides;
  const profile = rows.profile[0];
  const genome: Genome | undefined = profile && {
    barcode: String(profile.patient_id),
    cancer: str(rows.patient[0]?.cancer_type) ?? 'same-type',
    slideSeriesUid: null,
    profile,
    drivers: rows.drivers,
    mutationMap: mutationMap(rows.mutationPositions),
    mutationCounts: rows.mutationCounts,
    segments: rows.segments,
    copyNumber: rows.copyNumber,
    expression: rows.expression,
    immuneCells: rows.immuneCells,
    reference: rows.reference,
  };
  return {
    source: 'research',
    patient: rows.patient[0],
    index: rows.index[0] ?? null,
    header: rows.header[0] ?? {},
    diagnoses: rows.diagnoses,
    treatments: rows.treatments,
    followUps: rows.followUps,
    biomarkers: rows.biomarkers,
    observations: rows.observations,
    encounters: rows.encounters,
    conditions: rows.conditions,
    medications: rows.medications,
    immunizations: rows.immunizations,
    allergies: rows.allergies,
    procedures: rows.procedures,
    careplans: rows.careplans,
    report: {
      text: report.map((r) => String(r.report_text ?? '')).join(''),
      pdfPath: reportRow?.pdf_path ? String(reportRow.pdf_path) : null,
      pdfBytes: typeof reportRow?.pdf_bytes === 'number' ? reportRow.pdf_bytes : null,
      gdcFileId: reportRow?.gdc_file_id ? String(reportRow.gdc_file_id) : null,
      source: reportRow?.text_source ? String(reportRow.text_source) : null,
    },
    summary: rows.summary[0] ?? null,
    ...genomeFields(genome),
    genomes: genome ? [genome] : [],
    slide: slides.find((r) => r.role === 'diagnostic') ?? slides[0] ?? null,
    slides,
    radiologyStudies: rows.radiologyStudies,
    radiologySeries: rows.radiologySeries,
    studies: [],
    nodules: [],
    documents: [],
    visitDiagnoses: [],
    cohorts: [],
    showcase: [],
    access,
    provenance,
  };
}

/* ================================================================== counts across patients (Ask's query_records) */

export type QuerySpec = {
  subject: string;
  filters?: [string, string, Cell | Cell[]][];
  group_by?: string[];
  measure?: string;
  patient_ids?: string[];
  order?: 'asc' | 'desc';
  limit?: number;
};

/** Each subject is a row source with whitelisted fields (name -> SQL expression). */
function subjects(d: Dialect, n: Names): Record<string, { from: string; fields: Record<string, string> }> {
  const s = sqlNames(n);
  const pid = 'p.PAT_ID';
  // Each sequenced tumour's patient: a hospital patient through the slide crosswalk, or the research patient itself.
  const tumours = `(SELECT patient_id, tcga_barcode, 'hospital' AS source FROM ${s.p360}.p360_genome
     UNION ALL SELECT patient_id, patient_id, 'research' FROM ${s.p360}.p360_patient WHERE source = 'research')`;
  const study = (m: string) => `REPLACE(${m}.cohort_study, '_tcga_pan_can_atlas_2018', '')`;
  return {
    patients: {
      from: `${s.p360}.p360_patient x`,
      fields: {
        patient_id: 'x.patient_id', sex: 'x.sex', age: 'x.age', deceased: 'CASE WHEN x.death_date IS NULL THEN 0 ELSE 1 END',
        cancers: 'x.cancers', demo: 'CASE WHEN x.demo_order IS NULL THEN 0 ELSE 1 END', source: 'x.source',
        ct_online: 'x.ct_online', nodules: 'x.nodules', largest_nodule_mm: 'x.largest_nodule_mm', mr_online: 'x.mr_online',
        xray_online: 'x.xray_online', slides_online: 'x.slides_online', scanned_documents: 'x.scanned_documents',
        visits: 'x.visits', lab_results: 'x.lab_results', conditions: 'x.conditions',
      },
    },
    conditions: {
      from: `${s.clarity}.PROBLEM_LIST pl JOIN ${s.clarity}.CLARITY_EDG e ON e.DX_ID = pl.DX_ID`,
      fields: {
        patient_id: 'pl.PAT_ID', name: 'e.DX_NAME', icd10: 'e.CURRENT_ICD10_LIST', onset_year: 'YEAR(pl.NOTED_DATE)',
        active: 'CASE WHEN pl.RESOLVED_DATE IS NULL THEN 1 ELSE 0 END',
      },
    },
    medications: {
      from: `${s.clarity}.ORDER_MED o JOIN ${s.clarity}.CLARITY_MEDICATION m ON m.MEDICATION_ID = o.MEDICATION_ID`,
      fields: {
        patient_id: 'o.PAT_ID', name: 'm.NAME', generic: 'm.GENERIC_NAME', class: 'm.THERA_CLASS',
        pharm_class: 'm.PHARM_CLASS', start_year: 'YEAR(COALESCE(o.START_DATE, o.ORDERING_DATE))',
      },
    },
    labs: {
      from: `${timed(d, n, 'ORDER_RESULTS')} r JOIN ${s.clarity}.CLARITY_COMPONENT c ON c.COMPONENT_ID = r.COMPONENT_ID
             LEFT JOIN ${s.clarity}.ZC_RESULT_FLAG f ON f.RESULT_FLAG_C = r.RESULT_FLAG_C`,
      fields: {
        patient_id: 'r.PAT_ID', test: 'c.NAME', loinc: 'c.LOINC_CODE', value: 'r.ORD_NUM_VALUE',
        unit: 'r.REFERENCE_UNIT', year: 'YEAR(r.RESULT_TIME)', flag: 'f.NAME',
      },
    },
    visits: {
      from: `${s.clarity}.PAT_ENC e LEFT JOIN ${s.clarity}.ZC_DISP_ENC_TYPE t ON t.DISP_ENC_TYPE_C = e.ENC_TYPE_C
             LEFT JOIN ${s.clarity}.CLARITY_DEP d ON d.DEPARTMENT_ID = e.DEPARTMENT_ID`,
      fields: { patient_id: 'e.PAT_ID', type: 't.NAME', year: 'YEAR(e.CONTACT_DATE)', department: 'd.DEPARTMENT_NAME' },
    },
    studies: {
      from: `${s.pacs}.Study st JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey
             JOIN ${s.clarity}.PATIENT p ON p.PAT_MRN_ID = pp.PatientID`,
      fields: {
        patient_id: pid, modality: 'st.ModalitiesInStudy', description: 'st.StudyDescription', year: 'YEAR(st.StudyDateTime)',
        online: "CASE WHEN st.InstanceAvailability = 'ONLINE' THEN 1 ELSE 0 END", body_part: 'st.BodyPartExamined',
      },
    },
    nodules: {
      from: `${s.pacs}.NoduleFinding nf JOIN ${s.pacs}.Study st ON st.StudyKey = nf.StudyKey
             JOIN ${s.pacs}.Patient pp ON pp.PatientKey = st.PatientKey JOIN ${s.clarity}.PATIENT p ON p.PAT_MRN_ID = pp.PatientID`,
      fields: {
        patient_id: pid, diameter_mm: 'nf.DiameterMM', volume_mm3: 'nf.VolumeMM3', lobe: 'nf.Lobe', texture: 'nf.Texture',
        margin: 'nf.Margin', malignancy: 'nf.MalignancyScore', spiculation: 'nf.SpiculationScore', readers: 'nf.ReaderCount',
        year: 'YEAR(st.StudyDateTime)',
      },
    },
    documents: {
      from: `${timed(d, n, 'document_index')} di`,
      fields: {
        patient_id: 'di.PAT_ID', type: 'di.DocumentType', title: 'di.Title',
        scanned: 'CASE WHEN di.IsScanned = 1 THEN 1 ELSE 0 END', year: 'YEAR(di.ServiceDateTime)',
      },
    },
    genomes: {
      from: `${s.gen}.molecular_profile m JOIN ${tumours} g ON g.tcga_barcode = m.patient_id`,
      fields: {
        patient_id: 'g.patient_id', tcga_case: 'm.patient_id', cancer: study('m'), subtype: 'm.subtype', tmb: 'm.tmb',
        tmb_percentile: 'm.tmb_percentile', msi: 'm.msi_status', genome_altered: 'm.fraction_genome_altered',
        aneuploidy: 'm.aneuploidy_score', hrd: 'm.hrd_score', mutations: 'm.mutation_count',
        leukocyte_fraction: 'm.leukocyte_fraction', source: 'g.source',
      },
    },
    mutations: {
      from: `${s.gen}.somatic_mutation sm JOIN ${s.gen}.molecular_profile m ON m.patient_id = sm.patient_id
             JOIN ${tumours} g ON g.tcga_barcode = sm.patient_id`,
      fields: {
        patient_id: 'g.patient_id', tcga_case: 'sm.patient_id', cancer: study('m'), gene: 'sm.gene', protein_change: 'sm.protein_change',
        type: 'sm.mutation_type', driver: 'CASE WHEN sm.is_driver_gene = 1 THEN 1 ELSE 0 END', vaf: 'sm.vaf', source: 'g.source',
      },
    },
    copy_number: {
      from: `${s.gen}.gene_copy_number cn JOIN ${s.gen}.molecular_profile m ON m.patient_id = cn.patient_id
             JOIN ${tumours} g ON g.tcga_barcode = cn.patient_id`,
      fields: {
        patient_id: 'g.patient_id', tcga_case: 'cn.patient_id', cancer: study('m'), gene: 'cn.gene', call: 'cn."call"',
        driver: 'CASE WHEN cn.is_driver_gene = 1 THEN 1 ELSE 0 END', source: 'g.source',
      },
    },
  };
}

const OPS = new Set(['=', '!=', '>', '>=', '<', '<=', 'like', 'in']);

/** A structured query as SQL with parameters, or an error that tells the model what it may use. */
export function querySql(d: Dialect, n: Names, q: QuerySpec): { sql: string; params: Record<string, string | number> } | { error: string } {
  const subj = subjects(d, n)[q.subject];
  if (!subj) return { error: `subject must be one of ${Object.keys(subjects(d, n)).join(', ')}` };
  const fields = subj.fields;
  const field = (f: string) => fields[f];
  const params: Record<string, string | number> = {};
  let k = 0;
  const p = (v: Cell) => {
    const name = `p${k++}`;
    // Flags are 0 or 1 in every field, and models write them as true and false.
    params[name] = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : /^(true|false)$/i.test(String(v)) ? (/^true$/i.test(String(v)) ? 1 : 0) : String(v ?? '');
    return param(d, name);
  };
  const where: string[] = [];
  for (const f of q.filters ?? []) {
    if (!Array.isArray(f) || f.length < 3) return { error: 'each filter is [field, op, value]' };
    const [name, rawOp, value] = f;
    const op = String(rawOp).toLowerCase();
    if (!field(name)) return { error: `unknown field '${name}' for ${q.subject}; fields: ${Object.keys(fields).join(', ')}` };
    if (!OPS.has(op)) return { error: `op must be one of ${[...OPS].join(' ')}` };
    if (op === 'in') {
      const list = Array.isArray(value) ? value : [value as Cell];
      if (!list.length) return { error: "'in' needs a list" };
      where.push(`${field(name)} IN (${list.slice(0, 200).map((v) => p(v)).join(', ')})`);
    } else if (op === 'like') {
      where.push(like(d, field(name), p(`%${String(value).replace(/[%_]/g, '')}%`)));
    } else {
      where.push(`${field(name)} ${op === '!=' ? '<>' : op} ${p(value as Cell)}`);
    }
  }
  if (q.patient_ids?.length) where.push(`${field('patient_id')} IN (${q.patient_ids.slice(0, 200).map((v) => p(v)).join(', ')})`);
  const groups = (q.group_by ?? []).slice(0, 3);
  for (const g of groups) if (!field(g)) return { error: `unknown group_by field '${g}'; fields: ${Object.keys(fields).join(', ')}` };
  const m = q.measure || 'count_patients';
  let measure: string;
  if (m === 'count_patients') measure = `COUNT(DISTINCT ${field('patient_id')})`;
  else if (m === 'count_rows') measure = 'COUNT(*)';
  else {
    const [fn, f] = m.split(':');
    if (!['avg', 'min', 'max', 'sum'].includes(fn) || !f || !field(f)) return { error: 'measure is count_patients, count_rows, avg:<field>, min:<field>, max:<field> or sum:<field>' };
    measure = `${fn.toUpperCase()}(${fn === 'avg' ? `CAST(${field(f)} AS FLOAT)` : field(f)})`;
  }
  const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 50)));
  const select = [...groups.map((g) => `${field(g)} AS ${g}`), `${measure} AS value`].join(', ');
  const sql = `SELECT ${select}
FROM ${subj.from}
${where.length ? `WHERE ${where.join('\n  AND ')}` : ''}
${groups.length ? `GROUP BY ${groups.map(field).join(', ')}` : ''}
ORDER BY value ${q.order === 'asc' ? 'ASC' : 'DESC'}${groups.length ? `, ${groups.map(field).join(', ')}` : ''}
${page(d, 0, limit)}`;
  return { sql, params };
}
