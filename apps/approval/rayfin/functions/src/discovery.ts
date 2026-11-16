/*
 * Cohort discovery for the Discovery tab: the server side of the chat's tools and of the query builder.
 *
 * A port of scripts/cohort_service.py and scripts/cohort_store.py (the local app's service). Every i2b2 query is
 * compiled to DAX, run on the Cohort Discovery (i2b2) semantic model with the app identity's Fabric token (Power BI
 * executeQueries), obfuscated as for an i2b2 DATA_OBFSC user and recorded in the CRC store (the Cohort_Requests SQL
 * database), under the signed-in user. True counts and patient numbers stay in this function: only obfuscated counts
 * go back to the page and to Copilot.
 */
import sql from 'mssql';

import { CONFIG } from './config.generated.js';
import { MODEL_DESCRIPTION } from './discovery.generated.js';
import * as Q from './i2b2.js';

type Dict = Record<string, unknown>;

export type DiscoveryEnv = {
  fabricToken: string;
  pool: () => Promise<sql.ConnectionPool>;
  user: () => Promise<string>;
};

const ONTOLOGY_COLUMNS = ['c_hlevel', 'c_fullname', 'c_name', 'c_visualattributes', 'c_totalnum', 'c_basecode', 'c_tablename',
  'c_columnname', 'c_operator', 'c_dimcode', 'c_columndatatype', 'c_facttablecolumn', 'c_metadataxml', 'm_applied_path'];
const SMALL_CELL = 10;            // ontology term counts below this are not shown (small-cell suppression)
const EXPLORE_ROWS = 100;
const PATIENT_LEVEL = /patient_num|encounter_num|_ide\b|birth|death_date|zip/i;
const ONTOLOGY_TTL = 30 * 60_000;
const NOTE = 'Counts are obfuscated as for an i2b2 DATA_OBFSC user (Gaussian noise; 3 or fewer -> 0).';

/* ------------------------------------------------------------------ the semantic model */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one DAX query on the Cohort Discovery model and returns the rows with plain column names. */
async function dax(env: DiscoveryEnv, query: string): Promise<Dict[]> {
  const url = `https://api.powerbi.com/v1.0/myorg/groups/${CONFIG.workspaceId}/datasets/${CONFIG.discoveryModelId}/executeQueries`;
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.fabricToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } }),
    });
    if (res.status !== 429 && res.status < 500) break;
    await sleep(3000 * (attempt + 1));
  }
  const text = await res!.text();
  let body: Dict = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  const result = ((body.results as Dict[]) ?? [{}])[0] ?? {};
  if (res!.status !== 200 || result.error) {
    const detail = body.error ?? result.error ?? text.slice(0, 800);
    throw new Error(`DAX query failed (${res!.status}): ${JSON.stringify(detail).slice(0, 1500)}`);
  }
  const rows = (((result.tables as Dict[]) ?? [{}])[0]?.rows as Dict[]) ?? [];
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.split('[').pop()!.replace(/\]$/, ''), v])));
}

let cache: { at: number; ontology: Q.Ontology } | null = null;
let patientsInModel: number | null = null;

async function ontology(env: DiscoveryEnv): Promise<Q.Ontology> {
  if (cache && Date.now() - cache.at < ONTOLOGY_TTL) return cache.ontology;
  const cols = ONTOLOGY_COLUMNS.map((c) => `"${c}", i2b2_ontology[${c}]`).join(', ');
  const [rows, tables] = await Promise.all([
    dax(env, `EVALUATE SELECTCOLUMNS(i2b2_ontology, ${cols})`),
    dax(env, 'EVALUATE SELECTCOLUMNS(table_access, "c_table_cd", table_access[c_table_cd], '
      + '"c_fullname", table_access[c_fullname], "c_name", table_access[c_name])'),
  ]);
  cache = { at: Date.now(), ontology: Q.Ontology.fromRows(rows, tables) };
  return cache.ontology;
}

/* ------------------------------------------------------------------ the CRC store (SQL) */

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Param = [sql.ISqlType | (() => sql.ISqlType), unknown];

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

