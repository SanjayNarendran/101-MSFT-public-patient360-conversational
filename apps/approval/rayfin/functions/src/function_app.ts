/*
 * Cohort data request functions: the server side of the approval app.
 *
 * The app's data lives in the Cohort_Requests Fabric SQL database (schema crc): the i2b2 CRC query tables written by
 * the cohort discovery tools, plus COHORT_REQUEST and COHORT_REQUEST_EVENT. Deployed functions reach it, and the
 * Fabric job API, as the app identity (the owner of the Fabric app item). The person deciding is the signed-in app
 * user, read from the invocation's Rayfin token, so every decision is recorded under the approver's own name.
 *
 * Counts here are the obfuscated ones the i2b2 CRC stores in SET_SIZE; true counts and patient numbers never leave the
 * database.
 */
import { createHmac } from 'node:crypto';

import { AudienceType, UserDataFunctions, type RayfinContext } from '@microsoft/fabric-user-data-functions';
import sql from 'mssql';

import { CONFIG } from './config.generated.js';
import { discoveryAction } from './discovery.js';

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Schema = Record<string, never>;

export type RequestSummary = {
  QUERY_MASTER_ID: number;
  TITLE: string;
  QUERY_NAME: string;
  NL_QUESTION: string | null;
  STATUS: string;
  PATIENT_COUNT_DISPLAY: string | null;
  REQUESTED_BY: string;
  REQUESTED_AT: string;
  DECIDED_BY: string | null;
  DECIDED_AT: string | null;
  DELIVERED_AT: string | null;
};

export type RequestDetail = {
  request: Row;
  definition: string | null;
  breakdown: { BREAKDOWN: string; CATEGORY: string; PATIENTS: number }[];
  events: { EVENT: string; ACTOR: string; EVENT_AT: string; DETAIL: string | null }[];
  delivery: DeliveryJob | null;
  /** Links to what was delivered, however the delivery was started (app, pipeline, notebook or CLI). */
  delivered: { lakehouse: { name: string; url: string | null }; notebook: { name: string; url: string | null } | null } | null;
  /** The cohort's patients in Patient 360, once the request is approved (scripts/27_patient360_app.py deployed it). */
  patient360: string | null;
  viewer: string;
};

export type DeliveryStep = { at: string; event: string; detail: string | null };

/** What the Discovery tab needs to reach the GitHub Copilot relay as the signed-in user. */
export type ChatTicket = { ticket: string; expiresAt: number; chatUrl: string; user: string };

export type DeliveryJob = {
  jobId: string;
  runner: string;
  status: string;
  demo: boolean;
  startedBy: string;
  requestedAt: string;
  startTimeUtc: string | null;
  endTimeUtc: string | null;
  failureReason: string | null;
  steps: DeliveryStep[];
  lakehouse: { name: string; url: string | null } | null;
  notebook: { name: string; url: string | null } | null;
  runnerUrl: string;
};

const DECISIONS = ['APPROVED', 'REJECTED'];
const FABRIC_API = 'https://api.fabric.microsoft.com/v1';

/* ------------------------------------------------------------------ SQL */

let cached: { token: string; pool: sql.ConnectionPool } | null = null;

async function db(token: string): Promise<sql.ConnectionPool> {
  if (!CONFIG.sqlServer) throw new Error('The approval app is not configured: run scripts/22_approval_app.py.');
  if (cached && cached.token === token && cached.pool.connected) return cached.pool;
  if (cached) void cached.pool.close().catch(() => undefined);
  const pool = new sql.ConnectionPool({
    server: CONFIG.sqlServer,
    database: CONFIG.sqlDatabase,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
    requestTimeout: 60_000,
    connectionTimeout: 30_000,
  });
  await pool.connect();
  cached = { token, pool };
  return pool;
}

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

function rows(result: sql.IResult<Record<string, unknown>>): Row[] {
  return (result.recordset ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));
}

async function query(pool: sql.ConnectionPool, text: string, params: Record<string, number | string | null> = {}) {
  const request = pool.request();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number') request.input(k, sql.Int, v);
    else request.input(k, sql.NVarChar(1000), v);
  }
  return rows(await request.query(text));
}

/* ------------------------------------------------------------------ the signed-in user */

