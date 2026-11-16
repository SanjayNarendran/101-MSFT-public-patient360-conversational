/**
 * Local mode backend (`npm run dev:local`): the Rayfin functions run in DuckDB over data/generated, so the app
 * runs on a laptop with no Fabric capacity or sign-in.
 *
 * DuckDB attaches one in-memory catalog per Fabric item, named as in the workspace (Bronze_Clarity,
 * Bronze_PACS, Bronze_ClinicalDocuments, Patient360, and the oncology research silos), with views over the local
 * Parquet copies written by scripts/24_patient360_data.py. The SQL text is the functions' own
 * (rayfin/functions/src/record.ts); only parameters and paging differ by dialect.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

import type { DuckDBInstance } from '@duckdb/node-api';

import {
  assembleEpic,
  assembleResearch,
  DEFAULT_NAMES,
  documentSql,
  epicGenomeQueries,
  epicQueries,
  optional,
  PATIENT_ID,
  querySql,
  requestsSql,
  researchQueries,
  searchSql,
  seriesFilesSql,
  type Cell,
  type DocumentText,
  type FileAccess,
  type PatientBundle,
  type Provenance,
  type QuerySpec,
  type QueryTrace,
  type Row,
  type SearchRequest,
  type SearchResult,
  type SourceId,
} from '../rayfin/functions/src/record';

const N = DEFAULT_NAMES;
const ENDPOINT = 'DuckDB on this computer (data/generated/p360)';

/** The local folders standing in for each item's Files area, served under /local-files/<source>/. */
export function fileRoots(root: string): Partial<Record<SourceId, string>> {
  const gen = resolve(root, 'data', 'generated');
  return {
    documents: resolve(gen, 'documents'),
    p360: resolve(gen, 'p360', 'files'),
    oncology: resolve(gen, 'research', 'clinical', 'files'),
    research_imaging: resolve(gen, 'research', 'imaging', 'files'),
  };
}

/** Each catalog and the folder of Parquet files behind it. */
function catalogs(root: string): { catalog: string; schema: string; dir: string; source: SourceId }[] {
  const gen = resolve(root, 'data', 'generated');
  return [
    { catalog: N.clarity, schema: 'dbo', dir: resolve(gen, 'p360', 'bronze', 'clarity'), source: 'clarity' },
    { catalog: N.pacs, schema: 'pacs', dir: resolve(gen, 'p360', 'bronze', 'pacs'), source: 'pacs' },
    { catalog: N.documents, schema: 'dbo', dir: resolve(gen, 'p360', 'bronze', 'documents'), source: 'documents' },
    { catalog: N.p360, schema: 'dbo', dir: resolve(gen, 'p360'), source: 'p360' },
    { catalog: N.oncology, schema: 'dbo', dir: resolve(gen, 'research', 'clinical', 'tables'), source: 'oncology' },
    { catalog: N.genomics, schema: 'dbo', dir: resolve(gen, 'research', 'genomics', 'tables'), source: 'genomics' },
    { catalog: N.researchImaging, schema: 'dbo', dir: resolve(gen, 'research', 'imaging', 'tables'), source: 'research_imaging' },
    // Copies of the data requests and the i2b2 patient mapping (scripts/24_patient360_data.py)
    { catalog: N.requests, schema: 'crc', dir: resolve(gen, 'p360', 'bronze', 'requests'), source: 'requests' },
    { catalog: N.omop, schema: 'dbo', dir: resolve(gen, 'p360', 'bronze', 'omop'), source: 'omop' },
  ];
}