async function exec(target: sql.ConnectionPool | sql.Transaction, text: string, params: Record<string, Param> = {}): Promise<Row[]> {
  const request = new sql.Request(target as sql.ConnectionPool);
  for (const [name, [type, value]] of Object.entries(params)) request.input(name, type, value);
  const result = await request.query(text);
  return (result.recordset ?? []).map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));
}

const text = (v: string | null | undefined): Param => [sql.NVarChar(sql.MAX), v ?? null];
const int = (v: number): Param => [sql.Int(), v];

type Breakdowns = [string, [string, number][]][];

async function recordRun(pool: sql.ConnectionPool, run: {
  user: string; name: string; requestXml: string; generatedQuery: string; queryJson: Dict; question: string; summary: string;
  realTotal: number; breakdowns: Breakdowns; patients: number[]; started: Date;
}) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const now = new Date();
    const outputs = ['PATIENTSET', 'PATIENT_COUNT_XML', ...run.breakdowns.map(([k]) => k)];
    const [master] = await exec(tx, `INSERT INTO crc.QT_QUERY_MASTER (NAME, USER_ID, GROUP_ID, CREATE_DATE, DELETE_FLAG, REQUEST_XML,
        GENERATED_SQL, I2B2_REQUEST_XML) OUTPUT INSERTED.QUERY_MASTER_ID VALUES (@name, @user, @grp, @now, 'N', @xml, @gen, @msg)`, {
      name: text(run.name), user: text(run.user), grp: text(Q.PROJECT), now: [sql.DateTime2(0), now], xml: text(run.requestXml),
      gen: text(run.generatedQuery), msg: text(Q.requestMessage(run.requestXml, run.user, outputs)),
    });
    const qm = Number(master.QUERY_MASTER_ID);
    await exec(tx, `INSERT INTO crc.COHORT_QUERY_CONTEXT VALUES (@qm, @question, @summary, @json, @language, @model, @via)`, {
      qm: int(qm), question: text(run.question), summary: text(run.summary), json: text(JSON.stringify(run.queryJson)),
      language: text('i2b2 query definition -> DAX'), model: text(CONFIG.discoveryModelId), via: text('GitHub Copilot (Fabric app)'),
    });
    const [instance] = await exec(tx, `INSERT INTO crc.QT_QUERY_INSTANCE (QUERY_MASTER_ID, USER_ID, GROUP_ID, BATCH_MODE, START_DATE,
        END_DATE, DELETE_FLAG, STATUS_TYPE_ID) OUTPUT INSERTED.QUERY_INSTANCE_ID VALUES (@qm, @user, @grp, 'FINISHED', @started, @now, 'N', 6)`, {
      qm: int(qm), user: text(run.user), grp: text(Q.PROJECT), started: [sql.DateTime2(3), run.started], now: [sql.DateTime2(3), now],
    });
    const qi = Number(instance.QUERY_INSTANCE_ID);
    const total = Q.obfuscate(run.realTotal, Q.SIGMA_TOTAL);
    const result = async (kind: string, setSize: number, method: string, description: string) => {
      const [row] = await exec(tx, `INSERT INTO crc.QT_QUERY_RESULT_INSTANCE (QUERY_INSTANCE_ID, RESULT_TYPE_ID, SET_SIZE, START_DATE,
          END_DATE, STATUS_TYPE_ID, DELETE_FLAG, DESCRIPTION, REAL_SET_SIZE, OBFUSC_METHOD) OUTPUT INSERTED.RESULT_INSTANCE_ID
          VALUES (@qi, @type, @size, @started, @now, 3, 'N', @description, @real, @method)`, {
        qi: int(qi), type: int(Q.RESULT_TYPE_IDS[kind]), size: int(setSize), started: [sql.DateTime2(3), run.started],
        now: [sql.DateTime2(3), now], description: text(description.slice(0, 200)), real: int(run.realTotal), method: text(method),
      });
      return Number(row.RESULT_INSTANCE_ID);
    };
    const xml = async (rid: number, value: string) => exec(tx,
      'INSERT INTO crc.QT_XML_RESULT (RESULT_INSTANCE_ID, XML_VALUE) VALUES (@rid, @xml)', { rid: int(rid), xml: text(value) });

    const patientSet = await result('PATIENTSET', total, 'OBTOTAL', `Patient Set for "${run.name}"`);
    await exec(tx, `INSERT INTO crc.QT_PATIENT_SET_COLLECTION (RESULT_INSTANCE_ID, SET_INDEX, PATIENT_NUM)
        SELECT @rid, ROW_NUMBER() OVER (ORDER BY CAST(value AS BIGINT)), CAST(value AS BIGINT) FROM OPENJSON(@patients)`, {
      rid: int(patientSet), patients: text(JSON.stringify([...run.patients].sort((a, b) => a - b))),
    });
    const countId = await result('PATIENT_COUNT_XML', total, 'OBSUBTOTAL', `${Q.RESULT_DESCRIPTIONS.PATIENT_COUNT_XML} for "${run.name}"`);
    await xml(countId, Q.resultXml('PATIENT_COUNT_XML', [['patient_count', total]]));
    const shown: Record<string, Record<string, number>> = {};
    for (const [kind, cells] of run.breakdowns) {
      const noisy: [string, number][] = cells.map(([label, n]) => [label, Q.obfuscate(n, Q.SIGMA_BREAKDOWN)]);
      const rid = await result(kind, total, 'OBSUBTOTAL', `${Q.RESULT_DESCRIPTIONS[kind]} for "${run.name}"`);
      await xml(rid, Q.resultXml(kind, noisy));
      shown[Q.RESULT_DESCRIPTIONS[kind]] = Object.fromEntries(noisy);
    }
    await tx.commit();
    return {
      query_master_id: qm, query_instance_id: qi, patient_set_result_instance_id: patientSet, query_name: run.name,
      patient_count: total, patient_count_display: Q.display(total), breakdowns: shown,
    };
  } catch (e) {
    await tx.rollback().catch(() => undefined);
    throw e;
  }
}

