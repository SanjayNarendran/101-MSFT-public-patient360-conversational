/**
 * The Discovery tab's page logic: a port of the local Cohort Discovery page (apps/discovery/index.html), wired to
 * Fabric instead of a local server.
 *
 * - Data (ontology, query preview and runs, history, data requests) comes from this app's `discovery` Rayfin
 *   Function, which runs the DAX on the semantic model and records runs in the CRC store as the signed-in user.
 * - The chat goes to the GitHub Copilot relay (apps/discovery/relay) with a chat ticket from the `chatTicket`
 *   function. The relay streams the same events as the local app; for each tool call it sends `tool_request`, which
 *   this page runs through the `discovery` function and answers with POST /api/tool-result.
 * - Each user signs in to GitHub once in a popup, so their questions use their own Copilot plan.
 */
import { api, type ChatTicket } from '@/lib/api';

import { drawVisual } from './visual';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STARTERS: Record<string, [string, [string, string][]][]> = {
  i2b2: [
    ['Multi-panel questions', [
      ['How many adults aged 50 to 79 who are current or former smokers had a low-dose chest CT showing a lung nodule of 8 mm or more, with no lung cancer diagnosis?', 'Five panels: age bands, smoking status, procedure, measurement and NOT'],
      ['How many patients with type 2 diabetes and chronic kidney disease have had an HbA1c of 6.5% or higher at least twice, but have never been prescribed metformin?', 'Two diagnoses, a repeated lab value and NOT'],
      ['How many patients aged 65 or older with heart failure and hypertension have had an eGFR below 60 at least twice and two or more inpatient stays?', 'Five panels, two of them repeated'],
      ['How many former smokers have a lung nodule of at least 8 mm in either upper lobe?', 'Two location modifiers ORed in one panel'],
      ['How many patients had a low-dose chest CT and an abnormal lung imaging finding at the same visit, excluding anyone with COPD or emphysema?', 'Same visit, with an exclusion at any time'],
      ['How many women with breast cancer have had a mammogram and have a surgical pathology report?', 'Demographics, diagnosis, procedure and document type'],
      ['How many patients with hypertension and a BMI of 30 or more have been prescribed a statin since 2020?', 'A drug class folder with a date and a measurement'],
    ]],
    ['One feature each', [
      ['How many adults aged 50 or older are former smokers with a lung nodule of at least 6 mm?', 'Age bands, a coded answer and a measurement'],
      ['How many patients with type 2 diabetes have never been prescribed metformin?', 'A diagnosis folder AND NOT a medication'],
      ['How many patients have a lung nodule of at least 8 mm in the right upper lobe?', 'A measurement with a location modifier'],
      ['How many patients aged 65 or older with heart failure have had an inpatient stay?', 'Demographics, diagnosis and visit type'],
      ['How many patients have had an eGFR below 60 at least twice?', 'A lab value, repeated'],
      ['How many patients were diagnosed with COPD or emphysema since 2020?', 'OR within a panel, with a date'],
      ['How many patients with lung cancer have a pathology report?', 'A diagnosis folder and a document type'],
      ['How many current daily smokers have COPD?', 'A small count: shown as fewer than 4'],
    ]],
  ],
  dax: [
    ['Examples', [
      ['How many patients are there by sex and age band?', 'Counts by two demographic columns'],
      ['How many patients had a low-dose CT of the chest in each year since 2020?', 'Counts by year from observation dates'],
      ['Among patients with type 2 diabetes, how many have each diabetes medication class?', 'Counts across an ontology folder'],
    ]],
  ],
};
const TOOL_WORDS: Record<string, string> = {
  search_ontology: 'Searching the ontology', browse_ontology: 'Browsing the ontology', list_modifiers: 'Reading the modifiers',
  preview_query: 'Checking the query', run_i2b2_query: 'Running the i2b2 query', list_queries: 'Reading the query history',
  get_query: 'Opening a query', submit_request: 'Submitting the request', request_status: 'Checking the request',
  describe_model: 'Reading the semantic model', explore_dax: 'Running DAX', show_visual: 'Drawing a chart',
};
const BREAKDOWNS = [['Age patient breakdown', 'Age'], ['Gender patient breakdown', 'Gender'], ['Race patient breakdown', 'Race'], ['Vital Status patient breakdown', 'Vital status']];
const QUERY_TOOLS = new Set(['preview_query', 'run_i2b2_query']);
const REQUEST_TOOLS = new Set(['submit_request', 'request_status']);
const GITHUB_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/* ------------------------------------------------------------------ wording for the query (same rules as the request page) */
const OPS: Record<string, string> = { GT: '>', GE: '≥', LT: '<', LE: '≤', EQ: '=', NE: '≠' };
const valueText = (v: Any) => {
  const unit = v.value_unit_of_measure ? ` ${v.value_unit_of_measure}` : '';
  if (v.value_type === 'TEXT') return `${String(v.value_operator).toLowerCase()} ${v.value_constraint}`;
  if (v.value_operator === 'BETWEEN') return `between ${v.value_constraint}${unit}`;
  return `${OPS[v.value_operator] || v.value_operator} ${v.value_constraint}${unit}`;
};
const lastPart = (key: string) => String(key || '').replace(/\\+$/, '').split('\\').pop();
const itemName = (it: Any) => it.item_name || lastPart(it.item_key);
const dateText = (f: string | null, t: string | null) => (f && t ? `${f} to ${t}` : f ? `from ${f}` : t ? `until ${t}` : '');
function itemCons(it: Any): string[] {
  const out: string[] = [];
  if (it.constrain_by_value) out.push(valueText(it.constrain_by_value));
  const m = it.constrain_by_modifier;
  if (m) out.push((m.modifier_name || lastPart(m.modifier_key)) + (m.constrain_by_value ? ' ' + valueText(m.constrain_by_value) : ''));
  const d = it.constrain_by_date && dateText(it.constrain_by_date.date_from, it.constrain_by_date.date_to);
  if (d) out.push(d);
  return out;
}