/** The approval app's address from this environment's state file (as scripts/common.py chooses it), or ''. */
function approvalUrl(root: string): string {
  try {
    const marker = resolve(root, 'config', '.cohort-env');
    const name = (process.env.COHORT_ENV || (existsSync(marker) ? readFileSync(marker, 'utf8') : '')).trim();
    const file = resolve(root, 'data', /^[A-Za-z0-9_-]+$/.test(name) ? `state.${name}.json` : 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8')) as { approval_app?: { url?: string } };
    return (state.approval_app?.url ?? '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ DuckDB */

function normalise(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) {
    const s = value.toISOString();
    return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s.slice(0, 19);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

class Tracer {
  readonly queries: QueryTrace[] = [];
  private readonly started = Date.now();

  constructor(private readonly db: DuckDBInstance) {}

  /** One connection per query, so a patient's queries run in parallel as they do on the SQL endpoint. */
  async run(id: string, sources: SourceId[], tables: string[], text: string, params: Record<string, string> = {}): Promise<Row[]> {
    const t0 = Date.now();
    const connection = await this.db.connect();
    try {
      // DuckDB rejects parameters a statement doesn't use, so pass only those it names.
      const used = Object.fromEntries(Object.entries(params).filter(([k]) => text.includes(`$${k}`)));
      const reader = await connection.runAndReadAll(text, used);
      const out = reader.getRowObjectsJS().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalise(v)])));
      this.queries.push({ id, sources, tables, rows: out.length, ms: Date.now() - t0 });
      return out;
    } finally {
      connection.closeSync();
    }
  }

  provenance(showcaseSql: string): Provenance {
    return {
      workspace: 'this computer (local mode)',
      endpoint: ENDPOINT,
      database: `${N.p360} (DuckDB catalogs named as the Fabric items)`,
      queries: this.queries,
      totalMs: Date.now() - this.started,
      showcaseSql: showcaseSql.trim(),
      servedAt: new Date().toISOString(),
    };
  }
}

function folderStats(path: string): { files: number; bytes: number } {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  const st = statSync(path);
  if (st.isFile()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files += 1;
        bytes += statSync(p).size;
      }
    }
  }
  return { files, bytes };
}

/* ------------------------------------------------------------------ API */

export type DataMap = {
  workspace: { id: string; name: string; portalUrl: string };
  sources: { source: SourceId; name: string; portalUrl: string; tables: { name: string; rows: number; bytes: number }[]; files: { name: string; files: number; bytes: number }[] }[];
  provenance: Provenance;
};

export type LocalApi = {
  searchPatients(req: SearchRequest): Promise<SearchResult>;
  getPatient(patientId: string, origin: string): Promise<PatientBundle>;
  getDocument(documentId: string, origin: string): Promise<DocumentText>;
  getSeriesFiles(seriesUid: string, patientId: string): Promise<{ files: Row[]; access: FileAccess }>;
  getDataMap(): Promise<DataMap>;
  queryRecords(spec: QuerySpec): Promise<{ rows: Row[]; sql: string; ms: number } | { error: string }>;
  listRequests(): Promise<{ requests: Row[]; approvalUrl: string; provenance: Provenance }>;
};