async function listQueries(pool: sql.ConnectionPool, user: string | null, limit: number): Promise<Row[]> {
  return exec(pool, `
    SELECT TOP ${limit} qm.QUERY_MASTER_ID, qm.NAME, qm.USER_ID, qm.CREATE_DATE, c.NL_QUESTION,
           ri.SET_SIZE AS PATIENT_COUNT, r.STATUS AS REQUEST_STATUS
    FROM crc.QT_QUERY_MASTER qm
    LEFT JOIN crc.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
    LEFT JOIN crc.QT_QUERY_INSTANCE qi ON qi.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
    LEFT JOIN crc.QT_QUERY_RESULT_INSTANCE ri ON ri.QUERY_INSTANCE_ID = qi.QUERY_INSTANCE_ID
         AND ri.RESULT_TYPE_ID = ${Q.RESULT_TYPE_IDS.PATIENT_COUNT_XML}
    LEFT JOIN crc.COHORT_REQUEST r ON r.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
    WHERE qm.DELETE_FLAG = 'N'${user ? ' AND qm.USER_ID = @user' : ''} ORDER BY qm.QUERY_MASTER_ID DESC`, user ? { user: text(user) } : {});
}

async function getQuery(pool: sql.ConnectionPool, id: number): Promise<Row | null> {
  const [row] = await exec(pool, `
    SELECT qm.QUERY_MASTER_ID, qm.NAME, qm.USER_ID, qm.CREATE_DATE, qm.REQUEST_XML, qm.GENERATED_SQL,
           c.NL_QUESTION, c.QUERY_SUMMARY, c.QUERY_DEFINITION_JSON, c.QUERY_LANGUAGE,
           ps.RESULT_INSTANCE_ID AS PATIENT_SET_RESULT_INSTANCE_ID, ps.SET_SIZE AS PATIENT_COUNT
    FROM crc.QT_QUERY_MASTER qm
    LEFT JOIN crc.COHORT_QUERY_CONTEXT c ON c.QUERY_MASTER_ID = qm.QUERY_MASTER_ID
    OUTER APPLY (SELECT TOP 1 ri.RESULT_INSTANCE_ID, ri.SET_SIZE FROM crc.QT_QUERY_INSTANCE qi
                 JOIN crc.QT_QUERY_RESULT_INSTANCE ri ON ri.QUERY_INSTANCE_ID = qi.QUERY_INSTANCE_ID
                 WHERE qi.QUERY_MASTER_ID = qm.QUERY_MASTER_ID AND ri.RESULT_TYPE_ID = ${Q.RESULT_TYPE_IDS.PATIENTSET}
                 ORDER BY qi.QUERY_INSTANCE_ID DESC) ps
    WHERE qm.QUERY_MASTER_ID = @id AND qm.DELETE_FLAG = 'N'`, { id: int(id) });
  return row ?? null;
}