/* ------------------------------------------------------------------ chat markdown */
function md(text: string): string {
  const blocks: string[] = [];
  const s = esc(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, _l, code) => { blocks.push(`<pre>${code}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t: string) => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const out: string[] = [];
  let list: { t: string; items: string[] } | null = null;
  let table: string[] | null = null;
  const flush = () => {
    if (list) { out.push(`<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; }
    if (table) {
      const [h, ...rows] = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const cells = (r: string) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim());
      out.push(`<table><thead><tr>${cells(h).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      table = null;
    }
  };
  for (const line of s.split('\n')) {
    let m: RegExpMatchArray | null;
    if (/^\s*\|.*\|\s*$/.test(line)) { if (list) flush(); (table = table || []).push(line); continue; }
    if (table) flush();
    if ((m = line.match(/^\s*[-*] (.*)/))) { if (list && list.t !== 'ul') flush(); (list = list || { t: 'ul', items: [] }).items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)] (.*)/))) { if (list && list.t !== 'ol') flush(); (list = list || { t: 'ol', items: [] }).items.push(m[1]); continue; }
    flush();
    if ((m = line.match(/^#{1,4} (.*)/))) out.push(`<h4>${inline(m[1])}</h4>`);
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  // eslint-disable-next-line no-control-regex -- \u0000 brackets the code-block placeholders set above
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]).replace(/<p>(<pre>[\s\S]*?<\/pre>)<\/p>/g, '$1');
}

const SKELETON = `
<div class="disc-bar">
  <button type="button" class="btn rail-toggle" data-id="railToggle" aria-expanded="false">Ontology and history</button>
  <div class="seg" role="group" aria-label="Mode">
    <button type="button" data-mode="i2b2" aria-pressed="true" title="Build and run i2b2 queries (recorded, can be submitted)">i2b2 query</button>
    <button type="button" data-mode="dax" aria-pressed="false" title="Free DAX on the semantic model (counts only, not recorded)">DAX explore</button>
  </div>
  <span class="spacer"></span>
  <select class="field" data-id="model" aria-label="Copilot model" hidden></select>
  <select class="field" data-id="effort" aria-label="Thinking level" hidden></select>
  <span data-id="account" class="gh"></span>
</div>
<div class="layout">
  <aside class="col rail" aria-label="Ontology and history">
    <div class="col-head">
      <div class="seg" role="tablist">
        <button type="button" data-rail="ontology" aria-pressed="true">Ontology</button>
        <button type="button" data-rail="history" aria-pressed="false">History</button>
      </div>
    </div>
    <div data-id="railOntology" class="col" style="flex:1">
      <div class="search"><input class="field" data-id="search" type="search" placeholder="Search terms, e.g. nodule, E11, metformin" autocomplete="off" /></div>
      <div class="tree scroll" data-id="tree"></div>
    </div>
    <div data-id="railHistory" class="scroll" hidden style="flex:1"></div>
  </aside>
  <section class="col" aria-label="Chat with Copilot">
    <div class="messages scroll" data-id="messages"></div>
    <div class="composer">
      <div class="composer-inner">
        <textarea class="field" data-id="input" rows="1" placeholder="Ask a cohort question"></textarea>
        <button type="button" class="btn btn-primary" data-id="send">Ask</button>
      </div>
      <div class="composer-meta"><span data-id="modeNote">i2b2 mode: every run is recorded with a QUERY_MASTER_ID; counts are obfuscated.</span><button type="button" class="chip-link" data-id="newChat">New conversation</button></div>
    </div>
  </section>
  <aside class="col side" aria-label="The query">
    <div class="side-body scroll" data-id="side"></div>
  </aside>
</div>`;

/** Builds the tab inside `root` and returns a function that tears it down. */
export function mountDiscovery(root: HTMLElement): () => void {
  root.innerHTML = SKELETON;
  const $ = (id: string) => root.querySelector(`[data-id="${id}"]`) as Any;
  const timers: number[] = [];
  let alive = true;
  let reading: AbortController | null = null;

  const S: Any = {
    mode: 'i2b2', chatId: null, busy: false, models: [], defaultEffort: 'medium', github: null as null | { login: string },
    builder: { query_timing: 'ANY', panels: [{ items: [] }] }, target: 0, builderNote: '',
    result: null, request: null, daxRuns: [], numeric: {}, history: [], currentQm: null, editing: null,
  };

  /* ------------------------------------------------------------------ the app's functions and the chat relay */
  async function server<T = Any>(action: string, args: Any = {}): Promise<T> {
    const r = await api.discovery<T>(action, args);
    if (!r.ok) throw new Error(r.error || 'The request failed.');
    return r.data as T;
  }

  let T: ChatTicket | null = null;
  async function ticket(force = false): Promise<ChatTicket> {
    if (!force && T && T.expiresAt - Date.now() / 1000 > 300) return T;
    T = await api.chatTicket();
    return T;
  }
  async function relay(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const t = await ticket();
    const res = await fetch(t.chatUrl + path, { ...init, headers: { ...(init.headers as Record<string, string> || {}), 'X-Chat-Ticket': t.ticket } });
    if (res.status === 401 && retry) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'ticket') { await ticket(true); return relay(path, init, false); }
    }
    return res;
  }
  async function relayJson(path: string, body?: unknown): Promise<Any> {
    const res = await relay(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `The chat service answered ${res.status}.`), { code: data.code });
    return data;
  }

  /* ------------------------------------------------------------------ GitHub sign-in */
  const startUrl = (t: ChatTicket) => `${t.chatUrl}/auth/github/start?origin=${encodeURIComponent(location.origin)}&ticket=${encodeURIComponent(t.ticket)}`;
  function renderAccount(error?: string) {
    const box = $('account');
    if (error) { box.innerHTML = `<span class="alert" title="${esc(error)}">Chat service unavailable</span>`; return; }
    box.innerHTML = S.github
      ? `${GITHUB_ICON}<span title="Questions use this account's GitHub Copilot plan">${esc(S.github.login)}</span><button type="button" class="chip-link" data-id="signout">Sign out</button>`
      : `<button type="button" class="btn btn-ink" data-id="signin">${GITHUB_ICON}<span style="margin-left:6px">Sign in with GitHub</span></button>`;
    const out = $('signout'); if (out) out.onclick = signOut;
    const inn = $('signin'); if (inn) inn.onclick = signIn;
    $('model').hidden = !S.github;
    if (!S.github) $('effort').hidden = true;
    const card = root.querySelector('.signin-card') as Any;
    if (card) card.hidden = !!S.github;
  }
  async function loadAccount() {
    try {
      const me = await relayJson('/api/me');
      S.github = me.github;
      renderAccount();
      if (S.github) await loadModels();
    } catch (e: Any) { renderAccount(e.message); }
  }
  let waiting = 0;
  function signIn() {
    const fresh = T && T.expiresAt - Date.now() / 1000 > 300;
    const w = window.open(fresh ? startUrl(T!) : '', 'cohort-github', 'popup,width=560,height=720');
    if (!fresh) ticket(true).then((t) => { if (w) w.location.href = startUrl(t); }).catch((e) => renderAccount(e.message));
    // The popup reports back by postMessage; when the app's isolation policy blocks that, polling notices the sign-in.
    const started = Date.now();
    const id = ++waiting;
    const poll = async () => {
      if (!alive || id !== waiting || S.github || Date.now() - started > 180_000) return;
      await loadAccount();
      if (!S.github) timers.push(window.setTimeout(poll, 2500));
    };
    timers.push(window.setTimeout(poll, 2500));
  }
  async function signOut() {
    await relayJson('/api/signout', {}).catch(() => undefined);
    S.github = null; S.chatId = null; renderAccount();
  }
  const onMessage = (e: MessageEvent) => {
    if (T && e.origin === new URL(T.chatUrl).origin && e.data && e.data.type === 'cohort-github') loadAccount();
  };
  window.addEventListener('message', onMessage);

  /* ------------------------------------------------------------------ models */
  async function loadModels() {
    const m = await relayJson('/api/models');
    S.models = m.models;
    $('model').innerHTML = m.models.filter((x: Any) => x.id !== 'auto').map((x: Any) => `<option value="${esc(x.id)}">${esc(x.name || x.id)}</option>`).join('');
    $('model').value = localStorage.getItem('cohort-model') || m.default;
    if (!$('model').value) $('model').value = m.default;
    S.defaultEffort = m.default_effort;
    efforts();
  }
  function efforts() {
    const model = S.models.find((x: Any) => x.id === $('model').value);
    const list: string[] = (model && model.efforts) || [];
    $('effort').hidden = !list.length;
    $('effort').innerHTML = list.map((e) => `<option value="${e}">${e === 'none' ? 'No thinking' : 'Thinking: ' + e}</option>`).join('');
    const saved = localStorage.getItem('cohort-effort');
    if (list.length) $('effort').value = saved && list.includes(saved) ? saved : list.includes(S.defaultEffort) ? S.defaultEffort : (model.default_effort || list[0]);
  }
  $('model').onchange = () => { localStorage.setItem('cohort-model', $('model').value); efforts(); S.chatId = null; };
  $('effort').onchange = () => { localStorage.setItem('cohort-effort', $('effort').value); S.chatId = null; };

  /* ------------------------------------------------------------------ mode */
  function setMode(mode: string) {
    if (S.busy || mode === S.mode) return;
    S.mode = mode; S.chatId = null;
    root.querySelectorAll('[data-mode]').forEach((b: Any) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('modeNote').textContent = mode === 'i2b2'
      ? 'i2b2 mode: every run is recorded with a QUERY_MASTER_ID; counts are obfuscated.'
      : 'DAX mode: free DAX on the Cohort Discovery model; counts only, obfuscated, nothing recorded.';
    $('input').placeholder = mode === 'i2b2' ? 'Ask a cohort question' : 'Ask a count question to answer with DAX';
    $('messages').innerHTML = ''; welcome(); renderSide();
  }
  root.querySelectorAll('[data-mode]').forEach((b: Any) => (b.onclick = () => setMode(b.dataset.mode)));

  /* ------------------------------------------------------------------ ontology browser */
  const nodeHtml = (n: Any) => {
    const folder = n.kind === 'folder' || n.kind === 'container';
    if (n.numeric_values) S.numeric[n.item_key] = true;
    return `<div class="node-wrap"><div class="node${folder ? ' folder' : ''}" data-key="${esc(n.item_key)}" data-name="${esc(n.name)}">
      <button class="node-toggle" aria-label="Open" ${folder ? '' : 'style="visibility:hidden"'}>▸</button>
      <span class="node-name" title="${esc(n.path || n.name)}">${esc(n.name)}</span>
      <span class="node-count">${esc(n.patients)}</span>
      <button class="node-add" title="Add to the selected panel" aria-label="Add ${esc(n.name)}">+</button></div></div>`;
  };
  async function openFolder(nodeEl: Any) {
    const wrap = nodeEl.parentElement, toggle = nodeEl.querySelector('.node-toggle');
    const existing = wrap.querySelector(':scope > .children');
    if (existing) { existing.remove(); toggle.classList.remove('open'); return; }
    toggle.classList.add('open');
    const box = document.createElement('div');
    box.className = 'children enter'; box.innerHTML = '<div class="node-count" style="padding:4px 8px">Loading…</div>';
    wrap.appendChild(box);
    try { box.innerHTML = (await server<Any[]>('browse_ontology', { path: nodeEl.dataset.key })).map(nodeHtml).join('') || '<div class="node-count" style="padding:4px 8px">Empty</div>'; }
    catch (e: Any) { box.innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
  }
  $('tree').onclick = (e: Any) => {
    const node = e.target.closest('.node');
    if (!node) return;
    if (e.target.closest('.node-add')) return addItem({ item_key: node.dataset.key, item_name: node.dataset.name });
    if (node.classList.contains('folder')) openFolder(node);
  };
  async function loadRoots() {
    $('tree').innerHTML = '<p class="muted" style="padding:8px 10px">Loading the ontology…</p>';
    try { $('tree').innerHTML = (await server<Any[]>('browse_ontology', {})).map(nodeHtml).join(''); }
    catch (e: Any) { $('tree').innerHTML = `<p class="alert" style="margin:10px">${esc(e.message)}</p>`; }
  }
  let searchTimer: number | undefined;
  $('search').oninput = () => {
    clearTimeout(searchTimer);
    const q = $('search').value.trim();
    if (!q) { loadRoots(); return; }
    searchTimer = window.setTimeout(async () => {
      try {
        const hits = await server<Any[]>('search_ontology', { text: q, limit: 30 });
        $('tree').innerHTML = hits.map((n) => nodeHtml(n).replace('</span>\n      <span class="node-count">', `<span class="hit-path">${esc(n.path)}</span></span>\n      <span class="node-count">`)).join('')
          || '<p class="muted" style="padding:8px 10px">No terms found.</p>';
      } catch (e: Any) { $('tree').innerHTML = `<p class="alert" style="margin:10px">${esc(e.message)}</p>`; }
    }, 300);
  };

  /* ------------------------------------------------------------------ history */
  async function loadHistory() {
    try {
      S.history = await server<Any[]>('list_queries', { limit: 30 });
      $('railHistory').innerHTML = S.history.map((q: Any) => `<button class="history-item${q.QUERY_MASTER_ID === S.currentQm ? ' current' : ''}" data-id="${q.QUERY_MASTER_ID}">
        <span class="hi-top"><span class="mono">${q.QUERY_MASTER_ID}</span><span>${esc(q.PATIENT_COUNT)}${q.REQUEST_STATUS ? ' · ' + esc(String(q.REQUEST_STATUS).toLowerCase()) : ''}</span></span>
        <span class="hi-q">${esc(q.NL_QUESTION || q.NAME)}</span></button>`).join('') || '<p class="muted" style="padding:14px 16px">No queries yet.</p>';
    } catch (e: Any) { $('railHistory').innerHTML = `<p class="alert" style="margin:10px">${esc(e.message)}</p>`; }
  }
  $('railHistory').onclick = async (e: Any) => {
    const b = e.target.closest('.history-item');
    if (!b) return;
    try {
      const q = await server<Any>('query_detail', { query_master_id: Number(b.dataset.id) });
      if (S.mode !== 'i2b2') setMode('i2b2');
      S.builder = normalise(q.definition); S.target = 0; S.currentQm = q.QUERY_MASTER_ID; S.builderNote = q.NL_QUESTION || '';
      S.result = { query_master_id: q.QUERY_MASTER_ID, query_name: q.NAME, patient_count_display: q.PATIENT_COUNT, breakdowns: q.BREAKDOWNS || {}, summary: q.QUERY_SUMMARY, question: q.NL_QUESTION };
      S.request = q.request || null;
      renderSide(true); loadHistory();
    } catch (err: Any) { toast(err.message); }
  };
  function showRail(which: string) {
    root.querySelectorAll('[data-rail]').forEach((b: Any) => b.setAttribute('aria-pressed', String(b.dataset.rail === which)));
    $('railOntology').hidden = which !== 'ontology'; $('railHistory').hidden = which !== 'history';
    if (which === 'history') loadHistory();
  }
  root.querySelectorAll('[data-rail]').forEach((b: Any) => (b.onclick = () => showRail(b.dataset.rail)));

  /* ------------------------------------------------------------------ the query builder */
  function normalise(def: Any) {
    const d = def || {};
    const panels = (d.panels || []).map((p: Any) => ({
      items: (p.items || []).map((it: Any) => ({ ...it })), invert: p.invert ? 1 : 0, panel_timing: p.panel_timing || 'ANY',
      total_item_occurrences: p.total_item_occurrences || 1, panel_date_from: p.panel_date_from || null, panel_date_to: p.panel_date_to || null,
    }));
    return { query_timing: d.query_timing || 'ANY', panels: panels.length ? panels : [{ items: [] }] };
  }
  function builderQuery() {
    const panels = S.builder.panels.filter((p: Any) => p.items.length).map((p: Any) => {
      const out: Any = { items: p.items.map((it: Any) => {
        const c: Any = { item_key: it.item_key, item_name: it.item_name || '' };
        ['constrain_by_value', 'constrain_by_modifier', 'constrain_by_date'].forEach((k) => { if (it[k]) c[k] = it[k]; });
        return c;
      }) };
      if (p.invert) out.invert = 1;
      if ((p.total_item_occurrences || 1) > 1) out.total_item_occurrences = Number(p.total_item_occurrences);
      if (p.panel_date_from) out.panel_date_from = p.panel_date_from;
      if (p.panel_date_to) out.panel_date_to = p.panel_date_to;
      if (S.builder.query_timing === 'SAMEVISIT' && p.panel_timing === 'SAMEVISIT') out.panel_timing = 'SAMEVISIT';
      return out;
    });
    return { query_timing: S.builder.query_timing, panels };
  }
  function addItem(item: Any) {
    if (S.mode !== 'i2b2') setMode('i2b2');
    const panel = S.builder.panels[S.target] || S.builder.panels[S.builder.panels.length - 1];
    if (!panel.items.some((x: Any) => x.item_key === item.item_key)) panel.items.push(item);
    S.result = null; S.request = null; S.currentQm = null;
    renderSide(); flash(`.panel[data-i="${S.builder.panels.indexOf(panel)}"]`);
    root.classList.remove('rail-open');
  }
  function flash(sel: string) { const el = root.querySelector(sel) as Any; if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

  function panelHtml(p: Any, i: number) {
    const items = p.items.map((it: Any, j: number) => {
      const numeric = S.numeric[it.item_key] || it.constrain_by_value;
      const v = it.constrain_by_value || {};
      return `${j ? '<div class="or">or</div>' : ''}<div class="chip" title="${esc(it.item_key)}">
        <span class="chip-body"><span class="chip-name">${esc(itemName(it))}</span>
          ${itemCons(it).map((c) => `<span class="chip-cons">${esc(c)}</span>`).join('')}
          ${numeric && S.editing !== `${i}:${j}` ? `<button class="chip-link" data-edit="${i}:${j}" style="margin-top:4px">${v.value_operator ? 'Change value' : 'Add a value'}</button>` : ''}
          ${numeric && S.editing === `${i}:${j}` ? `<div class="chip-edit" data-p="${i}" data-j="${j}">
            <select class="field" data-f="op">${['', 'GT', 'GE', 'LT', 'LE', 'EQ', 'BETWEEN'].map((o) => `<option value="${o}" ${v.value_operator === o ? 'selected' : ''}>${o ? (OPS[o] || 'between') : 'any value'}</option>`).join('')}</select>
            <input class="field" data-f="val" placeholder="value" value="${esc(v.value_constraint || '')}" style="width:80px" />
            <input class="field" data-f="unit" placeholder="unit" value="${esc(v.value_unit_of_measure || '')}" style="width:60px" /></div>` : ''}
        </span><button class="chip-x" data-p="${i}" data-j="${j}" aria-label="Remove ${esc(itemName(it))}">×</button></div>`;
    }).join('');
    const tags: string[] = [];
    if (p.invert) tags.push('<span class="tag tag-not">NOT</span>');
    if ((p.total_item_occurrences || 1) > 1) tags.push(`<span class="tag">at least ${p.total_item_occurrences} times</span>`);
    if (S.builder.query_timing === 'SAMEVISIT' && p.panel_timing === 'SAMEVISIT') tags.push('<span class="tag">same visit</span>');
    const dt = dateText(p.panel_date_from, p.panel_date_to); if (dt) tags.push(`<span class="tag">${esc(dt)}</span>`);
    const selected = i === S.target;
    return `${i ? `<span class="joiner${p.invert ? ' not' : ''}">${p.invert ? 'AND NOT' : 'AND'}</span>` : ''}
      <div class="panel${p.invert ? ' not' : ''}${selected ? ' target' : ''}" data-i="${i}">
        <div class="panel-head"><span>Panel ${i + 1}${selected ? ' · new terms go here' : ' · select to edit'}</span><span class="panel-tags">${tags.join('')}</span></div>
        ${items || '<div class="panel-empty">Add terms with + in the ontology, or ask Copilot.</div>'}
        ${selected ? `<div class="panel-ctl" data-i="${i}">
          <label><input type="checkbox" data-f="invert" ${p.invert ? 'checked' : ''}/> Exclude (NOT)</label>
          <label>at least <input class="field" type="number" min="1" data-f="occ" value="${p.total_item_occurrences || 1}"/> times</label>
          <label>from <input class="field" type="date" data-f="from" value="${p.panel_date_from || ''}"/></label>
          <label>to <input class="field" type="date" data-f="to" value="${p.panel_date_to || ''}"/></label>
          ${S.builder.query_timing === 'SAMEVISIT' ? `<label><input type="checkbox" data-f="same" ${p.panel_timing === 'SAMEVISIT' ? 'checked' : ''}/> same visit</label>` : ''}
          ${S.builder.panels.length > 1 ? '<button class="chip-link" data-f="remove">Remove panel</button>' : ''}
        </div>` : ''}
      </div>`;
  }

  function barsHtml(breakdowns: Any) {
    const groups = BREAKDOWNS.filter(([k]) => breakdowns && breakdowns[k]);
    if (!groups.length) return '';
    return `<div class="bars-grid">${groups.map(([k, title]) => {
      const cells = Object.entries(breakdowns[k]) as [string, Any][];
      const max = Math.max(1, ...cells.map(([, n]) => Number(n) || 0));
      return `<div><h3 class="h3">${title}</h3><div class="bars">${cells.map(([c, n]) => `<span class="bar-label" title="${esc(c)}">${esc(c)}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block" data-w="${((Number(n) || 0) / max) * 100}"></span></span>
        <span class="bar-value${Number(n) ? '' : ' zero'}">${esc(n)}</span>`).join('')}</div></div>`;
    }).join('')}</div><p class="note">Each count is obfuscated on its own, so categories don't add up exactly to the total.</p>`;
  }
  function growBars() { requestAnimationFrame(() => root.querySelectorAll('.bar-fill[data-w]').forEach((b: Any) => { b.style.width = b.dataset.w + '%'; })); }

  function requestHtml() {
    const r = S.request;
    if (!r) return `<div><h3 class="h3">Request the data</h3>
        <p class="note" style="margin:0 0 8px">Submitting creates a data request. It is approved or rejected on the Requests tab, and delivered after approval.</p>
        <div class="row"><input class="field" data-id="title" placeholder="Title for the request" style="flex:1;min-width:200px" />
        <button class="btn btn-ink" data-id="submit">Submit request</button></div></div>`;
    const decided = r.DECIDED_BY ? ` by ${esc(r.DECIDED_BY)}` : '';
    return `<div><h3 class="h3">Data request</h3>
      <p style="margin:0 0 8px"><span class="status status-${esc(r.STATUS)}">${esc(r.STATUS[0] + String(r.STATUS).slice(1).toLowerCase())}</span><span class="muted">${decided}${r.DELIVERY_LAKEHOUSE ? ` · delivered to <span class="mono">${esc(r.DELIVERY_LAKEHOUSE)}</span>` : ''}</span></p>
      <p style="margin:0"><b>${esc(r.TITLE)}</b></p>
      <p style="margin:10px 0 0"><a class="btn" href="#/requests/${esc(r.QUERY_MASTER_ID)}">Open the request page</a></p></div>`;
  }

  function renderSide(animate = false) {
    const side = $('side');
    if (S.mode === 'dax') {
      side.innerHTML = `<div class="enter"><div class="col-title">DAX exploration</div>
        <p class="note">Copilot writes DAX against the Cohort Discovery semantic model. Only patient counts come back, obfuscated, and nothing is recorded. To record a query and request its data, switch to i2b2 query.</p></div>
        ${S.daxRuns.length ? S.daxRuns.map((d: Any) => `<div class="dax-run enter">
          <div class="tl-meta">${esc(d.purpose || 'DAX query')}</div>
          <details ${d.result ? '' : 'open'}><summary>DAX</summary><pre class="xml">${esc(d.dax)}</pre></details>
          ${d.error ? `<p class="alert">${esc(d.error)}</p>` : d.result ? daxTable(d.result) : '<p class="activity">Running…</p>'}</div>`).join('')
          : '<p class="empty-side">Results appear here as Copilot runs them.</p>'}`;
      return;
    }
    const res = S.result;
    side.innerHTML = `<div class="${animate ? 'enter' : ''}">
        <div class="row" style="justify-content:space-between;margin-bottom:12px">
          <div class="col-title">The i2b2 query</div>
          <div class="row">
            <label class="muted" style="font-size:12px;display:inline-flex;gap:5px;align-items:center"><input type="checkbox" data-id="sameVisit" ${S.builder.query_timing === 'SAMEVISIT' ? 'checked' : ''}/> Same visit</label>
            <button class="chip-link" data-id="addPanel">Add panel</button>
            <button class="chip-link" data-id="clear">Clear</button>
          </div>
        </div>
        <div class="panels" data-id="panels">${S.builder.panels.map(panelHtml).join('')}</div>
        <div class="row" style="margin-top:14px">
          <input class="field" data-id="note" placeholder="Question for the record (optional)" value="${esc(S.builderNote)}" style="flex:1;min-width:180px" />
          <button class="btn btn-primary" data-id="run" ${S.builder.panels.some((p: Any) => p.items.length) ? '' : 'disabled'}>Run query</button>
        </div>
        <p class="note" data-id="sideMsg"></p>
      </div>
      <div class="${animate ? 'enter' : ''}" data-id="resultBox">${res ? `
        <div class="col-title" style="margin-bottom:10px">Result</div>
        <p class="eyebrow">QUERY_MASTER_ID <span class="mono">${esc(res.query_master_id)}</span> · <span class="mono">${esc(res.query_name)}</span></p>
        <div class="count tnum">${esc(String(res.patient_count_display || '').replace(' ±3', ''))}<small>${String(res.patient_count_display || '').includes('±') ? '±3 patients, obfuscated' : 'patients'}</small></div>
        ${res.question ? `<p class="note">“${esc(res.question)}”</p>` : ''}
        <div style="margin-top:18px">${barsHtml(res.breakdowns)}</div>
        <div style="margin-top:22px;border-top:1px solid var(--border);padding-top:16px">${requestHtml()}</div>` : '<p class="empty-side">Run the query, or ask Copilot, to see the obfuscated count and breakdowns.</p>'}
      </div>`;
    growBars();
    wireSide();
  }
  function daxTable(r: Any) {
    if (!r.rows || !r.rows.length) return '<p class="muted">No rows.</p>';
    return `<table class="table" style="font-size:12.5px"><thead><tr>${r.columns.map((c: string) => `<th${typeof r.rows[0][c] === 'number' ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map((row: Any) => `<tr>${r.columns.map((c: string) => typeof row[c] === 'number' ? `<td class="num">${row[c] === 0 ? '<span class="muted">&lt;4</span>' : esc(row[c])}</td>` : `<td>${esc(row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <p class="note">Obfuscated counts (about ±3); &lt;4 means 3 or fewer.</p>`;
  }
  function changed() { S.result = null; S.request = null; S.currentQm = null; renderSide(); }
  function wireSide() {
    const side = $('side');
    side.querySelectorAll('.panel').forEach((el: Any) => (el.onclick = (e: Any) => {
      if (e.target.closest('input,select,button,label')) return;
      S.target = Number(el.dataset.i); renderSide();
    }));
    side.querySelectorAll('[data-edit]').forEach((b: Any) => (b.onclick = () => { S.editing = b.dataset.edit; renderSide(); }));
    side.querySelectorAll('.chip-x').forEach((b: Any) => (b.onclick = () => { S.builder.panels[b.dataset.p].items.splice(Number(b.dataset.j), 1); changed(); }));
    side.querySelectorAll('.chip-edit').forEach((box: Any) => {
      const upd = () => {
        const it = S.builder.panels[box.dataset.p].items[box.dataset.j];
        const op = box.querySelector('[data-f=op]').value, val = box.querySelector('[data-f=val]').value.trim(), unit = box.querySelector('[data-f=unit]').value.trim();
        if (op && val) it.constrain_by_value = { value_operator: op, value_constraint: val, value_type: 'NUMBER', ...(unit ? { value_unit_of_measure: unit } : {}) };
        else delete it.constrain_by_value;
        S.result = null; S.request = null;
      };
      box.querySelectorAll('select,input').forEach((f: Any) => (f.onchange = () => { upd(); S.editing = null; renderSide(); }));
    });
    side.querySelectorAll('.panel-ctl').forEach((box: Any) => {
      const p = S.builder.panels[box.dataset.i];
      box.querySelector('[data-f=invert]').onchange = (e: Any) => { p.invert = e.target.checked ? 1 : 0; changed(); };
      box.querySelector('[data-f=occ]').onchange = (e: Any) => { p.total_item_occurrences = Math.max(1, Number(e.target.value) || 1); changed(); };
      box.querySelector('[data-f=from]').onchange = (e: Any) => { p.panel_date_from = e.target.value || null; changed(); };
      box.querySelector('[data-f=to]').onchange = (e: Any) => { p.panel_date_to = e.target.value || null; changed(); };
      const same = box.querySelector('[data-f=same]'); if (same) same.onchange = (e: Any) => { p.panel_timing = e.target.checked ? 'SAMEVISIT' : 'ANY'; changed(); };
      const rm = box.querySelector('[data-f=remove]'); if (rm) rm.onclick = () => { S.builder.panels.splice(Number(box.dataset.i), 1); S.target = 0; changed(); };
    });
    const sv = $('sameVisit'); if (sv) sv.onchange = (e: Any) => { S.builder.query_timing = e.target.checked ? 'SAMEVISIT' : 'ANY'; changed(); };
    const ap = $('addPanel'); if (ap) ap.onclick = () => { S.builder.panels.push({ items: [] }); S.target = S.builder.panels.length - 1; changed(); };
    const cl = $('clear'); if (cl) cl.onclick = () => { S.builder = normalise(null); S.target = 0; S.builderNote = ''; changed(); };
    const note = $('note'); if (note) note.oninput = (e: Any) => { S.builderNote = e.target.value; };
    const run = $('run'); if (run) run.onclick = runByHand;
    const sub = $('submit'); if (sub) sub.onclick = submit;
  }
  async function runByHand() {
    const query = builderQuery();
    $('run').disabled = true; $('sideMsg').textContent = 'Running on the Cohort Discovery semantic model…';
    $('resultBox').classList.add('busy-veil');
    try {
      const q = S.builderNote.trim() || 'Built by hand in the query builder';
      const r = await server<Any>('run_i2b2_query', { query_definition: query, nl_question: q });
      S.result = { ...r, question: q }; S.request = null; S.currentQm = r.query_master_id;
      renderSide(true); loadHistory();
    } catch (e: Any) {
      $('sideMsg').innerHTML = `<span class="alert" style="display:block">${esc(e.message)}</span>`;
      $('run').disabled = false; $('resultBox').classList.remove('busy-veil');
    }
  }
  async function submit() {
    const title = ($('title').value || '').trim();
    $('submit').disabled = true;
    try { S.request = await server('submit_request', { query_master_id: S.result.query_master_id, title }); renderSide(); loadHistory(); }
    catch (e: Any) { toast(e.message); $('submit').disabled = false; }
  }
  // Follow the request while the tab is shown (Pending -> Approved -> Delivered happens on the Requests tab).
  const shown = () => !document.hidden && root.offsetParent !== null;
  async function followRequest() {
    if (!S.request || ['DELIVERED', 'REJECTED'].includes(S.request.STATUS) || !shown()) return;
    try {
      const r = await server<Any>('request_status', { query_master_id: S.request.QUERY_MASTER_ID });
      if (r.STATUS !== S.request.STATUS) { S.request = r; renderSide(); loadHistory(); }
    } catch { /* try again next time */ }
  }
  timers.push(window.setInterval(followRequest, 15_000));
  // The app keeps this tab mounted but hidden on the Requests tab; catch up when it is shown again.
  const onHash = () => timers.push(window.setTimeout(() => { if (shown()) { loadHistory(); followRequest(); } }, 100));
  window.addEventListener('hashchange', onHash);

  /* ------------------------------------------------------------------ chat */
  function welcome() {
    const list = STARTERS[S.mode];
    $('messages').innerHTML = `<div class="welcome enter">
      <div class="signin signin-card" ${S.github ? 'hidden' : ''}>
        <p>Copilot answers on your own GitHub Copilot plan. Sign in with the GitHub account that has your Copilot seat; the sign-in is kept while the chat service runs.</p>
        <button type="button" class="btn btn-ink" data-id="signin2">${GITHUB_ICON}<span style="margin-left:6px">Sign in with GitHub</span></button>
      </div>
      <p class="eyebrow">${S.mode === 'i2b2' ? 'Cohort feasibility with i2b2' : 'Exploration with DAX'}</p>
      <h1 class="headline" style="font-size:34px">${S.mode === 'i2b2' ? 'Ask how many patients match your criteria.' : 'Ask a count question, answered in DAX.'}</h1>
      <p class="lede">${S.mode === 'i2b2'
        ? 'Copilot finds the terms in the i2b2 ontology, builds the query on the right and runs it on the Cohort Discovery semantic model in Microsoft Fabric. Every run gets a QUERY_MASTER_ID. You can also build or change the query by hand.'
        : 'Copilot writes DAX against the Cohort Discovery semantic model. Counts come back obfuscated and nothing is recorded.'}</p>
      ${list.map(([group, items]) => `<h3 class="h3" style="margin:22px 0 0">${esc(group)}</h3>
        <div class="starters" style="margin-top:10px">${items.map(([q, why]) => `<button class="starter" data-q="${esc(q)}">${esc(q)}<small>${esc(why)}</small></button>`).join('')}</div>`).join('')}</div>`;
    $('messages').querySelectorAll('.starter').forEach((b: Any) => (b.onclick = () => ask(b.dataset.q)));
    const s2 = $('signin2'); if (s2) s2.onclick = signIn;
  }
  function addMsg(who: string, html: string) {
    const w = $('messages').querySelector('.welcome'); if (w) w.remove();
    const el = document.createElement('div');
    el.className = `msg ${who} enter`;
    el.innerHTML = `<div class="msg-who">${who === 'user' ? 'You' : 'Copilot'}</div><div class="msg-body">${html}</div>`;
    $('messages').appendChild(el); scrollDown();
    return el;
  }
  const scrollDown = () => { const m = $('messages'); m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' }); };
  function setBusy(b: boolean) {
    S.busy = b; $('send').textContent = b ? 'Stop' : 'Ask';
    $('send').classList.toggle('btn-primary', !b); $('send').classList.toggle('btn-ink', b);
  }

  /** Runs one tool call for Copilot through the app's functions, updates the page as the local app does, answers the relay. */
  async function runTool(ev: Any, chatId: string, handle: (e: Any) => void, visuals: HTMLElement) {
    const args = ev.arguments || {};
    let ok = false, text = '';
    try {
      if (ev.name === 'show_visual') {
        const box = document.createElement('div');
        box.className = 'visual enter';
        box.innerHTML = `<p class="visual-title">${esc(args.title || 'Chart')}</p><div class="visual-body"></div>${args.caption ? `<p class="visual-caption">${esc(args.caption)}</p>` : ''}`;
        visuals.appendChild(box);
        try { await drawVisual(box.querySelector('.visual-body') as HTMLElement, args.spec); ok = true; text = 'The chart is shown in the chat.'; scrollDown(); }
        catch (e: Any) { box.remove(); text = `show_visual failed: the chart could not be drawn (${e.message}). Fix the Vega-Lite spec or describe the result in words.`; }
      } else {
        if (QUERY_TOOLS.has(ev.name) && args.query_definition) handle({ type: 'query', definition: args.query_definition, running: ev.name === 'run_i2b2_query' });
        if (ev.name === 'explore_dax') handle({ type: 'dax', dax: args.dax || '', purpose: args.purpose || '' });
        const r = await api.discovery<Any>(ev.name, args);
        if (r.ok) {
          ok = true; text = JSON.stringify(r.data, null, 2);
          if (ev.name === 'run_i2b2_query') handle({ type: 'result', result: r.data });
          else if (ev.name === 'preview_query') handle({ type: 'preview', result: r.data });
          else if (REQUEST_TOOLS.has(ev.name)) handle({ type: 'request', request: r.data });
          else if (ev.name === 'explore_dax') handle({ type: 'dax_result', dax: args.dax || '', purpose: args.purpose || '', result: r.data });
        } else {
          text = `${ev.name} failed: ${r.error}`;
          if (QUERY_TOOLS.has(ev.name)) handle({ type: 'query_error', text: String(r.error).slice(0, 600) });
          if (ev.name === 'explore_dax') handle({ type: 'dax_result', dax: args.dax || '', error: String(r.error).slice(0, 800) });
        }
      }
    } catch (e: Any) { text = `${ev.name} failed: ${e.message}`; }
    await relayJson('/api/tool-result', { chat_id: chatId, id: ev.id, ok, text }).catch(() => undefined);
  }

  async function ask(input?: string) {
    const text = (input || $('input').value).trim();
    if (!text || S.busy) return;
    if (!S.github) { signIn(); return; }
    $('input').value = ''; autosize();
    addMsg('user', esc(text));
    const reply = addMsg('assistant', '');
    const body = reply.querySelector('.msg-body') as Any;
    const tools = document.createElement('div'); reply.insertBefore(tools, body);
    const visuals = document.createElement('div'); reply.insertBefore(visuals, body);
    const status = document.createElement('div'); status.className = 'activity'; reply.appendChild(status);
    const started = Date.now();
    let phase = 'Thinking', texts: Record<string, string> = {}, order: string[] = [], chatId = S.chatId;
    const tick = window.setInterval(() => { status.textContent = `${phase} · ${Math.round((Date.now() - started) / 1000)}s`; }, 500);
    setBusy(true);
    const render = () => { body.innerHTML = md(order.map((id) => texts[id]).join('\n\n')); };
    const handle = (ev: Any) => {
      switch (ev.type) {
        case 'chat': S.chatId = chatId = ev.chat_id; break;
        case 'thinking': phase = 'Thinking'; break;
        case 'delta': if (!texts[ev.id]) { texts[ev.id] = ''; order.push(ev.id); } texts[ev.id] += ev.text; phase = 'Writing'; render(); scrollDown(); break;
        case 'message': if (!texts[ev.id]) order.push(ev.id); texts[ev.id] = ev.text; render(); break;
        case 'tool': {
          if (order.length) {
            const n = document.createElement('div'); n.className = 'tool-note'; n.textContent = order.map((id) => texts[id]).join(' ').trim();
            if (n.textContent) tools.appendChild(n);
            texts = {}; order = []; render();
          }
          const t = document.createElement('div'); t.className = 'tool-line'; t.dataset.call = ev.id; t.textContent = TOOL_WORDS[ev.name] || ev.name;
          tools.appendChild(t); phase = TOOL_WORDS[ev.name] || 'Working'; scrollDown(); break;
        }
        case 'tool_done': { const t = tools.querySelector(`[data-call="${CSS.escape(ev.id)}"]`); if (t) t.classList.add(ev.ok ? 'done' : 'fail'); phase = 'Thinking'; break; }
        case 'tool_request': runTool(ev, chatId, handle, visuals); break;
        case 'query': S.builder = normalise(ev.definition); S.target = 0; if (ev.running) { S.result = null; S.request = null; } renderSide(); flash('[data-id="panels"]');
          if (ev.running) { const rb = $('resultBox'); if (rb) rb.innerHTML = '<p class="activity">Running the query on the semantic model…</p>'; } break;
        case 'query_error': { const m = $('sideMsg'); if (m) m.innerHTML = `<span class="alert" style="display:block">${esc(ev.text)}</span>`; break; }
        case 'preview': S.builder = normalise(ev.result.query_definition); renderSide(); break;
        case 'result': S.result = { ...ev.result, question: text }; S.request = null; S.currentQm = ev.result.query_master_id; S.builderNote = text; renderSide(true); loadHistory(); break;
        case 'request': if (ev.request && ev.request.STATUS) { S.request = ev.request; renderSide(); loadHistory(); } break;
        case 'dax': S.daxRuns.unshift({ dax: ev.dax, purpose: ev.purpose }); renderSide(); break;
        case 'dax_result': {
          let d = S.daxRuns.find((x: Any) => x.dax === ev.dax && !x.result && !x.error);
          if (!d) { S.daxRuns.unshift({ dax: ev.dax }); d = S.daxRuns[0]; }
          d.purpose = d.purpose || ev.purpose; if (ev.error) d.error = ev.error; else d.result = ev.result; renderSide(); break;
        }
        case 'error': body.innerHTML += `<p class="alert">${esc(ev.text)}</p>`; break;
      }
    };
    reading = new AbortController();
    try {
      const res = await relay('/api/chat', {
        method: 'POST', signal: reading.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, mode: S.mode, chat_id: S.chatId, model: $('model').value, effort: $('effort').hidden ? null : $('effort').value,
          builder: S.mode === 'i2b2' ? builderQuery() : null, last_run: S.result && S.result.query_master_id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.code === 'github') { S.github = null; renderAccount(); }
        throw new Error(err.error || `The chat service answered ${res.status}.`);
      }
      const reader = res.body!.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.trim()) handle(JSON.parse(line));
        }
      }
    } catch (e: Any) { if (e.name !== 'AbortError') body.innerHTML += `<p class="alert">${esc(e.message)}</p>`; }
    reading = null;
    clearInterval(tick); status.remove(); setBusy(false);
    if (!body.textContent.trim() && !body.querySelector('.alert') && !visuals.childElementCount) body.innerHTML = '<p class="muted">Stopped.</p>';
  }
  async function stop() { if (S.chatId) await relayJson('/api/stop', { chat_id: S.chatId }).catch(() => undefined); }
  $('send').onclick = () => (S.busy ? stop() : ask());
  const autosize = () => { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(180, t.scrollHeight) + 'px'; };
  $('input').oninput = autosize;
  $('input').onkeydown = (e: Any) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } };
  $('newChat').onclick = () => { if (S.busy) return; S.chatId = null; S.daxRuns = []; $('messages').innerHTML = ''; welcome(); renderSide(); };

  $('railToggle').onclick = () => { const open = root.classList.toggle('rail-open'); $('railToggle').setAttribute('aria-expanded', String(open)); };
  const onDocClick = (e: Any) => {
    if (root.classList.contains('rail-open') && !e.target.closest('.rail, [data-id="railToggle"]')) { root.classList.remove('rail-open'); $('railToggle').setAttribute('aria-expanded', 'false'); }
  };
  document.addEventListener('click', onDocClick);

  function toast(text: string) { const m = $('sideMsg'); if (m) m.innerHTML = `<span class="alert" style="display:block">${esc(text)}</span>`; else window.alert(text); }

  welcome(); renderSide(); loadRoots(); renderAccount(); loadAccount();
  // Keep the chat ticket fresh, so the GitHub sign-in popup can open straight away.
  timers.push(window.setInterval(() => { if (!document.hidden) ticket().catch(() => undefined); }, 4 * 60_000));

  return () => {
    alive = false;
    reading?.abort();
    if (S.busy) stop();
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    window.removeEventListener('message', onMessage);
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('click', onDocClick);
    root.innerHTML = '';
  };
}
