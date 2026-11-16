/**
 * Patient 360's Rayfin functions: the data API of the Fabric App. They run the same SQL as local mode (record.ts), in
 * T-SQL, on the Patient360 lakehouse's SQL analytics endpoint, which reaches every other item in the workspace by its
 * three-part name: Epic Clarity (Bronze_Clarity), the PACS database (Bronze_PACS), the
 * documents lakehouse and the oncology research silos. Files (viewer files, scanned documents, research slides and
 * volumes) stream straight from OneLake to the browser through short-lived, read-only, folder-scoped SAS links.
 *
 * Every function runs as the signed-in user (Rayfin passes their tokens), so the workspace's own permissions apply.
 * scripts/27_patient360_app.py writes config.generated.ts for the workspace and deploys the app.
 */
import { createHmac } from 'node:crypto';

import {
  DataLakeSASPermissions,
  DataLakeServiceClient,
  SASProtocol,
  generateDataLakeSASQueryParameters,
  type UserDelegationKey,
} from '@azure/storage-file-datalake';
import { AudienceType, UserDataFunctions, type RayfinContext } from '@microsoft/fabric-user-data-functions';
import sql from 'mssql';

import { CONFIG } from './config.generated.js';
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
} from './record.js';

/** The functions read no Rayfin data (the page reads tumour board notes itself). */
export type AppSchema = Record<string, never>;

const N = DEFAULT_NAMES;
const ONELAKE_DFS = 'https://onelake.dfs.fabric.microsoft.com';
const ONELAKE_BLOB = 'https://onelake.blob.fabric.microsoft.com';
const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const PORTAL = 'https://app.fabric.microsoft.com';
const SAS_LIFETIME_MS = 55 * 60_000;
const KEY_REUSE_MS = 40 * 60_000;

/** The item behind each source, by its name in the workspace. */
const ITEM: Partial<Record<SourceId, string>> = {
  clarity: N.clarity,
  pacs: N.pacs,
  archive: N.archive,
  documents: N.documents,
  p360: N.p360,
  oncology: N.oncology,
  genomics: N.genomics,
  research_imaging: N.researchImaging,
  requests: N.requests,
  omop: N.omop,
};
const itemId = (source: SourceId): string => CONFIG.items[ITEM[source] as keyof typeof CONFIG.items] ?? '';

export type DataMap = {
  workspace: { id: string; name: string; portalUrl: string };
  sources: { source: SourceId; name: string; portalUrl: string; tables: { name: string; rows: number; bytes: number }[]; files: { name: string; files: number; bytes: number }[] }[];
  provenance: Provenance;
};
export type QueryResult = { rows: Row[]; sql: string; ms: number } | { error: string };
export type ChatTicket = { ticket: string; expiresAt: number; chatUrl: string; user: string };

/* ------------------------------------------------------------------ SQL */

let cached: { token: string; pool: sql.ConnectionPool } | null = null;

async function getPool(token: string): Promise<sql.ConnectionPool> {
  if (!CONFIG.sqlServer) throw new Error('Patient 360 is not configured for this workspace: run scripts/27_patient360_app.py.');
  if (cached && cached.token === token && cached.pool.connected) return cached.pool;
  if (cached) void cached.pool.close().catch(() => undefined);
  const pool = new sql.ConnectionPool({
    server: CONFIG.sqlServer,
    // Lakehouse SQL analytics endpoints take the lakehouse name as the database.
    database: N.p360,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    pool: { max: 16, min: 0, idleTimeoutMillis: 60_000 },
    requestTimeout: 90_000,
    connectionTimeout: 30_000,
  });
  await pool.connect();
  cached = { token, pool };
  return pool;
}

function normalise(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const s = value.toISOString();
    return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s.slice(0, 19);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/** BIGINT columns arrive as strings; convert them back using the column metadata. */
function toRows(result: sql.IResult<Record<string, unknown>>): Row[] {
  const recordset = result.recordset ?? [];
  const columns = (recordset as unknown as { columns?: Record<string, { type: unknown }> }).columns ?? {};
  const bigint = new Set(
    Object.entries(columns)
      .filter(([, c]) => c.type === sql.BigInt)
      .map(([name]) => name)
  );
  return recordset.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, bigint.has(k) && v !== null ? Number(v) : normalise(v)]))
  );
}