function requireId(queryMasterId: number): number {
  const id = Number(queryMasterId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Give the request number (QUERY_MASTER_ID).');
  return id;
}

async function event(pool: sql.ConnectionPool, id: number, name: string, actor: string, detail: string | null) {
  await query(
    pool,
    `INSERT INTO crc.COHORT_REQUEST_EVENT (QUERY_MASTER_ID, EVENT, ACTOR, EVENT_AT, DETAIL)
     VALUES (@id, @event, @actor, SYSUTCDATETIME(), @detail)`,
    { id, event: name, actor, detail }
  );
}

const SUMMARY_COLUMNS = `QUERY_MASTER_ID, TITLE, QUERY_NAME, NL_QUESTION, STATUS, PATIENT_COUNT_DISPLAY, REQUESTED_BY,
  REQUESTED_AT, DECIDED_BY, DECIDED_AT, DELIVERED_AT`;
const DETAIL_COLUMNS = `QUERY_MASTER_ID, TITLE, QUERY_NAME, NL_QUESTION, QUERY_SUMMARY, I2B2_QUERY_XML, QUERY_LANGUAGE,
  QUERY_USER, QUERY_CREATED_AT, PATIENT_COUNT_DISPLAY, OBFUSC_METHOD, STATUS, REQUESTED_BY, REQUESTED_AT, DECIDED_BY,
  DECIDED_AT, DECISION_COMMENT, DELIVERED_BY, DELIVERED_AT, DELIVERY_LAKEHOUSE, DELIVERED_PATIENTS`;

/* ------------------------------------------------------------------ delivery jobs (Fabric job scheduler) */

async function fabric(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${FABRIC_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The app user behind this call. In Fabric-hosted apps the Rayfin token carries no name or email: its `sub` is a path
 * ending in /users/<Entra object ID>. The object ID is matched against the workspace's role assignments (read with the
 * app identity's Fabric token) to get the user principal name; someone who isn't a direct workspace member is recorded
 * by object ID.
 */
const names = new Map<string, string>();

/** The Entra object ID in the invocation's Rayfin token (its oid claim, or the last segment of its sub path). */
function callerOid(accessToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return String(payload.oid ?? payload.sub ?? '').split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
}

async function caller(ctx: { accessToken: string }, fabricToken: string): Promise<string> {
  let oid = '';
  try {
    const payload = JSON.parse(Buffer.from(ctx.accessToken.split('.')[1], 'base64url').toString('utf8'));
    for (const claim of ['upn', 'email', 'preferred_username']) {
      if (typeof payload[claim] === 'string' && payload[claim].includes('@')) return payload[claim];
    }
    oid = String(payload.oid ?? payload.sub ?? '').split('/').filter(Boolean).pop() ?? '';
  } catch {
    /* not a JWT */
  }
  if (!/^[0-9a-f-]{36}$/i.test(oid)) throw new Error('Could not tell who is signed in; sign in again.');
  if (!names.has(oid)) {
    const res = await fabric(fabricToken, 'GET', `/workspaces/${CONFIG.workspaceId}/roleAssignments`);
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

const PORTAL = 'https://app.fabric.microsoft.com';

/** The portal link of a delivered item (the lakehouse, or the notebook next to it), found by name. */
async function itemUrl(fabricToken: string, kind: 'lakehouses' | 'notebooks', name: string): Promise<string | null> {
  const res = await fabric(fabricToken, 'GET', `/workspaces/${CONFIG.workspaceId}/${kind}`);
  if (!res.ok) return null;
  const found = ((await res.json()) as { value?: { id: string; displayName: string }[] }).value?.find((i) => i.displayName === name);
  const segment = kind === 'lakehouses' ? 'lakehouses' : 'synapsenotebooks';
  return found ? `${PORTAL}/groups/${CONFIG.workspaceId}/${segment}/${found.id}` : null;
}

/** The latest delivery of a request: the pipeline (or notebook) run, its recorded steps and, once done, the lakehouse. */
async function latestDelivery(pool: sql.ConnectionPool, id: number, fabricToken: string): Promise<DeliveryJob | null> {
  const [last] = await query(
    pool,
    `SELECT TOP 1 EVENT_ID, ACTOR, EVENT_AT, DETAIL FROM crc.COHORT_REQUEST_EVENT
     WHERE QUERY_MASTER_ID = @id AND EVENT = 'DELIVERY_REQUESTED' ORDER BY EVENT_ID DESC`,
    { id }
  );
  const detail = String(last?.DETAIL ?? '');
  const jobId = detail.match(/job ([0-9a-f-]{36})/i)?.[1];
  if (!last || !jobId) return null;
  const isNotebook = /notebook/i.test(detail);
  const itemId = isNotebook ? CONFIG.deliveryNotebookId : CONFIG.deliveryPipelineId;
  const steps = (await query(
    pool,
    `SELECT EVENT_AT, EVENT, DETAIL FROM crc.COHORT_REQUEST_EVENT
     WHERE QUERY_MASTER_ID = @id AND EVENT_ID > @after AND EVENT IN ('DELIVERY_STARTED', 'DELIVERY_PROGRESS', 'DELIVERED')
     ORDER BY EVENT_ID`,
    { id, after: Number(last.EVENT_ID) }
  )).map((r) => ({ at: String(r.EVENT_AT), event: String(r.EVENT), detail: (r.DETAIL as string) ?? null }));
  const job: DeliveryJob = {
    jobId, runner: isNotebook ? 'Cohort_Delivery notebook' : 'Cohort_Delivery_Pipeline', status: 'Unknown',
    demo: /demo/i.test(detail), startedBy: String(last.ACTOR), requestedAt: String(last.EVENT_AT),
    startTimeUtc: null, endTimeUtc: null, failureReason: null, steps, lakehouse: null, notebook: null,
    runnerUrl: `${PORTAL}/groups/${CONFIG.workspaceId}/${isNotebook ? 'synapsenotebooks' : 'pipelines'}/${itemId}`,
  };
  const res = await fabric(fabricToken, 'GET', `/workspaces/${CONFIG.workspaceId}/items/${itemId}/jobs/instances/${jobId}`);
  if (res.ok) {
    const body = (await res.json()) as Record<string, unknown>;
    job.status = String(body.status ?? 'Unknown');
    job.startTimeUtc = (body.startTimeUtc as string) ?? null;
    job.endTimeUtc = (body.endTimeUtc as string) ?? null;
    const failure = body.failureReason as { message?: string } | null;
    job.failureReason = failure?.message ?? null;
  }
  const done = steps.find((s) => s.event === 'DELIVERED');
  const name = done?.detail?.match(/ to (\S+)$/)?.[1];
  if (name) {
    const links = await deliveredLinks(fabricToken, name);
    job.lakehouse = links.lakehouse;
    job.notebook = links.notebook;
  }
  return job;
}

/** The delivery lakehouse and the Explore_<name without Delivery_> notebook created next to it (research_notebook.py). */
async function deliveredLinks(fabricToken: string, name: string): Promise<NonNullable<RequestDetail['delivered']>> {
  const notebook = `Explore_${name.replace(/^Delivery_/, '')}`;
  const [lakehouse, explore] = await Promise.all([itemUrl(fabricToken, 'lakehouses', name), itemUrl(fabricToken, 'notebooks', notebook)]);
  return { lakehouse: { name, url: lakehouse }, notebook: explore ? { name: notebook, url: explore } : null };
}

/** The folder of this app's item: delivery lakehouses are created next to the app (null = workspace root). */
async function appFolder(fabricToken: string): Promise<string | null> {
  const res = await fabric(fabricToken, 'GET', `/workspaces/${CONFIG.workspaceId}/items?type=AppBackend`);
  if (!res.ok) return null;
  const items = ((await res.json()) as { value?: { displayName: string; folderId?: string }[] }).value ?? [];
  return items.find((i) => i.displayName === CONFIG.appName)?.folderId ?? null;
}

/* ------------------------------------------------------------------ functions */

const udf = new UserDataFunctions();

/** Who the app sees as signed in (shown in the header; also proves the identity used for decisions). */
udf.func(
  'whoAmI',
  async (ctx: RayfinContext<Schema, AudienceType.Sql | AudienceType.Fabric>): Promise<string> => caller(ctx, ctx.Tokens.Fabric),
  []
);

/** Every data request, newest first, with its obfuscated count and status. */
udf.func(
  'listRequests',
  async (ctx: RayfinContext<Schema, AudienceType.Sql>): Promise<RequestSummary[]> => {
    const pool = await db(ctx.Tokens.Sql);
    return (await query(pool, `SELECT ${SUMMARY_COLUMNS} FROM crc.V_REQUEST ORDER BY QUERY_MASTER_ID DESC`)) as unknown as RequestSummary[];
  },
  []
);

/** Patient 360's list of a request's patients; only for approved and delivered requests (Cohort Discovery stays counts-only). */
function patient360Link(id: number, status: string): string | null {
  const base = ((CONFIG as { patient360Url?: string }).patient360Url ?? '').replace(/\/$/, '');
  return base && (status === 'APPROVED' || status === 'DELIVERED') ? `${base}/?request=${id}` : null;
}

/** One request: the question, the i2b2 query, counts by category, the audit trail and the latest delivery job. */
udf.func(
  'getRequest',
  async (queryMasterId: number, ctx: RayfinContext<Schema, AudienceType.Sql | AudienceType.Fabric>): Promise<RequestDetail> => {
    const id = requireId(queryMasterId);
    const pool = await db(ctx.Tokens.Sql);
    const [request] = await query(pool, `SELECT ${DETAIL_COLUMNS} FROM crc.V_REQUEST WHERE QUERY_MASTER_ID = @id`, { id });
    if (!request) throw new Error(`There is no data request ${id}.`);
    const [context] = await query(pool, `SELECT QUERY_DEFINITION_JSON FROM crc.COHORT_QUERY_CONTEXT WHERE QUERY_MASTER_ID = @id`, { id });
    const breakdown = await query(
      pool,
      `SELECT BREAKDOWN, CATEGORY, PATIENTS FROM crc.V_REQUEST_BREAKDOWN WHERE QUERY_MASTER_ID = @id ORDER BY SORT_ORDER`,
      { id }
    );
    const events = await query(
      pool,
      `SELECT EVENT, ACTOR, EVENT_AT, DETAIL FROM crc.V_REQUEST_EVENT WHERE QUERY_MASTER_ID = @id ORDER BY EVENT_ID`,
      { id }
    );
    return {
      request,
      definition: (context?.QUERY_DEFINITION_JSON as string) ?? null,
      breakdown: breakdown as unknown as RequestDetail['breakdown'],
      events: events as unknown as RequestDetail['events'],
      delivery: await latestDelivery(pool, id, ctx.Tokens.Fabric),
      delivered: request.DELIVERY_LAKEHOUSE ? await deliveredLinks(ctx.Tokens.Fabric, String(request.DELIVERY_LAKEHOUSE)) : null,
      patient360: patient360Link(id, String(request.STATUS)),
      viewer: await caller(ctx, ctx.Tokens.Fabric),
    };
  },
  []
);

/** Approve or reject a pending request; records the signed-in user and the time (UTC). A request is decided once. */
udf.func(
  'decideRequest',
  async (
    queryMasterId: number,
    decision: string,
    comment: string,
    ctx: RayfinContext<Schema, AudienceType.Sql | AudienceType.Fabric>
  ): Promise<string> => {
    const id = requireId(queryMasterId);
    const choice = String(decision ?? '').trim().toUpperCase();
    if (!DECISIONS.includes(choice)) throw new Error('The decision must be APPROVED or REJECTED.');
    const who = await caller(ctx, ctx.Tokens.Fabric);
    const note = String(comment ?? '').trim().slice(0, 1000) || null;
    const pool = await db(ctx.Tokens.Sql);
    const updated = await query(
      pool,
      `UPDATE crc.COHORT_REQUEST SET STATUS = @status, DECIDED_BY = @who, DECIDED_AT = SYSUTCDATETIME(),
         DECISION_COMMENT = @note OUTPUT INSERTED.DECIDED_AT WHERE QUERY_MASTER_ID = @id AND STATUS = 'PENDING'`,
      { id, status: choice, who, note }
    );
    if (updated.length === 0) {
      const [current] = await query(pool, `SELECT STATUS, DECIDED_BY FROM crc.COHORT_REQUEST WHERE QUERY_MASTER_ID = @id`, { id });
      if (!current) throw new Error(`There is no data request ${id}.`);
      throw new Error(`Request ${id} is already ${String(current.STATUS).toLowerCase()} (by ${current.DECIDED_BY}).`);
    }
    await event(pool, id, choice, who, note);
    return `Request ${id} ${choice.toLowerCase()} by ${who} at ${String(updated[0].DECIDED_AT).slice(0, 16)} UTC.`;
  },
  []
);

/**
 * Starts Cohort_Delivery_Pipeline for an approved (or already delivered) request: a new lakehouse next to this app,
 * named after the request. Demo mode delivers a small sample to keep a live demo short.
 */
udf.func(
  'startDelivery',
  async (queryMasterId: number, demoMode: boolean, ctx: RayfinContext<Schema, AudienceType.Sql | AudienceType.Fabric>): Promise<DeliveryJob> => {
    const id = requireId(queryMasterId);
    const who = await caller(ctx, ctx.Tokens.Fabric);
    const pool = await db(ctx.Tokens.Sql);
    const [current] = await query(pool, `SELECT STATUS FROM crc.COHORT_REQUEST WHERE QUERY_MASTER_ID = @id`, { id });
    if (!current) throw new Error(`There is no data request ${id}.`);
    if (!['APPROVED', 'DELIVERED'].includes(String(current.STATUS))) {
      throw new Error(`Request ${id} is ${String(current.STATUS).toLowerCase()}; only approved requests can be delivered.`);
    }
    const running = await latestDelivery(pool, id, ctx.Tokens.Fabric);
    if (running && ['NotStarted', 'InProgress'].includes(running.status)) return running;
    const demo = demoMode === true || String(demoMode).toLowerCase() === 'true';
    const folder = await appFolder(ctx.Tokens.Fabric);
    const res = await fabric(
      ctx.Tokens.Fabric,
      'POST',
      `/workspaces/${CONFIG.workspaceId}/items/${CONFIG.deliveryPipelineId}/jobs/instances?jobType=Pipeline`,
      { executionData: { parameters: { QUERY_MASTER_ID: id, DEMO_MODE: demo, DELIVERY_FOLDER_ID: folder ?? '' } } }
    );
    if (res.status !== 202) throw new Error(`Fabric did not start the delivery (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const jobId = (res.headers.get('location') ?? '').split('/').pop() ?? '';
    await event(pool, id, 'DELIVERY_REQUESTED', who, `Cohort_Delivery_Pipeline${demo ? ' in demo mode' : ''}, job ${jobId}`);
    return (await latestDelivery(pool, id, ctx.Tokens.Fabric))!;
  },
  []
);

/** The latest delivery job of a request (polled while it runs). */
udf.func(
  'getDelivery',
  async (queryMasterId: number, ctx: RayfinContext<Schema, AudienceType.Sql | AudienceType.Fabric>): Promise<DeliveryJob | null> => {
    const id = requireId(queryMasterId);
    return latestDelivery(await db(ctx.Tokens.Sql), id, ctx.Tokens.Fabric);
  },
  []
);

/* ------------------------------------------------------------------ Discovery tab */

/**
 * One action of the Discovery tab: a chat tool (search_ontology, run_i2b2_query, explore_dax, ...; the same names and
 * arguments as the MCP tools) or a page action (query_detail). The payload and the result are JSON text; failures come
 * back as {ok: false, error} so the page can show them and Copilot can correct its call.
 */
udf.func(
  'discovery',
  async (action: string, payload: string, ctx: RayfinContext<Schema, AudienceType.Sql | AudienceType.Fabric>): Promise<string> => {
    try {
      const args = payload ? JSON.parse(payload) : {};
      const data = await discoveryAction(String(action ?? ''), args && typeof args === 'object' ? args : {}, {
        fabricToken: ctx.Tokens.Fabric,
        pool: () => db(ctx.Tokens.Sql),
        user: () => caller(ctx, ctx.Tokens.Fabric),
      });
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  []
);

/**
 * A chat ticket for the GitHub Copilot relay: the signed-in user's Entra object ID and name with a 30-minute expiry,
 * signed with the CHAT_TICKET_KEY secret the relay shares. The relay serves nobody without one.
 */
udf.func(
  'chatTicket',
  async (ctx: RayfinContext<Schema, AudienceType.Fabric>): Promise<ChatTicket> => {
    const oid = callerOid(ctx.accessToken);
    if (!/^[0-9a-f-]{36}$/i.test(oid)) throw new Error('Could not tell who is signed in; sign in again.');
    if (!CONFIG.chatUrl) throw new Error('The chat relay is not configured: run scripts/23_discovery_chat.py deploy, then scripts/22_approval_app.py.');
    const user = await caller(ctx, ctx.Tokens.Fabric);
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
    const body = Buffer.from(JSON.stringify({ oid, upn: user, exp: expiresAt })).toString('base64url');
    const signature = createHmac('sha256', ctx.Secrets.CHAT_TICKET_KEY).update(body).digest('base64url');
    return { ticket: `${body}.${signature}`, expiresAt, chatUrl: CONFIG.chatUrl, user };
  },
  []
);