/** Obfuscated breakdowns of a query's latest run, from its i2b2 XML results: {breakdown: {category: count}}. */
async function getBreakdowns(pool: sql.ConnectionPool, id: number): Promise<Record<string, Record<string, number>>> {
  const rows = await exec(pool, `
    SELECT rt.DESCRIPTION AS BREAKDOWN, d.n.value('@column', 'NVARCHAR(200)') AS CATEGORY, d.n.value('.', 'INT') AS PATIENTS
    FROM crc.QT_QUERY_RESULT_INSTANCE ri
    JOIN crc.QT_QUERY_RESULT_TYPE rt ON rt.RESULT_TYPE_ID = ri.RESULT_TYPE_ID
    JOIN crc.QT_XML_RESULT x ON x.RESULT_INSTANCE_ID = ri.RESULT_INSTANCE_ID
    CROSS APPLY (SELECT CAST(x.XML_VALUE AS XML) AS doc) xd
    CROSS APPLY xd.doc.nodes('/*:i2b2_result_envelope/body/*:result/data') d(n)
    WHERE ri.QUERY_INSTANCE_ID = (SELECT MAX(QUERY_INSTANCE_ID) FROM crc.QT_QUERY_INSTANCE WHERE QUERY_MASTER_ID = @id)
      AND rt.NAME <> 'PATIENT_COUNT_XML'
    ORDER BY rt.RESULT_TYPE_ID, x.XML_RESULT_ID`, { id: int(id) });
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[String(r.BREAKDOWN)] ??= {})[String(r.CATEGORY)] = Number(r.PATIENTS);
  return out;
}

async function getRequest(pool: sql.ConnectionPool, id: number): Promise<Row | null> {
  const [row] = await exec(pool, 'SELECT * FROM crc.V_REQUEST WHERE QUERY_MASTER_ID = @id', { id: int(id) });
  return row ?? null;
}

/* ------------------------------------------------------------------ the service */

function nodeInfo(o: Q.Ontology, n: Q.Node): Dict {
  const kinds: Record<string, string> = { F: 'folder', L: 'leaf', C: 'container', D: 'modifier folder', R: 'modifier' };
  const info: Dict = {
    item_key: o.key(n.fullname), path: n.fullname, name: n.name, kind: kinds[n.visual.slice(0, 1)] ?? n.visual,
    patients: (n.totalnum ?? 0) >= SMALL_CELL ? n.totalnum : `fewer than ${SMALL_CELL}`,
  };
  if (n.metadataxml) info.numeric_values = true;
  if (n.tablename === 'modifier_dimension') info.applies_to = n.appliedPath;
  return info;
}

function queryId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Give the QUERY_MASTER_ID (a whole number).');
  return id;
}

function prepare(o: Q.Ontology, query: unknown) {
  const qd = Q.QueryDefinition.fromDict(query as Dict).normalize(o);
  return { qd, xml: Q.toXml(qd, o), summary: Q.describe(qd, o) };
}

async function run(env: DiscoveryEnv, query: unknown, question: string) {
  const started = new Date();
  const o = await ontology(env);
  const { qd, xml, summary } = prepare(o, query);
  const compiler = new Q.DaxCompiler(o);
  const nodes: [string, Q.Node[]][] = Q.BREAKDOWN_PATHS.map(([kind, path]) => [kind, o.children(path)]);
  const countDax = compiler.countQuery(qd, nodes);
  const [rows, patientRows] = await Promise.all([dax(env, countDax), dax(env, compiler.patientSetQuery(qd))]);
  const realTotal = Math.trunc(Number(rows.find((r) => r.result_type === 'PATIENT_COUNT_XML')?.set_size ?? 0));
  const breakdowns: Breakdowns = nodes.map(([kind]) => [kind, rows.filter((r) => r.result_type === kind)
    .map((r) => [String(r.category), Math.trunc(Number(r.set_size ?? 0))] as [string, number])]);
  const patients = patientRows.map((r) => Number(r.patient_num));
  if (patients.length !== realTotal) throw new Error(`Patient set (${patients.length}) and count (${realTotal}) disagree`);
  const [user, pool] = await Promise.all([env.user(), env.pool()]);
  const result = await recordRun(pool, {
    user, name: qd.name, requestXml: xml, generatedQuery: countDax, queryJson: qd.toDict(), question, summary, realTotal,
    breakdowns, patients, started,
  });
  return { ...result, summary, i2b2_query_xml: xml, note: NOTE };
}