class Tracer {
  readonly queries: QueryTrace[] = [];
  private readonly started = Date.now();

  constructor(private readonly db: sql.ConnectionPool) {}

  async run(id: string, sources: SourceId[], tables: string[], text: string, params: Record<string, string | number> = {}): Promise<Row[]> {
    const t0 = Date.now();
    const request = this.db.request();
    for (const [k, v] of Object.entries(params)) {
      if (!text.includes(`@${k}`)) continue;
      if (typeof v === 'number') request.input(k, Number.isInteger(v) ? sql.BigInt : sql.Float, v);
      else request.input(k, sql.NVarChar(400), v);
    }
    const out = toRows(await request.query(text));
    this.queries.push({ id, sources, tables, rows: out.length, ms: Date.now() - t0 });
    return out;
  }

  provenance(showcaseSql: string): Provenance {
    return {
      workspace: CONFIG.workspaceName,
      endpoint: CONFIG.sqlServer,
      database: N.p360,
      queries: this.queries,
      totalMs: Date.now() - this.started,
      showcaseSql: showcaseSql.trim(),
      servedAt: new Date().toISOString(),
    };
  }
}

/* ------------------------------------------------------------------ OneLake */

let delegation: { key: UserDelegationKey; reuseUntil: number; expiresOn: number; token: string } | null = null;

async function delegationKey(token: string): Promise<{ key: UserDelegationKey; expiresOn: number }> {
  const now = Date.now();
  if (delegation && delegation.token === token && delegation.reuseUntil > now) return delegation;
  const credential = { getToken: async () => ({ token, expiresOnTimestamp: now + 30 * 60_000 }) };
  const service = new DataLakeServiceClient(ONELAKE_DFS, credential);
  const expiresOn = now + SAS_LIFETIME_MS;
  const key = await service.getUserDelegationKey(new Date(now - 5 * 60_000), new Date(expiresOn));
  delegation = { key, reuseUntil: now + KEY_REUSE_MS, expiresOn, token };
  return delegation;
}

/** Read-only SAS for one folder of an item's Files area; paths in the tables are relative to Files. */
async function signAccess(token: string, source: SourceId, folder: string): Promise<FileAccess> {
  const id = itemId(source);
  const filesRoot = `${id}/Files`;
  const scope = `${filesRoot}/${folder}`.replace(/\/$/, '');
  const baseUrl = `${ONELAKE_BLOB}/${CONFIG.workspaceId}/${filesRoot}`;
  const label = `${ITEM[source]}/Files/${folder}`;
  if (!id) return { baseUrl, query: '', expiresOn: '', scope: label, source, error: `${ITEM[source]} is not in this workspace` };
  try {
    const { key, expiresOn } = await delegationKey(token);
    const query = generateDataLakeSASQueryParameters(
      {
        fileSystemName: CONFIG.workspaceId,
        pathName: scope,
        isDirectory: true,
        directoryDepth: scope.split('/').length,
        permissions: DataLakeSASPermissions.parse('r'),
        protocol: SASProtocol.Https,
        startsOn: new Date(Date.now() - 5 * 60_000),
        expiresOn: new Date(expiresOn),
      },
      key,
      'onelake'
    ).toString();
    return { baseUrl, query, expiresOn: new Date(expiresOn).toISOString(), scope: label, source };
  } catch (error) {
    console.error('OneLake SAS unavailable', error);
    return { baseUrl, query: '', expiresOn: '', scope: label, source, error: String(error) };
  }
}

