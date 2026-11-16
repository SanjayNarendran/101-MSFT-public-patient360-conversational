/* 01 Data unification. Fig 1 plays, a step at a time, how each source reaches OneLake: the Epic tables (a stack of
   plates that turns through SQL Server on premises, Snowflake, Azure Databricks and another Fabric workspace, each with
   its own way in), the PACS database by mirroring, the images and documents in ADLS by shortcuts, then every source in
   one lake; a Future step puts Epic Cogito Cloud, shared from Epic's Fabric tenant, on top of the stack. OneLake is
   on the left and the sources on the right. A shortcut is drawn as a dashed pointer from OneLake to the source, its
   dashes marching toward the source; mirroring is a solid line with rows streaming into OneLake. Fig 2 shows,
   hypothetically, how Data Factory and Spark would bring in formats nothing else reads. The SVG is drawn from the data
   below; CSS does the motion, keyed off the stage and row classes set here. */
(function () {
  'use strict';

  const { ICON, reduceMotion, esc, image, pill, legend, fitLegends, LAKE, LAKE_ITEMS, stepper, setLedger } = window.FigKit;

  // Fig 1 geometry, in viewBox units: OneLake on the left (the box from figkit.js), the way in across the middle, the
  // sources on the right. Each source card has the height of the item it feeds and shares its centre line, so the two
  // sides line up box for box.
  const { VB_W, JOIN_X, ITEM_X, ITEM_W, ITEM_H, PANEL_W, TOP, BOTTOM, ROW_Y } = LAKE;
  const SRC_X = 750, SRC_W = VB_W - SRC_X, LANE_L = PANEL_W + 4, LANE_R = SRC_X - 4, CARD_H = ITEM_H;
  const VB_H = BOTTOM + 60;
  const MID = (LANE_L + LANE_R) / 2;

  // The Epic tables can be in any of four places. Their card is a stack of plates, SQL Server on top, that turns while
  // the row is in focus; the way in and the OneLake item follow the plate on top. The Future step puts a fifth plate,
  // Epic Cogito Cloud on Epic's own Fabric tenant, on the stack.
  const EHR_META = '54 tables, 3.9M rows', EHR_SUB = 'Epic Clarity and Caboodle';
  const PLATES = [
    { key: 'sql', colour: 'var(--sqlsrv)', kind: 'mirror', method: 'Mirroring', methodSub: 'through the on-premises data gateway',
      src: { icon: 'sql-server.svg', name: 'SQL Server on premises', sub: EHR_SUB, meta: EHR_META, tag: 'SQL' },
      dest: { icon: 'databases.svg', sub: 'Mirrored SQL Server databases', meta: '54 tables in Delta format', badges: ['DELTA'] } },
    { key: 'snow', colour: 'var(--snow)', kind: 'shortcut', method: 'Iceberg shortcut', methodSub: 'read as Delta tables',
      src: { icon: 'snowflake.svg', name: 'Snowflake', sub: EHR_SUB, meta: EHR_META, tag: 'ICEBERG' },
      dest: { icon: 'lakehouse.svg', sub: 'One lakehouse per Epic database', meta: '54 table shortcuts', badges: ['ICEBERG', 'DELTA'] } },
    { key: 'dbx', colour: 'var(--dbx)', kind: 'shortcut', method: 'Unity Catalog shortcuts', methodSub: 'through a mirrored catalog item',
      src: { icon: 'databricks.svg', name: 'Azure Databricks', sub: EHR_SUB, meta: EHR_META, tag: 'DELTA' },
      dest: { icon: 'mirrored-catalog.svg', sub: 'Mirrored Databricks catalogs', meta: '54 table shortcuts', badges: ['DELTA'] } },
    { key: 'fab', colour: 'var(--fabric)', kind: 'shortcut', method: 'OneLake shortcut', methodSub: 'to a lakehouse in that workspace',
      src: { icon: 'fabric.svg', name: 'Another Fabric workspace', sub: EHR_SUB, meta: EHR_META, tag: 'DELTA' },
      dest: { icon: 'lakehouse.svg', sub: 'One lakehouse per Epic database', meta: '54 table shortcuts', badges: ['DELTA'] } },
  ];
  const EPIC = { key: 'epic', colour: 'var(--fabric)', kind: 'shortcut', method: 'External data share', methodSub: 'a shortcut across tenants',
    tenant: 'Epic’s Fabric tenant',
    src: { logo: 'epic.svg', name: 'Epic Cogito Cloud', sub: 'Clarity and Caboodle', meta: EHR_META, tag: 'DELTA' },
    dest: { icon: 'lakehouse.svg', sub: 'One lakehouse per Epic database', meta: '54 tables shared by Epic', badges: ['DELTA'] } };

  const ROWS = [
    { step: 1, stack: [...PLATES, EPIC], dest: LAKE_ITEMS[0] },
    { step: 2, kind: 'mirror', method: 'Mirroring', methodSub: 'updated from the change feed',
      src: { glyph: 'cloud', name: 'Imaging vendor cloud', sub: 'PACS database', meta: '12,910 studies', tag: 'SQL' },
      dest: LAKE_ITEMS[1] },
    { step: 3, kind: 'shortcut', method: 'ADLS shortcut', methodSub: 'files read from ADLS',
      src: { icon: 'azure-storage.svg', name: 'Azure Data Lake Storage', sub: 'DICOM image archive', meta: '262,171 files, 289 GB', tag: 'DICOM' },
      dest: LAKE_ITEMS[2] },
    { step: 3, kind: 'shortcut', method: 'ADLS shortcut', methodSub: 'files read from ADLS',
      src: { icon: 'azure-storage.svg', name: 'Azure Data Lake Storage', sub: 'Clinical documents', meta: '17,910 documents', tag: 'TXT, PDF' },
      dest: LAKE_ITEMS[3] },
  ];

  const STEPS = [
    { chip: 'Before', label: 'Before',
      text: 'The first card turns through four places the Epic tables can be: SQL Server on premises, Snowflake, Azure Databricks and another Fabric workspace. The PACS index is in the imaging vendor’s cloud, and the images and documents are in Azure Data Lake Storage. A question that needs more than one of them starts with exports from each system.' },
    { chip: 'SQL Server', label: 'Step 1 of 4',
      text: 'SQL Server on premises is mirrored through the on-premises data gateway. Fabric copies the 54 Clarity and Caboodle tables into OneLake as Delta, then applies each change SQL Server records. Snowflake’s Iceberg tables are read through shortcuts, Azure Databricks shares its Unity Catalog as shortcuts to its Delta tables, and a lakehouse in another Fabric workspace needs only a OneLake shortcut. In this demo a setup script writes the tables into the two lakehouses as Delta.' },
    { chip: 'PACS', label: 'Step 2 of 4',
      text: 'The PACS index is a SQL database that the vendor’s system updates all the time, so there are no table files for a shortcut to read. Mirroring copies its six tables into OneLake as Delta and applies each change as it happens. A vendor can also send changes through open mirroring.' },
    { chip: 'Images and documents', label: 'Step 3 of 4',
      text: 'The DICOM archive and the documents are files in Azure Data Lake Storage. Shortcuts add their folders to the Files area of two lakehouses, Bronze_ImagingArchive and Bronze_ClinicalDocuments, which then list 262,171 images and 17,910 documents.' },
    { chip: 'All sources', label: 'Step 4 of 4',
      text: 'The workspace now holds 62 tables and about 280,000 files, all under the workspace’s permissions. MRN and accession number link each patient’s encounters, studies, images and reports, and one SQL query can join all four sources.' },
    { chip: 'Future', label: 'Future',
      text: 'Epic is rebuilding Cogito, which includes Clarity and Caboodle, as Cogito Cloud on Microsoft Fabric in Epic’s own tenant. Fabric external data sharing adds Epic’s tables to Bronze_Clarity and Bronze_Caboodle in the customer’s tenant as read-only shortcuts, and a change in Epic’s tenant shows there straight away.' },
  ];
  // "All sources" completes the picture (the join and the engines appear); "Future" then puts Epic on the stack
  const ALL = 4, FUTURE = 5;
  // How long each step holds while playing, in ms; the last one stays. Step 1 holds long enough for every plate.
  const HOLD = [2800, 11000, 7000, 7000, 7000];
  // The stack turns in these steps (the row is in focus); its first plate holds longer while its way in is drawn
  const TURNS = new Set([0, 1, ALL]), FIRST_MS = 3200, EVERY_MS = 2600;

  // A small ink cloud for the vendor's SaaS (no product mark of its own)
  const cloudGlyph = (x, y) => `<g class="u-glyph" transform="translate(${x} ${y})"><path d="M6.5 19.5h11.2a4.3 4.3 0 0 0 .6-8.55A6.2 6.2 0 0 0 6.4 12.2a3.7 3.7 0 0 0 .1 7.3z"/><path d="M9.5 15.2h5.6M9.5 17.4h3.4"/></g>`;
  // The same text layout as the items in the OneLake box: name, then the sub line, then the meta line with the tag
  const cardText = (s, x) => `<text class="u-name" x="${x}" y="-11">${esc(s.name)}</text>
      <text class="u-sub" x="${x}" y="7">${esc(s.sub)}</text>
      <text class="u-meta" x="${x}" y="24">${esc(s.meta)}</text>
      ${pill(s.tag, SRC_W - 10, 12)}`;
  // A plate of the Epic stack: its card in the plate's colour, its mark and its text
  function plate(p) {
    const s = p.src;
    const mark = s.logo ? `<image href="${ICON}${s.logo}" x="12" y="-23.25" width="44" height="16.5"/>` : image(s.icon, 12, -26, 22);
    return `<g class="u-plate" data-plate="${p.key}" style="--pc:${p.colour}">
      <rect class="u-card u-plate-card" x="0.75" y="${-CARD_H / 2 + 0.5}" width="${SRC_W - 1.5}" height="${CARD_H - 1}" rx="3"/>
      ${mark}${cardText(s, s.logo ? 66 : 44)}</g>`;
  }

  function sourceCard(r, y) {
    if (r.stack) {
      // Drawn back to front; the script gives each plate its place in the stack
      const tenant = r.stack.find((p) => p.tenant).tenant;
      return `<g class="u-src" transform="translate(${SRC_X} ${y})">
        <g class="u-stack">${r.stack.slice().reverse().map(plate).join('')}</g>
        <g class="u-fb" style="--fi:1.1s">${legend(12, -CARD_H / 2 + 0.5, [['icon', 'fabric.svg', 14, 5], ['text', tenant, 4, 0]], 'u-tenant u-tenant-card')}</g>
      </g>`;
    }
    const s = r.src;
    return `<g class="u-src" transform="translate(${SRC_X} ${y})">
      <rect class="u-card" x="0.75" y="${-CARD_H / 2 + 0.5}" width="${SRC_W - 1.5}" height="${CARD_H - 1}" rx="3"/>
      ${s.glyph ? cloudGlyph(11, -27) : image(s.icon, 12, -26, 22)}${cardText(s, 44)}</g>`;
  }

  // The way in. A shortcut is drawn from OneLake out to the source (a pointer, arrowhead at the source); a cover over
  // it shrinks toward the source so it reveals from the OneLake end. Mirroring draws from the source into OneLake,
  // with rows streaming along it (right to left). The stack has a way in per plate; the one on top shows.
  function laneFor(kind, method, methodSub, y, attr = '') {
    const head = kind === 'shortcut'
      ? `<path class="u-head" d="M${LANE_R - 8} ${y - 5}L${LANE_R} ${y}l-8 5"/><circle class="u-anchor" cx="${LANE_L}" cy="${y}" r="3"/>`
      : `<path class="u-head" d="M${LANE_L + 8} ${y - 5}L${LANE_L} ${y}l8 5"/><circle class="u-anchor" cx="${LANE_R}" cy="${y}" r="3"/>`;
    const line = kind === 'shortcut'
      ? `<line class="u-line" x1="${LANE_L}" y1="${y}" x2="${LANE_R}" y2="${y}"/>`
      : `<line class="u-line" x1="${LANE_R}" y1="${y}" x2="${LANE_L}" y2="${y}" pathLength="1"/>`;
    const run = -(LANE_R - LANE_L - 30);
    const packets = kind === 'mirror'
      ? [0, 1, 2, 3, 4].map((i) => `<rect class="u-packet" x="${LANE_R - 13}" y="${y - 3.5}" width="9" height="7" rx="1" style="animation-delay:${(-i * 0.56).toFixed(2)}s;--d:${run}px"/>`).join('')
      : '';
    // The cover starts just clear of the OneLake box's border and stops short of the source card's edge
    const cover = kind === 'shortcut' ? `<rect class="u-cover" x="${PANEL_W + 1}" y="${y - 8}" width="${SRC_X - PANEL_W - 2}" height="16"/>` : '';
    return `<g class="u-lane u-${kind}"${attr}>
      ${line}${packets}${head}${cover}
      <text class="u-method" x="${MID}" y="${y - 14}" text-anchor="middle">${esc(method)}</text>
      <text class="u-method-sub" x="${MID}" y="${y + 25}" text-anchor="middle">${esc(methodSub)}</text>
    </g>`;
  }
  function lane(r, y) {
    if (r.stack) return r.stack.map((p) => laneFor(p.kind, p.method, p.methodSub, y, ` data-for="${p.key}"`)).join('');
    return laneFor(r.kind, r.method, r.methodSub, y);
  }

  // The OneLake item. For the stack, its icon, sub and meta lines and format tag follow the plate on top; for
  // Snowflake the Iceberg tag turns into Delta as OneLake writes the Delta log.
  function destItem(r, y) {
    const d = r.dest;
    // The format tag sits at the bottom right, on the meta line, as the tags do on the source cards
    const lines = (v) => `${image(v.icon, 12, -26, 22)}<text class="u-sub" x="44" y="7">${esc(v.sub)}</text><text class="u-meta" x="44" y="24">${esc(v.meta)}</text>
      ${v.badges.map((b, i) => pill(b, ITEM_W - 10, 12, `u-badge u-badge-${i}`)).join('')}`;
    const body = r.stack
      ? r.stack.map((p) => `<g class="u-dvar${p.dest.badges.length > 1 ? ' u-flip' : ''}" data-for="${p.key}">${lines(p.dest)}</g>`).join('')
      : lines(d);
    return `<g class="u-dest" transform="translate(${ITEM_X} ${y})">
      <rect class="u-slot" x="0.5" y="${-ITEM_H / 2 + 0.5}" width="${ITEM_W - 1}" height="${ITEM_H - 1}" rx="3"/>
      <rect class="u-item" x="0.5" y="${-ITEM_H / 2 + 0.5}" width="${ITEM_W - 1}" height="${ITEM_H - 1}" rx="3"/>
      <g class="u-dest-body"><text class="u-name u-dest-name" x="44" y="-11">${esc(d.name)}</text>${body}</g>
    </g>`;
  }

  function drawFig1(host) {
    const rows = ROWS.map((r, i) => `<g class="u-row is-idle" data-row="${i}" data-step="${r.step}"${r.stack ? ' data-stack' : ''}>${sourceCard(r, ROW_Y[i])}${lane(r, ROW_Y[i])}${destItem(r, ROW_Y[i])}</g>`).join('');
    const first = ROW_Y[0], last = ROW_Y[ROW_Y.length - 1];
    const ticks = ROW_Y.map((y) => `<path d="M${ITEM_X} ${y}H${JOIN_X}"/><circle cx="${JOIN_X}" cy="${y}" r="3"/>`).join('');
    const engines = ['T‑SQL', 'Spark', 'Power BI', 'Fabric IQ'];
    let ex = 52;
    const engineChips = engines.map((e) => {
      const w = Math.round(e.length * 6 + 14);
      const g = `<g transform="translate(${ex} ${BOTTOM + 36})"><rect width="${w}" height="20" rx="2"/><text x="${w / 2}" y="14" text-anchor="middle">${esc(e)}</text></g>`;
      ex += w + 6;
      return g;
    }).join('');
    host.innerHTML = `<svg class="u-svg" viewBox="0 0 ${VB_W} ${VB_H}" aria-hidden="true">
      <rect class="u-panel" x="0.75" y="${TOP}" width="${PANEL_W - 1.5}" height="${BOTTOM - TOP}" rx="6"/>
      ${legend(12, TOP, [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel')}
      <g class="u-fb" style="--fi:1.3s">${legend(PANEL_W - 12, TOP, [['icon', 'fabric.svg', 14, 5], ['text', 'Customer’s Fabric tenant', 4, 0]], 'u-tenant', true)}</g>
      ${rows}
      <g class="u-join"><path class="u-join-line" d="M${JOIN_X} ${first}V${last}" pathLength="1"/>${ticks}
        <text class="u-join-label" x="${JOIN_X - 14}" y="${BOTTOM + 24}">Joined on MRN and accession number</text></g>
      <g class="u-engines"><text class="u-meta" x="2" y="${BOTTOM + 50}">Read by</text>${engineChips}</g>
    </svg>`;
  }

  // Fig 2 geometry: three legacy sources, Data Factory, then inside OneLake the raw files, a Spark notebook and Delta
  const LG = { w: 1000, h: 236, y: 128 };
  function drawFig2(host) {
    const srcs = [['Mainframe', 'COBOL files, EBCDIC'], ['IBM i (AS/400)', 'Db2 for i tables'], ['Vendor system', 'Fixed‑width exports']];
    const ys = [58, 128, 198];
    const cards = srcs.map(([n, s], i) => `<g transform="translate(0 ${ys[i]})"><rect class="u-card" x="0.75" y="-28" width="178.5" height="56" rx="4"/>
      <text class="u-name" x="14" y="-4">${esc(n)}</text><text class="u-sub" x="14" y="15">${esc(s)}</text></g>`).join('');
    const feeds = ys.map((y) => `<path class="u-feed" d="M180 ${y}C208 ${y} 208 ${LG.y} 236 ${LG.y}"/>`).join('');
    const node = (x, w, icon, name, sub) => `<g transform="translate(${x} ${LG.y})"><rect class="u-item u-node" x="0.5" y="-26" width="${w - 1}" height="52" rx="3"/>
      ${icon ? image(icon, 12, -11, 22) : ''}<text class="u-name" x="${icon ? 42 : 14}" y="-2">${esc(name)}</text><text class="u-meta" x="${icon ? 42 : 14}" y="15">${esc(sub)}</text></g>`;
    const seg = (x1, x2) => `<line class="u-flow-line" x1="${x1}" y1="${LG.y}" x2="${x2}" y2="${LG.y}"/><path class="u-head" d="M${x2 - 7} ${LG.y - 4.5}L${x2} ${LG.y}l-7 4.5"/>`;
    // Packets: EBCDIC bytes ("CO" of "COBOL") ride to the notebook, rows leave it for Delta; two packets, half a cycle
    // apart. The outer group places a packet, the inner one moves (a CSS transform would replace a transform attribute).
    const pk = (x, y, cls, d, dist, body) => `<g transform="translate(${x} ${y})"><g class="u-pk ${cls}" style="animation-delay:${d}s;--d:${dist}px">${body}</g></g>`;
    const hexBody = '<rect width="30" height="14" rx="2"/><text x="15" y="10" text-anchor="middle">C3 D6</text>';
    const rowBody = '<rect width="22" height="14" rx="2"/><path d="M4 4.5h14M4 7h14M4 9.5h14"/>';
    const packets = [0, -1.8].map((d) => pk(410, LG.y - 7, 'u-pk-a', d, 32, hexBody) + pk(580, LG.y - 7, 'u-pk-b', d, 38, hexBody) + pk(824, LG.y - 7, 'u-pk-c', d, 34, rowBody)).join('');
    host.innerHTML = `<svg class="u-svg u-legacy" viewBox="0 0 ${LG.w} ${LG.h}" aria-hidden="true">
      ${cards}${feeds}<path class="u-head" d="M229 ${LG.y - 4.5}L236 ${LG.y}l-7 4.5"/>
      ${node(236, 170, 'data-factory.svg', 'Data Factory', 'copy via the gateway')}
      <rect class="u-panel" x="440" y="70" width="${LG.w - 440.75}" height="116" rx="6"/>
      ${legend(452, 70, [['icon', 'onelake.svg', 16, 5], ['text', 'OneLake', 4.5, 0]], 'u-legend-panel u-legend-sm')}
      ${seg(406, 460)}${node(460, 116, 'lakehouse.svg', 'Raw files', 'in Files')}
      ${seg(576, 640)}${node(640, 180, 'notebook.svg', 'Spark notebook', 'parses the copybook')}
      ${seg(820, 876)}${node(876, 112, null, 'Delta tables', 'in Bronze')}
      ${packets}
    </svg>`;
  }

  /* ---- Playing Fig 1 ---- */
  const card = document.getElementById('uniCard');
  if (!card) return;
  const fig = document.getElementById('uniFig');
  const capEl = document.getElementById('uniCap');
  const chipsEl = document.getElementById('uniSteps');
  const playBtn = document.getElementById('uniPlay');
  const ledger = document.getElementById('uniLedger');
  drawFig1(fig);
  const svg = fig.querySelector('svg');
  fitLegends(svg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(document.getElementById('unification')));
  const rowEls = [...svg.querySelectorAll('.u-row')];

  /* ---- The Epic stack ---- */
  const stackRow = svg.querySelector('.u-row[data-stack]');
  const stackEl = stackRow.querySelector('.u-stack');
  const plateEls = Object.fromEntries([...stackEl.querySelectorAll('.u-plate')].map((el) => [el.dataset.plate, el]));
  const KIND = Object.fromEntries([...PLATES, EPIC].map((p) => [p.key, p.kind]));
  let order = PLATES.map((p) => p.key), top = null, stageNow = -1, onScreen = false, turnT = 0, settleT = 0;
  // Each plate's place: 0 is on top, 1 and 2 show their lower edges behind it, 3 waits hidden at the back. In the
  // Future step Epic is on top and the others fold away under it (x); otherwise Epic waits hidden (h).
  const slotOf = (k) => (top === 'epic' ? (k === 'epic' ? '0' : 'x') : k === 'epic' ? 'h' : String(order.indexOf(k)));
  const DEPTH = { h: 9, x: 8, 3: 3, 2: 2, 1: 1, 0: 0 };
  // After a flip: the plate that left goes to its new place, and the plates are put in drawing order, back to front
  function settle(leaving) {
    stackEl.classList.add('is-instant');
    if (leaving) {
      leaving.classList.remove('is-leaving');
      leaving.classList.add('is-enter');
      leaving.dataset.slot = slotOf(leaving.dataset.plate);
    }
    Object.values(plateEls).sort((a, b) => DEPTH[b.dataset.slot] - DEPTH[a.dataset.slot]).forEach((el) => stackEl.appendChild(el));
    void stackEl.getBoundingClientRect();
    stackEl.classList.remove('is-instant');
    if (leaving) leaving.classList.remove('is-enter');
  }
  // Puts a plate on top. Animated, the old top slides down and away while the others move up a place.
  function setTop(key, animate) {
    if (key === top) return;
    clearTimeout(settleT);
    const half = stackEl.querySelector('.is-leaving');
    if (half) settle(half);
    const prev = top;
    top = key;
    if (key !== 'epic') order = [...order.slice(order.indexOf(key)), ...order.slice(0, order.indexOf(key))];
    const leaving = animate && prev ? plateEls[prev] : null;
    if (!leaving) stackEl.classList.add('is-instant');
    Object.entries(plateEls).forEach(([k, el]) => { if (el !== leaving) el.dataset.slot = slotOf(k); });
    stackRow.querySelectorAll('[data-for]').forEach((el) => el.classList.toggle('is-top', el.dataset.for === key));
    if (!leaving) { settle(null); return; }
    leaving.classList.add('is-leaving');
    settleT = setTimeout(() => settle(leaving), 620);
  }
  // The ledger counts the Epic tables by the way in of the plate on top
  function counts(n) {
    const k = n >= 1 ? KIND[top] : null;
    const v = { shortcut: (n >= 3 ? 2 : 0) + (k === 'shortcut' ? 1 : 0), mirror: (n >= 2 ? 1 : 0) + (k === 'mirror' ? 1 : 0), copied: 0 };
    return Object.fromEntries(Object.entries(v).map(([key, c]) => [key, `<b>${c}</b> ${c === 1 ? 'source' : 'sources'}`]));
  }
  // The stack turns while its row is in focus and the figure is on screen
  function turn(ms) {
    clearTimeout(turnT);
    if (reduceMotion || !onScreen || !TURNS.has(stageNow)) return;
    turnT = setTimeout(() => {
      setTop(order[1], true);
      Object.entries(counts(stageNow)).forEach(([key, html]) => setLedger(ledger, key, html, true));
      turn(EVERY_MS);
    }, ms);
  }
  new IntersectionObserver((entries) => entries.forEach((en) => {
    onScreen = en.isIntersecting;
    if (onScreen) turn(EVERY_MS); else clearTimeout(turnT);
  }), { threshold: 0.25 }).observe(card);

  stepper({
    card, chips: chipsEl, playBtn, cap: capEl, ledger, steps: STEPS, hold: HOLD, reducedStage: ALL,
    render(n, animate) {
      const from = stageNow;
      stageNow = n;
      svg.dataset.stage = String(n);
      svg.classList.toggle('is-final', n >= ALL);
      svg.classList.toggle('is-future', n === FUTURE);
      rowEls.forEach((el) => {
        const step = Number(el.dataset.step);
        const state = n === FUTURE && el.hasAttribute('data-stack') ? 'is-live'
          : n >= ALL || step < n ? 'is-done' : step === n ? 'is-live' : 'is-idle';
        el.classList.remove('is-idle', 'is-live', 'is-done');
        el.classList.add(state);
      });
      // Each step starts the stack from SQL Server; Future puts Epic on top
      clearTimeout(turnT);
      setTop(n === FUTURE ? 'epic' : 'sql', animate && from >= 0);
      turn(FIRST_MS);
    },
    ledgerAt: counts,
  });

  /* ---- Fig 2 loops while it is on screen ---- */
  const legacy = document.getElementById('legacyFig');
  if (legacy) {
    drawFig2(legacy);
    const lsvg = legacy.querySelector('svg');
    fitLegends(lsvg);
    new IntersectionObserver((entries) => entries.forEach((en) => lsvg.classList.toggle('is-on', en.isIntersecting && !reduceMotion)), { threshold: 0.3 }).observe(legacy);
  }
})();