async function query(pool: sql.ConnectionPool, id: number): Promise<Row & { BREAKDOWNS?: unknown }> {
  const q = await getQuery(pool, id);
  if (!q) throw new Error(`No query with QUERY_MASTER_ID ${id}`);
  q.PATIENT_COUNT = Q.display(Number(q.PATIENT_COUNT ?? 0));
  delete q.GENERATED_SQL;
  return { ...q, BREAKDOWNS: await getBreakdowns(pool, id) } as Row & { BREAKDOWNS?: unknown };
}

async function request(pool: sql.ConnectionPool, id: number): Promise<Row> {
  const r = await getRequest(pool, id);
  if (!r) throw new Error(`No data request for QUERY_MASTER_ID ${id}`);
  delete r.PATIENT_COUNT;
  delete r.GENERATED_QUERY;
  return r;
}

/** Creates the data request (PENDING) and links it to its page in this app, where it is approved or rejected. */
async function submit(pool: sql.ConnectionPool, user: string, id: number, title: string | null): Promise<Row> {
  const q = await getQuery(pool, id);
  if (!q) throw new Error(`No query with QUERY_MASTER_ID ${id}`);
  const [existing] = await exec(pool, 'SELECT STATUS FROM crc.COHORT_REQUEST WHERE QUERY_MASTER_ID = @id', { id: int(id) });
  if (existing) throw new Error(`QUERY_MASTER_ID ${id} already has a data request (${existing.STATUS})`);
  const name = (title ?? '').trim() || String(q.NAME);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await exec(tx, `INSERT INTO crc.COHORT_REQUEST (QUERY_MASTER_ID, PATIENT_SET_RESULT_INSTANCE_ID, TITLE, STATUS, REQUESTED_BY,
        REQUESTED_AT, REPORT_URL) VALUES (@id, @ps, @title, 'PENDING', @user, SYSUTCDATETIME(), @url)`, {
      id: int(id), ps: int(Number(q.PATIENT_SET_RESULT_INSTANCE_ID)), title: text(name.slice(0, 250)), user: text(user),
      url: text(`${CONFIG.appUrl}/#/requests/${id}`),
    });
    await exec(tx, `INSERT INTO crc.COHORT_REQUEST_EVENT (QUERY_MASTER_ID, EVENT, ACTOR, EVENT_AT, DETAIL)
        VALUES (@id, 'SUBMITTED', @user, SYSUTCDATETIME(), @title)`, { id: int(id), user: text(user), title: text(name.slice(0, 1000)) });
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => undefined);
    throw e;
  }
  return request(pool, id);
}

/** Free DAX, counts only: every number is treated as a patient count and obfuscated; anything else is refused. */
async function exploreDax(env: DiscoveryEnv, query: string) {
  if (!query.trim()) throw new Error('Give a DAX query (EVALUATE ...).');
  const rows = await dax(env, query);
  if (rows.length > EXPLORE_ROWS) throw new Error(`The query returned ${rows.length} rows; group it into at most ${EXPLORE_ROWS}.`);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const hidden = columns.filter((c) => PATIENT_LEVEL.test(c));
  if (hidden.length) throw new Error(`Patient-level columns can't be returned: ${hidden.join(', ')}. Return counts instead.`);
  const counted = columns.filter((c) => rows.some((r) => typeof r[c] === 'number'));
  const out: Dict[] = [];
  for (const row of rows) {
    if (counted.length && counted.every((c) => row[c] === null || row[c] === undefined)) continue; // Direct Lake's blank member
    const clean: Dict = {};
    for (const [c, value] of Object.entries(row)) {
      if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) throw new Error(`Only patient counts can be returned; ${c} holds ${value}.`);
        clean[c] = Q.obfuscate(value, Q.SIGMA_TOTAL);
      } else clean[c] = value;
    }
    out.push(clean);
  }
  if (patientsInModel === null) {
    patientsInModel = Math.trunc(Number((await dax(env, 'EVALUATE ROW("n", COUNTROWS(ALLNOBLANKROW(patient_dimension)))'))[0].n));
  }
  return {
    columns, rows: out, patients_in_model: Q.obfuscate(patientsInModel, Q.SIGMA_TOTAL),
    note: 'Counts are obfuscated as for an i2b2 DATA_OBFSC user: Gaussian noise (sigma 1.323); a true count of 3 or fewer is 0. '
      + "Report them as 'about N (±3)' and 0 as 'fewer than 4'.",
  };
}