/** A text file from an item's Files area (a document's text), read with the user's storage token. */
async function readText(token: string, source: SourceId, path: string): Promise<string> {
  const rel = path.replace(/^Files\//, '');
  const res = await fetch(`${ONELAKE_DFS}/${CONFIG.workspaceId}/${itemId(source)}/Files/${rel}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03' },
  });
  if (!res.ok) throw new Error(`Could not read ${ITEM[source]}/Files/${rel} (${res.status})`);
  return res.text();
}

/* ------------------------------------------------------------------ who is calling */

function claims(accessToken: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const names = new Map<string, string>();

/** The signed-in user's name: their UPN from the token, or their name in the workspace's role assignments. */
async function callerName(accessToken: string, fabricToken: string, oid: string): Promise<string> {
  const c = claims(accessToken);
  for (const k of ['upn', 'email', 'preferred_username']) if (typeof c[k] === 'string' && String(c[k]).includes('@')) return String(c[k]);
  if (!names.has(oid)) {
    const res = await fetch(`${FABRIC_API}/workspaces/${CONFIG.workspaceId}/roleAssignments`, { headers: { Authorization: `Bearer ${fabricToken}` } });
    if (res.ok) {
      const body = (await res.json()) as { value?: { principal?: { id?: string; displayName?: string; userDetails?: { userPrincipalName?: string } } }[] };
      for (const a of body.value ?? []) {
        const pr = a.principal;
        if (pr?.id) names.set(pr.id.toLowerCase(), pr.userDetails?.userPrincipalName || pr.displayName || pr.id);
      }
    }
  }
  return names.get(oid.toLowerCase()) ?? `Entra user ${oid}`;
}

/* ------------------------------------------------------------------ functions */

const udf = new UserDataFunctions();

/** The patient list: filters on the Patient 360 index, then one statement across Epic, the PACS and the documents. */
udf.func(
  'searchPatients',
  async (request: string, ctx: RayfinContext<AppSchema, AudienceType.Sql>): Promise<SearchResult> => {
    const req = JSON.parse(request || '{}') as SearchRequest;
    const tracer = new Tracer(await getPool(ctx.Tokens.Sql));
    const { count, list, params } = searchSql('tsql', N, req);
    const [total, patients] = await Promise.all([
      tracer.run('count', ['p360'], ['p360_patient'], count, params),
      tracer.run('patients', ['p360', 'clarity', 'pacs', 'documents'], ['p360_patient', 'PATIENT', 'PAT_ENC', 'Study', 'document_index'], list, params),
    ]);
    return { patients, total: Number(total[0]?.n ?? 0), offset: req.offset ?? 0, limit: req.limit ?? 10, provenance: tracer.provenance(list) };
  },
  []
);

/** One patient's whole record, read where it lives, with signed links to their files. */
udf.func(
  'getPatient',
  async (patientId: string, ctx: RayfinContext<AppSchema, AudienceType.Sql | AudienceType.Storage>): Promise<PatientBundle> => {
    if (!PATIENT_ID.test(patientId)) throw new Error('Invalid patient id');
    const tracer = new Tracer(await getPool(ctx.Tokens.Sql));
    const storage = ctx.Tokens.Storage;
    if (patientId.startsWith('TCGA-')) {
      const defs = researchQueries('tsql', N);
      const results = await Promise.all(defs.map((q) => tracer.run(q.id, q.sources, q.tables, q.sql, { id: patientId })));
      if (!results[defs.findIndex((q) => q.id === 'patient')].length) throw new Error(`Patient ${patientId} not found`);
      const rows = Object.fromEntries(defs.map((q, i) => [q.id, results[i]]));
      const id = patientId.toLowerCase();
      const report = rows.report[0];
      const [slides, radiology, reportAccess] = await Promise.all([
        signAccess(storage, 'research_imaging', `slides/${id}`),
        signAccess(storage, 'research_imaging', `radiology/${id}`),
        signAccess(storage, 'oncology', String(report?.pdf_path ?? `reports/${patientId}.pdf`).replace(/\/[^/]*$/, '')),
      ]);
      const none: FileAccess = { baseUrl: '', query: '', expiresOn: '', scope: '', source: 'documents', error: 'no documents' };
      // The slide viewer reads slides/<id>/...; the radiology viewer radiology/<id>/...: each access covers its folder.
      return assembleResearch(
        rows,
        { slide: slides, radiology, report: reportAccess, documents: none, archive: { ...none, source: 'archive' } },
        tracer.provenance(defs[0].sql)
      );
    }
    const head = await tracer.run(
      'mrn',
      ['clarity', 'p360'],
      ['PATIENT', 'p360_patient'],
      `SELECT p.PAT_MRN_ID AS mrn, x.has_genome FROM ${N.clarity}.dbo.PATIENT p
       LEFT JOIN ${N.p360}.dbo.p360_patient x ON x.patient_id = p.PAT_ID WHERE p.PAT_ID = @id`,
      { id: patientId }
    );
    if (!head.length) throw new Error(`Patient ${patientId} not found`);
    const params = { id: patientId, mrn: String(head[0].mrn) };
    const defs = [...epicQueries('tsql', N), ...(Number(head[0].has_genome) === 1 ? epicGenomeQueries('tsql', N) : [])];
    // The data requests and genomes are optional: a workspace without the cohort apps or the genomics silo still
    // shows the record.
    const results = await Promise.all(
      defs.map((q) => tracer.run(q.id, q.sources, q.tables, q.sql, params).catch((e) => (optional(q.id) ? [] : Promise.reject(e))))
    );
    const rows = Object.fromEntries(defs.map((q, i) => [q.id, results[i]]));
    // Demo-mode deliveries carry part of a cohort: whether this patient is in the delivery lakehouse.
    await Promise.all(
      rows.cohorts.map(async (c) => {
        const lh = String(c.delivery_lakehouse ?? '');
        if (!/^[A-Za-z0-9_]{1,120}$/.test(lh) || c.person_id === null) return;
        const hit = await tracer
          .run(`delivery_${c.query_master_id}`, ['omop'], [`${lh}.person`], `SELECT COUNT(*) AS n FROM [${lh}].dbo.person WHERE person_id = @pid`, {
            pid: Number(c.person_id),
          })
          .catch(() => null);
        if (hit) c.in_delivery = Number(hit[0]?.n ?? 0) > 0;
      })
    );
    const [viewer, scanned] = await Promise.all([
      signAccess(storage, 'p360', `viewer/${patientId}`),
      signAccess(storage, 'documents', 'scanned_documents'),
    ]);
    const none: FileAccess = { baseUrl: '', query: '', expiresOn: '', scope: `${N.archive}/Files/dicom`, source: 'archive', error: 'not signed' };
    return assembleEpic(
      rows,
      { slide: viewer, radiology: viewer, report: scanned, documents: scanned, archive: none },
      tracer.provenance(defs.find((q) => q.id === 'studies')!.sql)
    );
  },
  []
);

/** One document: its index row, its text (a scan's text is what it was rendered from) and the facts behind it. */
udf.func(
  'getDocument',
  async (documentId: string, ctx: RayfinContext<AppSchema, AudienceType.Sql | AudienceType.Storage>): Promise<DocumentText> => {
    if (!/^[A-Z]+-[A-Z0-9]+$/i.test(documentId)) throw new Error('Invalid document id');
    const tracer = new Tracer(await getPool(ctx.Tokens.Sql));
    const q = documentSql('tsql', N);
    const [doc, facts] = await Promise.all([
      tracer.run('document', ['documents'], ['document_index'], q.doc, { doc: documentId }),
      tracer.run('facts', ['documents'], ['document_facts'], q.facts, { doc: documentId }),
    ]);
    if (!doc.length) throw new Error(`Document ${documentId} not found`);
    const d = doc[0];
    const path = String(d.scanned ? d.text_path ?? '' : d.path ?? '');
    const [text, access] = await Promise.all([
      path ? readText(ctx.Tokens.Storage, 'documents', path).catch(() => '') : Promise.resolve(''),
      signAccess(ctx.Tokens.Storage, 'documents', 'scanned_documents'),
    ]);
    return { document: d, text, facts, access, provenance: tracer.provenance(q.doc) };
  },
  []
);

/** Ask's query_records: counts and summaries across patients, compiled from a structured query. */
udf.func(
  'queryRecords',
  async (spec: string, ctx: RayfinContext<AppSchema, AudienceType.Sql>): Promise<QueryResult> => {
    const q = querySql('tsql', N, JSON.parse(spec || '{}') as QuerySpec);
    if ('error' in q) return q;
    const tracer = new Tracer(await getPool(ctx.Tokens.Sql));
    const t0 = Date.now();
    try {
      const rows = await tracer.run('query', [], [], q.sql, q.params);
      return { rows, sql: q.sql, ms: Date.now() - t0 };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
  []
);

/** Where the data lives: every item the app reads, its tables with their row counts. */
udf.func(
  'getDataMap',
  async (ctx: RayfinContext<AppSchema, AudienceType.Sql>): Promise<DataMap> => {
    const tracer = new Tracer(await getPool(ctx.Tokens.Sql));
    const order: SourceId[] = ['clarity', 'pacs', 'archive', 'documents', 'p360', 'oncology', 'genomics', 'research_imaging'];
    // Sizes in OneLake, measured by scripts/24_patient360_data.py --fabric (listing every file takes too long here).
    const inventory = await tracer
      .run('inventory', ['p360'], ['p360_inventory'], `SELECT item, kind, name, files, bytes FROM ${N.p360}.dbo.p360_inventory`)
      .catch(() => [] as Row[]);
    const measured = (item: string, kind: string, name: string) => inventory.find((r) => r.item === item && r.kind === kind && r.name === name);
    const sources = await Promise.all(
      order
        .filter((s) => itemId(s) || s === 'pacs')
        .map(async (source) => {
          const name = ITEM[source]!;
          const schema = source === 'pacs' ? 'pacs' : 'dbo';
          const list = await tracer.run(`${source}_tables`, [source], ['INFORMATION_SCHEMA.TABLES'],
            `SELECT TABLE_NAME AS name FROM ${name}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${schema}' ORDER BY TABLE_NAME`).catch(() => []);
          const tables = await Promise.all(
            list.map(async (t) => {
              const n = await tracer.run(`${source}.${t.name}`, [source], [String(t.name)], `SELECT COUNT_BIG(*) AS n FROM ${name}.${schema}.[${String(t.name).replace(/]/g, '')}]`).catch(() => [{ n: 0 }]);
              return { name: String(t.name), rows: Number(n[0]?.n ?? 0), bytes: Number(measured(name, 'table', String(t.name))?.bytes ?? 0) };
            })
          );
          const id = itemId(source);
          const area = measured(name, 'files', 'Files');
          const files = area && Number(area.files) > 0 ? [{ name: 'Files', files: Number(area.files), bytes: Number(area.bytes) }] : [];
          return { source, name, portalUrl: id ? `${PORTAL}/groups/${CONFIG.workspaceId}/${source === 'pacs' ? 'sqldatabases' : 'lakehouses'}/${id}` : `${PORTAL}/groups/${CONFIG.workspaceId}`, tables, files };
        })
    );
    return {
      workspace: { id: CONFIG.workspaceId, name: CONFIG.workspaceName, portalUrl: `${PORTAL}/groups/${CONFIG.workspaceId}` },
      sources,
      provenance: tracer.provenance('SELECT COUNT_BIG(*) FROM <item>.<schema>.<table>'),
    };
  },
  []
);