export function createLocalApi(root: string): LocalApi {
  let ready: Promise<DuckDBInstance> | null = null;
  const tables = new Map<string, string[]>();

  const connect = () =>
    (ready ??= (async () => {
      const index = resolve(root, 'data', 'generated', 'p360', 'p360_patient.parquet');
      if (!existsSync(index)) {
        throw new Error('No patient index in data/generated/p360. Run: .venv/bin/python scripts/24_patient360_data.py');
      }
      const { DuckDBInstance } = await import('@duckdb/node-api');
      const instance = await DuckDBInstance.create(':memory:');
      const db = await instance.connect();
      // SQL Server sorts NULL first ascending and compares strings case-insensitively; match it.
      await db.run(`SET GLOBAL default_null_order = 'nulls_first_on_asc_last_on_desc'`);
      await db.run(`SET GLOBAL default_collation = 'nocase'`);
      for (const c of catalogs(root)) {
        await db.run(`ATTACH ':memory:' AS "${c.catalog}"`);
        await db.run(`CREATE SCHEMA "${c.catalog}"."${c.schema}"`);
        const names = existsSync(c.dir)
          ? readdirSync(c.dir).filter((f) => f.endsWith('.parquet')).map((f) => f.slice(0, -'.parquet'.length)).sort()
          : [];
        tables.set(c.catalog, names);
        for (const t of names) {
          const file = resolve(c.dir, `${t}.parquet`).replace(/'/g, "''");
          await db.run(`CREATE VIEW "${c.catalog}"."${c.schema}"."${t}" AS SELECT * FROM read_parquet('${file}')`);
        }
      }
      // Nothing built yet by scripts/25_patient360_viewers.py: an empty index, so the record still reads.
      if (!(tables.get(N.p360) ?? []).includes('p360_viewer_asset')) {
        await db.run(`CREATE TABLE "${N.p360}".dbo.p360_viewer_asset (patient_id VARCHAR, series_uid VARCHAR, study_uid VARCHAR,
          modality VARCHAR, kind VARCHAR, folder VARCHAR, meta_json VARCHAR, bytes BIGINT, built_at TIMESTAMP)`);
      }
      // No copy of the data requests yet: empty tables, so records and search still work.
      const empty: [string, string, string, string][] = [
        [N.requests, 'crc', 'COHORT_REQUEST', `QUERY_MASTER_ID INTEGER, PATIENT_SET_RESULT_INSTANCE_ID INTEGER, TITLE VARCHAR, STATUS VARCHAR,
          REQUESTED_BY VARCHAR, REQUESTED_AT TIMESTAMP, DECIDED_BY VARCHAR, DECIDED_AT TIMESTAMP, DELIVERED_AT TIMESTAMP,
          DELIVERY_LAKEHOUSE VARCHAR, DELIVERED_PATIENTS INTEGER`],
        [N.requests, 'crc', 'QT_PATIENT_SET_COLLECTION', 'RESULT_INSTANCE_ID INTEGER, SET_INDEX INTEGER, PATIENT_NUM BIGINT'],
        [N.requests, 'crc', 'COHORT_QUERY_CONTEXT', 'QUERY_MASTER_ID INTEGER, NL_QUESTION VARCHAR, QUERY_SUMMARY VARCHAR'],
        [N.omop, 'dbo', 'i2b2_patient_mapping', 'patient_num BIGINT, patient_ide VARCHAR, patient_ide_source VARCHAR'],
      ];
      for (const [cat, schema, table, cols] of empty) {
        if (!(tables.get(cat) ?? []).includes(table)) await db.run(`CREATE TABLE "${cat}"."${schema}"."${table}" (${cols})`);
      }
      db.closeSync();
      return instance;
    })().catch((e) => {
      ready = null;
      throw e;
    }));

  const access = (origin: string, source: SourceId, scope: string): FileAccess => ({
    baseUrl: `${origin}/local-files/${source}`,
    query: '',
    expiresOn: '',
    scope: `${scope} (local copy)`,
    source,
  });

  return {
    async searchPatients(req) {
      const tracer = new Tracer(await connect());
      const { count, list, params } = searchSql('duckdb', N, req);
      const [total, patients] = await Promise.all([
        tracer.run('count', ['p360', 'clarity'], ['p360_patient'], count, params),
        tracer.run('patients', ['p360', 'clarity', 'pacs', 'documents'], ['p360_patient', 'PATIENT', 'PAT_ENC', 'Study', 'document_index'], list, params),
      ]);
      return {
        patients,
        total: Number(total[0]?.n ?? 0),
        offset: req.offset ?? 0,
        limit: req.limit ?? 10,
        provenance: tracer.provenance(searchSql('tsql', N, req).list),
      };
    },

    async getPatient(patientId, origin) {
      if (!PATIENT_ID.test(patientId)) throw new Error('Invalid patient id');
      const tracer = new Tracer(await connect());
      if (patientId.startsWith('TCGA-')) {
        if (!(tables.get(N.oncology) ?? []).includes('patient')) {
          throw new Error('The oncology research patients are not imported yet (scripts/26_patient360_import.py).');
        }
        const defs = researchQueries('duckdb', N);
        const results = await Promise.all(defs.map((q) => tracer.run(q.id, q.sources, q.tables, q.sql, { id: patientId })));
        if (!results[defs.findIndex((q) => q.id === 'patient')].length) throw new Error(`Patient ${patientId} not found`);
        const imaging = access(origin, 'research_imaging', `${N.researchImaging}/Files`);
        return assembleResearch(
          Object.fromEntries(defs.map((q, i) => [q.id, results[i]])),
          {
            slide: imaging,
            radiology: imaging,
            report: access(origin, 'oncology', `${N.oncology}/Files`),
            documents: access(origin, 'documents', `${N.documents}/Files`),
            archive: imaging,
          },
          tracer.provenance(researchQueries('tsql', N)[0].sql)
        );
      }
      const head = await tracer.run(
        'mrn',
        ['clarity', 'p360'],
        ['PATIENT', 'p360_patient'],
        `SELECT p.PAT_MRN_ID AS mrn, x.has_genome FROM ${N.clarity}.dbo.PATIENT p
         LEFT JOIN ${N.p360}.dbo.p360_patient x ON x.patient_id = p.PAT_ID WHERE p.PAT_ID = $id`,
        { id: patientId }
      );
      if (!head.length) throw new Error(`Patient ${patientId} not found`);
      const params = { id: patientId, mrn: String(head[0].mrn) };
      const defs = [...epicQueries('duckdb', N), ...(Number(head[0].has_genome) === 1 ? epicGenomeQueries('duckdb', N) : [])];
      const results = await Promise.all(
        defs.map((q) => tracer.run(q.id, q.sources, q.tables, q.sql, params).catch((e) => (optional(q.id) ? [] : Promise.reject(e))))
      );
      const rows = Object.fromEntries(defs.map((q, i) => [q.id, results[i]]));
      const showcase = epicQueries('tsql', N).find((q) => q.id === 'studies')!.sql;
      return assembleEpic(
        rows,
        {
          slide: access(origin, 'p360', `${N.p360}/Files/viewer`),
          radiology: access(origin, 'p360', `${N.p360}/Files/viewer`),
          report: access(origin, 'documents', `${N.documents}/Files`),
          documents: access(origin, 'documents', `${N.documents}/Files`),
          archive: access(origin, 'archive', `${N.archive}/Files/dicom`),
        },
        tracer.provenance(showcase)
      );
    },

    async getDocument(documentId, origin) {
      const tracer = new Tracer(await connect());
      const sql = documentSql('duckdb', N);
      const [doc, facts] = await Promise.all([
        tracer.run('document', ['documents'], ['document_index'], sql.doc, { doc: documentId }),
        tracer.run('facts', ['documents'], ['document_facts'], sql.facts, { doc: documentId }),
      ]);
      if (!doc.length) throw new Error(`Document ${documentId} not found`);
      const d = doc[0];
      // Typed documents are text files; a scan's text is the ground truth it was rendered from (its OCR stand-in).
      const rel = String(d.scanned ? d.text_path ?? '' : d.path ?? '').replace(/^Files\//, '');
      const file = resolve(fileRoots(root).documents!, rel);
      const { readFile } = await import('fs/promises');
      const text = rel && existsSync(file) ? await readFile(file, 'utf8') : '';
      return { document: d, text, facts, access: access(origin, 'documents', `${N.documents}/Files`), provenance: tracer.provenance(sql.doc) };
    },

    async getSeriesFiles(seriesUid, patientId) {
      const tracer = new Tracer(await connect());
      const head = await tracer.run('mrn', ['clarity'], ['PATIENT'], `SELECT PAT_MRN_ID AS mrn FROM ${N.clarity}.dbo.PATIENT WHERE PAT_ID = $id`, { id: patientId });
      const files = await tracer.run('files', ['pacs'], ['Instance'], seriesFilesSql('duckdb', N), { series: seriesUid, mrn: String(head[0]?.mrn ?? '') });
      return { files, access: { baseUrl: '', query: '', expiresOn: '', scope: 'DICOM is not kept on this computer', source: 'archive', error: 'local' } };
    },

    async queryRecords(spec) {
      const q = querySql('duckdb', N, spec);
      if ('error' in q) return q;
      const tracer = new Tracer(await connect());
      const t0 = Date.now();
      const params = Object.fromEntries(Object.entries(q.params).map(([k, v]) => [k, String(v)]));
      // Numbers compare as numbers: DuckDB casts the string parameter to the column's type.
      const rows = await tracer.run('query', [], [], q.sql, params);
      return { rows, sql: querySql('tsql', N, spec) && (querySql('tsql', N, spec) as { sql: string }).sql, ms: Date.now() - t0 };
    },

    async listRequests() {
      const tracer = new Tracer(await connect());
      const sqlText = requestsSql(N);
      const requests = await tracer.run('requests', ['requests'], ['COHORT_REQUEST', 'QT_PATIENT_SET_COLLECTION'], sqlText);
      return { requests, approvalUrl: approvalUrl(root), provenance: tracer.provenance(sqlText) };
    },

    async getDataMap() {
      const db = await connect();
      const tracer = new Tracer(db);
      const t0 = Date.now();
      const conn = await db.connect();
      const sources: DataMap['sources'] = [];
      try {
        for (const c of catalogs(root)) {
          if (c.source === 'requests' || c.source === 'omop') continue; // read only for the Cohorts tab
          const names = tables.get(c.catalog) ?? [];
          if (!names.length) continue;
          const tbls = [];
          for (const t of names) {
            const r = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM "${c.catalog}"."${c.schema}"."${t}"`);
            tbls.push({ name: t, rows: Number(r.getRowObjectsJS()[0].n), bytes: statSync(resolve(c.dir, `${t}.parquet`)).size });
          }
          const fr = fileRoots(root)[c.source];
          sources.push({ source: c.source, name: c.catalog, portalUrl: '', tables: tbls, files: fr ? [{ name: 'Files', ...folderStats(fr) }] : [] });
        }
      } finally {
        conn.closeSync();
      }
      tracer.queries.push({ id: 'inventory', sources: sources.map((s) => s.source), tables: [], rows: sources.length, ms: Date.now() - t0 });
      return {
        workspace: { id: 'local', name: 'this computer (local mode)', portalUrl: '' },
        sources,
        provenance: tracer.provenance('SELECT COUNT(*) FROM <item>.<schema>.<table>'),
      };
    },
  };
}