const limitOf = (v: unknown, fallback: number, max: number) => Math.min(max, Math.max(1, Math.trunc(Number(v ?? fallback)) || fallback));

/**
 * One action of the chat's tools (the same names and arguments as the MCP tools) or of the page: query_detail opens
 * a query from the history.
 */
export async function discoveryAction(action: string, a: Dict, env: DiscoveryEnv): Promise<unknown> {
  switch (action) {
    case 'search_ontology': {
      const o = await ontology(env);
      return o.search(String(a.text ?? ''), limitOf(a.limit, 25, 200), (a.under as string) || null).map((n) => nodeInfo(o, n));
    }
    case 'browse_ontology': {
      const o = await ontology(env);
      const path = (a.path as string) || null;
      if (!path) return [...o.tables.values()].sort().map((root) => nodeInfo(o, o.nodes.get(root)!)).filter(Boolean);
      return o.children(o.node(path).fullname).map((n) => nodeInfo(o, n));
    }
    case 'list_modifiers': {
      const o = await ontology(env);
      return [...o.nodes.values()].filter((n) => n.tablename === 'modifier_dimension')
        .sort((x, y) => (x.fullname < y.fullname ? -1 : 1))
        .map((n) => ({ modifier_key: o.key(n.fullname), name: n.name, kind: n.visual.trim(), applies_to: n.appliedPath,
          patients: (n.totalnum ?? 0) >= SMALL_CELL ? n.totalnum : `fewer than ${SMALL_CELL}` }));
    }
    case 'preview_query': {
      const { qd, xml, summary } = prepare(await ontology(env), a.query_definition);
      return { query_definition: qd.toDict(), summary, i2b2_query_xml: xml };
    }
    case 'run_i2b2_query':
      return run(env, a.query_definition, String(a.nl_question ?? ''));
    case 'list_queries': {
      const [pool, user] = await Promise.all([env.pool(), a.mine === false ? Promise.resolve(null) : env.user()]);
      const rows = await listQueries(pool, user, limitOf(a.limit, 20, 100));
      return rows.map((r) => ({ ...r, PATIENT_COUNT: Q.display(Number(r.PATIENT_COUNT ?? 0)) }));
    }
    case 'get_query':
      return query(await env.pool(), queryId(a.query_master_id));
    case 'query_detail': {
      const pool = await env.pool();
      const id = queryId(a.query_master_id);
      const q: Dict = await query(pool, id);
      q.definition = q.QUERY_DEFINITION_JSON ? JSON.parse(String(q.QUERY_DEFINITION_JSON)) : null;
      delete q.QUERY_DEFINITION_JSON;
      delete q.REQUEST_XML;
      const r = await getRequest(pool, id);
      if (r) { delete r.PATIENT_COUNT; delete r.GENERATED_QUERY; q.request = r; }
      return q;
    }
    case 'submit_request': {
      const [pool, user] = await Promise.all([env.pool(), env.user()]);
      return submit(pool, user, queryId(a.query_master_id), (a.title as string) ?? null);
    }
    case 'request_status':
      return request(await env.pool(), queryId(a.query_master_id));
    case 'describe_model':
      return MODEL_DESCRIPTION;
    case 'explore_dax':
      return exploreDax(env, String(a.dax ?? ''));
    default:
      throw new Error(`Unknown action ${action}`);
  }
}