/** The approved and delivered data requests, for the patient list's filter and Ask. Empty without the cohort apps. */
udf.func(
  'listRequests',
  async (ctx: RayfinContext<AppSchema, AudienceType.Sql>): Promise<{ requests: Row[]; approvalUrl: string; provenance: Provenance }> => {
    const tracer = new Tracer(await getPool(ctx.Tokens.Sql));
    const sqlText = requestsSql(N);
    const requests = await tracer.run('requests', ['requests'], ['COHORT_REQUEST', 'QT_PATIENT_SET_COLLECTION'], sqlText).catch(() => []);
    const approvalUrl = (CONFIG as { approvalUrl?: string }).approvalUrl ?? '';
    return { requests, approvalUrl, provenance: tracer.provenance(sqlText) };
  },
  []
);

/**
 * A chat ticket for Ask's relay: the signed-in user's Entra object ID and name with a 30-minute expiry, signed with the
 * CHAT_TICKET_KEY secret the relay shares. The relay serves nobody without one.
 */
udf.func(
  'chatTicket',
  async (ctx: RayfinContext<AppSchema, AudienceType.Fabric>): Promise<ChatTicket> => {
    const c = claims(ctx.accessToken);
    const oid = String(c.oid ?? c.sub ?? '').split('/').filter(Boolean).pop() ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(oid)) throw new Error('Could not tell who is signed in; sign in again.');
    if (!CONFIG.chatUrl) throw new Error('Ask is not set up in this workspace yet: run scripts/28_patient360_chat.py deploy, then scripts/27_patient360_app.py.');
    const user = await callerName(ctx.accessToken, ctx.Tokens.Fabric, oid);
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
    const body = Buffer.from(JSON.stringify({ oid, upn: user, exp: expiresAt })).toString('base64url');
    const signature = createHmac('sha256', ctx.Secrets.CHAT_TICKET_KEY).update(body).digest('base64url');
    return { ticket: `${body}.${signature}`, expiresAt, chatUrl: CONFIG.chatUrl, user };
  },
  []
);
