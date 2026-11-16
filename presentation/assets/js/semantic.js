/* 03 Semantic models. Fig 4 draws the demo's three semantic models as small model diagrams (tables and relationships,
   no columns), each with the group it is for. Fabric IQ encloses the models, as OneLake encloses the items they read
   below them. Above them, GitHub Copilot asks the Cohort Discovery model questions in plain language through the
   Fabric IQ MCP server, and the approval app (a Rayfin app) uses Cohort Requests. Every part carries data-col
   (r = Research Data, d = Cohort Discovery, q = Cohort Requests, iq = the natural-language path); each step marks the
   parts it is about is-live and dims the rest. CSS does the motion. */
(function () {
  'use strict';

  const card = document.getElementById('semCard');
  if (!card || !window.FigKit) return;
  const { ICON, esc, image, legend, fitLegends, stepper } = window.FigKit;

  // Geometry, in viewBox units. Columns in the order of the layers in Fig 3: Research Data over Silver (and Bronze),
  // Cohort Discovery over Gold, then Cohort Requests over its own database. The panels sit 16 inside the Fabric IQ box.
  const VB_W = 1000;
  const COLS = { r: [16, 424], d: [444, 724], q: [744, 984] };
  const FE_TOP = 4, FE_H = 66;                       // the apps on top
  const F_TOP = 104, P_TOP = 132, P_BOT = 500, F_BOT = 516; // Fabric IQ and the model panels in it
  const SY = P_TOP + 112;                            // top of the model diagrams
  const L_TOP = 556, L_BOT = 636, IT_Y = 576, IT_H = 40; // OneLake and the items in it
  const VB_H = L_BOT + 6;
  const CH = 22;                                     // table height
  // The natural-language lanes: from GitHub Copilot right along the top, then down into Cohort Discovery
  const Q_OUT = 692, Q_BACK = 676, Q_Y1 = 26, Q_Y2 = 50, Q_X0 = 274;

  const MODELS = {
    r: { name: 'Research Data (OMOP)', audience: 'The honest broker', measure: 'Persons',
      purpose: ['Patient-level records for approved data requests, with', 'each patient’s CT series and clinical documents'] },
    d: { name: 'Cohort Discovery (i2b2)', audience: 'Researchers and study teams', measure: 'Patients (obfuscated)',
      purpose: ['Patient counts for a study’s criteria,', 'obfuscated the way i2b2 does'] },
    q: { name: 'Cohort Requests', audience: 'Reviewers of data requests', measure: 'Decision',
      purpose: ['Each request’s question, query and', 'counts, and the reviewer’s decision'] },
  };
  // The items each model reads; x is the left edge of the item, w its width
  const ITEMS = [
    { col: 'r', name: 'Silver_OMOP', icon: 'lakehouse.svg', layer: 'silver', x: 16, w: 112 },
    { col: 'r', name: 'Bronze_PACS', icon: 'databases.svg', layer: 'bronze', x: 142, w: 112 },
    { col: 'r', name: 'Bronze_ClinicalDocuments', icon: 'lakehouse.svg', layer: 'bronze', x: 268, w: 186 },
    { col: 'd', name: 'Gold_i2b2', icon: 'lakehouse.svg', layer: 'gold', x: 534, w: 100 },
    { col: 'q', name: 'Cohort_Requests', icon: 'databases.svg', layer: 'store', x: 796, w: 136 },
  ];
  const MODE = { r: 'Direct Lake', d: 'Direct Lake', q: 'DirectQuery' };

  const STEPS = [
    { chip: 'Overview', label: 'Fabric IQ',
      text: 'Fabric IQ holds the semantic models that reports, apps and AI agents query. Two of the demo’s models read Delta tables in OneLake directly, in Direct Lake mode, and the request model queries its SQL database in DirectQuery mode. The next steps bring each model forward in turn.' },
    { chip: 'Research Data', label: 'Step 1 of 3',
      text: 'The honest broker is the team that releases data to researchers once a request is approved. Its model, Research Data (OMOP), covers three Fabric items, Silver_OMOP, the PACS database and the document index, and relates each person’s conditions and measurements to their CT series and reports. The diagram shows 11 of its 24 tables.' },
    { chip: 'Cohort Discovery', label: 'Step 2 of 3',
      text: 'Researchers use this model to check how many patients a study could recruit. It reads Gold_i2b2 with Direct Lake, its patient keys are random numbers, and it leaves out names, dates of birth and ZIP codes. GitHub Copilot reaches it through the Fabric IQ MCP server, reads its schema, writes a DAX query for the study question and gets back an obfuscated count of about 358 patients.' },
    { chip: 'Cohort Requests', label: 'Step 3 of 3',
      text: 'Each request a researcher submits gets a page in the approval app, a Rayfin app on Fabric, where a reviewer approves or rejects it. The Cohort Requests model reads the Cohort_Requests database in DirectQuery mode and shows each decision as soon as it is recorded. A request goes from PENDING to APPROVED or REJECTED, then to DELIVERED.' },
  ];
  const LIVE = [['intro'], ['r'], ['d', 'iq'], ['q']];
  const HOLD = [3600, 7500, 12500];
  // Tables, relationships and items of the model each step is about (the overview counts all three)
  const LEDGER = [[34, 30, 5], [24, 26, 3], [7, 2, 1], [3, 2, 1]];

  /* ---- Model diagrams (x from the panel's left edge, y from the top of the diagram) ---- */
  const tw = (name) => name.length * 6 + 18;
  let ti = 0; // stagger index for the tables and lines of one diagram
  const table = (x, y, name, layer, fact = false) => `<g class="s-t s-t-${layer}${fact ? ' s-fact' : ''}" style="--i:${ti++}" transform="translate(${x} ${y})">
      <rect x="0.5" y="0.5" width="${tw(name) - 1}" height="${CH - 1}" rx="3"/><text x="${tw(name) / 2}" y="14.6" text-anchor="middle">${esc(name)}</text></g>`;
  const at = (x, y, name, layer, fact) => table(x - tw(name) / 2, y, name, layer, fact); // centred on x
  // A relationship from its "one" end a to its "many" end b, with the cardinality beside each end
  const rel = (a, b) => {
    const [x1, y1] = a, [x2, y2] = b, len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len, nx = -uy, ny = ux;
    const mark = (p, d, t) => `<text class="s-card" x="${(p[0] + ux * d + nx * 6).toFixed(1)}" y="${(p[1] + uy * d + ny * 6 + 3).toFixed(1)}" text-anchor="middle">${t}</text>`;
    return `<g class="s-rel" style="--i:${ti++}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" pathLength="1"/>${mark(a, 8, '1')}${mark(b, -8, '*')}</g>`;
  };

  // Research Data (OMOP), 408 wide: person in the middle, seven of its tables around it, and three tables they link on
  // to, two of them from Bronze items (the PACS series and the document index)
  function researchDiagram() {
    ti = 0;
    return `${at(100, 0, 'visit_occurrence', 'silver')}${at(316, 0, 'condition_occurrence', 'silver')}
      ${at(64, 50, 'drug_exposure', 'silver')}${at(204, 50, 'person', 'silver')}${at(350, 50, 'measurement', 'silver')}
      ${at(86, 100, 'observation', 'silver')}${at(204, 100, 'note', 'silver')}${at(330, 100, 'image_occurrence', 'silver')}
      ${at(86, 150, 'concept', 'silver')}${at(204, 150, 'Clinical document', 'bronze')}${at(330, 150, 'PACS Series', 'bronze')}
      ${rel([192, 50], [100, 22])}${rel([216, 50], [316, 22])}${rel([177, 61], [112, 61])}${rel([231, 61], [308, 61])}
      ${rel([192, 72], [86, 100])}${rel([204, 72], [204, 100])}${rel([216, 72], [330, 100])}
      ${rel([86, 150], [86, 122])}${rel([204, 150], [204, 122])}${rel([330, 150], [330, 122])}
      <text class="u-meta" x="16" y="196">Showing 11 of the 24 tables</text>`;
  }

  // Cohort Discovery (i2b2), 280 wide: the star, and the ontology tables, which queries match to the facts by code
  function discoveryDiagram() {
    ti = 0;
    return `${table(16, 0, 'patient_dimension', 'gold')}${table(264 - tw('visit_dimension'), 0, 'visit_dimension', 'gold')}
      ${at(140, 58, 'observation_fact', 'gold', true)}
      ${rel([76, 22], [113, 58])}${rel([210, 22], [167, 58])}
      <path class="s-match" d="M140 80V106"/>
      <rect class="s-group" x="16" y="106" width="248" height="86" rx="4"/>
      <text class="u-meta" x="26" y="123">Ontology, matched by concept code</text>
      ${table(26, 132, 'i2b2_ontology', 'gold')}${table(132, 132, 'concept_dimension', 'gold')}
      ${table(26, 162, 'modifier_dimension', 'gold')}${table(162, 162, 'table_access', 'gold')}`;
  }

  // Cohort Requests, 240 wide: the request with its breakdowns and events, and the statuses a request goes through
  function requestsDiagram() {
    ti = 0;
    const chip = (x, y, t, k) => `<g class="s-st"${k === undefined ? '' : ` style="--k:${k}"`} transform="translate(${x} ${y})"><rect width="${t.length * 5.7 + 10}" height="16" rx="2"/><text x="${(t.length * 5.7 + 10) / 2}" y="11.2" text-anchor="middle">${t}</text></g>`;
    const arrow = (x1, x2, y) => `<path class="s-arrow" d="M${x1} ${y}H${x2}M${x2 - 5} ${y - 3.5}L${x2} ${y}l-5 3.5"/>`;
    return `${at(120, 0, 'Request', 'store')}${at(60, 58, 'Breakdown', 'store')}${at(184, 58, 'Event', 'store')}
      ${rel([105, 22], [60, 58])}${rel([135, 22], [184, 58])}
      <text class="u-meta" x="16" y="114">Request status</text>
      ${chip(16, 124, 'PENDING', 0)}${arrow(69, 83, 132)}${chip(86, 124, 'APPROVED', 1)}${arrow(145, 159, 132)}${chip(162, 124, 'DELIVERED', 2)}
      <path class="s-arrow" d="M40 140V162H83M78 158.5L83 162l-5 3.5"/>${chip(86, 154, 'REJECTED')}`;
  }

  function panel(key, diagram) {
    const [x0, x1] = COLS[key], m = MODELS[key];
    const mw = m.measure.length * 6 + 16;
    return `<g class="s-panel" data-col="${key}">
      <rect class="s-box" x="${x0 + 0.75}" y="${P_TOP}" width="${x1 - x0 - 1.5}" height="${P_BOT - P_TOP}" rx="5"/>
      ${legend(x0 + 12, P_TOP, [['icon', 'power-bi.svg', 16, 6], ['text', m.name, 5, 0]], 'u-legend-panel s-panel-lg')}
      <text class="u-meta" x="${x0 + 16}" y="${P_TOP + 30}">Used by</text>
      <text class="u-name" x="${x0 + 16}" y="${P_TOP + 48}">${esc(m.audience)}</text>
      ${m.purpose.map((l, i) => `<text class="u-sub" x="${x0 + 16}" y="${P_TOP + 66 + i * 16}">${esc(l)}</text>`).join('')}
      <line class="s-rule" x1="${x0 + 16}" y1="${P_TOP + 98}" x2="${x1 - 16}" y2="${P_TOP + 98}"/>
      <g transform="translate(${x0} ${SY})">${diagram}</g>
      <line class="s-rule" x1="${x0 + 16}" y1="${P_BOT - 44}" x2="${x1 - 16}" y2="${P_BOT - 44}"/>
      <text class="u-meta" x="${x0 + 16}" y="${P_BOT - 18}">Measure</text>
      <g class="s-measure" transform="translate(${x0 + 66} ${P_BOT - 31})"><rect width="${mw}" height="18" rx="2"/><text x="${mw / 2}" y="12.5" text-anchor="middle">${esc(m.measure)}</text></g>
    </g>`;
  }

  /* ---- The apps on top, their lanes into the models, and OneLake ---- */
  // A moving mark. --dx/--dy: where it ends; --cx: the corner of an elbow lane
  const mark = (x, y, cls, body, dx = 0, dy = 0, cx = 0) => `<g transform="translate(${x} ${y})"><g class="s-pk ${cls}" style="--dx:${dx}px;--dy:${dy}px;--cx:${cx}px">${body}</g></g>`;
  const chipBody = (t) => `<rect class="s-pk-chip" width="${t.length * 5.4 + 8}" height="12" rx="2"/><text class="s-pk-text" x="${(t.length * 5.4 + 8) / 2}" y="8.6" text-anchor="middle">${t}</text>`;
  const colBody = '<rect class="s-pk-col" width="7" height="11" rx="1"/><path class="s-pk-lines" d="M1.8 3.7h3.4M1.8 7.3h3.4"/>';
  const rowBody = '<rect class="s-pk-row" width="12" height="9" rx="1.5"/><path class="s-pk-lines" d="M2.5 3h7M2.5 6h7"/>';
  const dotBody = '<rect class="s-pk-dot" width="7" height="7" rx="1"/>';
  const vArrow = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/><path d="M${x - 3.5} ${y2 + (y2 > y1 ? -5 : 5)}L${x} ${y2}l3.5 ${y2 > y1 ? -5 : 5}"/>`;

  function apps() {
    const fe = (x0, x1, col, icon, name, lines) => `<g class="s-fe" data-col="${col}">
      <rect class="s-fe-card" x="${x0 + 0.75}" y="${FE_TOP}" width="${x1 - x0 - 1.5}" height="${FE_H}" rx="4"/>${icon}
      <text class="u-name" x="${x0 + 46}" y="${FE_TOP + 22}">${esc(name)}</text>
      ${lines.map(([cls, t], i) => `<text class="${cls}" x="${x0 + 46}" y="${FE_TOP + 40 + i * 16}">${esc(t)}</text>`).join('')}</g>`;
    const qx1 = COLS.q[1], down = P_TOP - 4;
    // The question goes out along the top and down into the model; the count comes back up and along the lower lane
    const r = 6;
    const outPath = `M${Q_X0} ${Q_Y1}H${Q_OUT - r}Q${Q_OUT} ${Q_Y1} ${Q_OUT} ${Q_Y1 + r}V${down}`;
    const backPath = `M${Q_BACK} ${down}V${Q_Y2 + r}Q${Q_BACK} ${Q_Y2} ${Q_BACK - r} ${Q_Y2}H${Q_X0}`;
    const dax = 'DAX'.length * 5.4 + 8, cnt = '358'.length * 5.4 + 8;
    return `
      ${fe(0, 270, 'iq', `<image class="s-mono" href="${ICON}github-copilot.svg" x="14" y="${FE_TOP + 12}" width="22" height="22"/>`, 'GitHub Copilot',
        [['u-sub', '“How many former smokers aged 50+'], ['u-sub', 'have a CT nodule of 6 mm or more?”']])}
      ${fe(760, 1000, 'q', image('rayfin.svg', 774, FE_TOP + 12, 22), 'Approval app',
        [['u-sub', 'A Rayfin app on Fabric'], ['u-meta', 'Approve or reject each request']])}
      <g class="s-lane s-iq" data-col="iq">
        <path class="s-iq-line s-iq-out" d="${outPath}" pathLength="1"/><path class="s-iq-head s-iq-out-head" d="M${Q_OUT - 3.5} ${down - 5}L${Q_OUT} ${down}l3.5 -5"/>
        <path class="s-iq-line s-iq-back" d="${backPath}" pathLength="1"/><path class="s-iq-head s-iq-back-head" d="M${Q_X0 + 6} ${Q_Y2 - 4}L${Q_X0} ${Q_Y2}l6 4"/>
        <text class="u-meta s-lane-label" x="${(Q_X0 + Q_OUT) / 2}" y="${Q_Y1 - 8}" text-anchor="middle">through the Fabric IQ MCP server</text>
        ${mark(Q_X0 + 4, Q_Y1 - 6, 's-e1', chipBody('DAX'), 0, down - 16 - (Q_Y1 - 6), Q_OUT - dax / 2 - (Q_X0 + 4))}
        ${mark(Q_BACK - cnt / 2, down - 16, 's-e3', chipBody('358'), Q_X0 + 4 - (Q_BACK - cnt / 2), Q_Y2 - 6 - (down - 16))}
        <text class="s-answer" x="${(Q_X0 + Q_BACK) / 2}" y="${Q_Y2 + 18}" text-anchor="middle">about 358 patients (±3)</text>
      </g>
      <g class="s-lane s-dq" data-col="q">
        ${vArrow(qx1 - 48, FE_TOP + FE_H + 4, down)}${vArrow(qx1 - 32, down, FE_TOP + FE_H + 4)}
        ${mark(qx1 - 51.5, FE_TOP + FE_H + 6, 's-dn', dotBody, 0, down - FE_TOP - FE_H - 16)}
        ${mark(qx1 - 38, down - 14, 's-up s-back', rowBody, 0, -(down - FE_TOP - FE_H - 16))}
      </g>`;
  }

  function onelake() {
    const run = IT_Y - P_BOT - 20;
    const connectors = ITEMS.map((it) => {
      const cx = it.x + it.w / 2;
      const lane = MODE[it.col] === 'DirectQuery'
        ? `${vArrow(cx - 6, P_BOT + 4, IT_Y - 4)}${vArrow(cx + 6, IT_Y - 4, P_BOT + 4)}
           ${mark(cx - 9.5, P_BOT + 6, 's-dn', dotBody, 0, run)}${mark(cx, IT_Y - 18, 's-up s-back', rowBody, 0, -run)}`
        : `${vArrow(cx, IT_Y - 4, P_BOT + 4)}
           ${mark(cx - 3.5, IT_Y - 16, 's-up s-pk-a', colBody, 0, -run)}${mark(cx - 3.5, IT_Y - 16, 's-up s-pk-b', colBody, 0, -run)}`;
      return `<g class="s-lane s-dl" data-col="${it.col}">${lane}</g>`;
    }).join('');
    const modeLabels = ['r', 'd', 'q'].map((k) => {
      const it = ITEMS.find((i) => i.col === k), x = it.x + it.w / 2 + (MODE[k] === 'DirectQuery' ? 14 : 8);
      return `<text class="u-meta s-mode" data-col="${k}" x="${x}" y="${(F_BOT + L_TOP) / 2 + 4}">${MODE[k]}</text>`;
    }).join('');
    const items = ITEMS.map((it) => `<g class="s-item s-t-${it.layer}" data-col="${it.col}" transform="translate(${it.x} ${IT_Y})">
        <rect x="0.5" y="0.5" width="${it.w - 1}" height="${IT_H - 1}" rx="3"/>${image(it.icon, 10, 11, 18)}
        <text class="s-iname" x="34" y="24.5">${esc(it.name)}</text></g>`).join('');
    return `<rect class="s-frame" x="0.75" y="${L_TOP}" width="${VB_W - 1.5}" height="${L_BOT - L_TOP}" rx="6"/>
      ${legend(12, L_TOP, [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel')}
      ${connectors}${modeLabels}${items}`;
  }

  // In the overview, a card in the middle of the Fabric IQ box says what Fabric IQ is; the models fade behind it
  function intro() {
    const w = 660, h = 268, x = (VB_W - w) / 2, y = (F_TOP + F_BOT) / 2 - h / 2 + 4, cw = (w - 56 - 40) / 3;
    const facts = [
      ['Semantic models', ['Tables, relationships and', 'measures that reports and', 'agents share']],
      ['Ontology', ['Business entities, how they', 'relate and the rules on them,', 'mapped to data in OneLake']],
      ['MCP server', ['Lets agents such as GitHub', 'Copilot read a model and run', 'DAX as the signed-in user']],
    ];
    // The outer group places the card; the inner one moves (a CSS transform would replace the transform attribute)
    return `<g transform="translate(${x} ${y})"><g class="s-intro" data-col="intro">
      <rect class="s-intro-card" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="5"/>
      <image href="${ICON}iq.png" x="28" y="26" width="30.8" height="36"/>
      <text class="s-intro-title" x="72" y="52">Fabric IQ</text>
      <text class="s-intro-text" x="28" y="92">The Fabric workload that describes the business for people and AI agents. It</text>
      <text class="s-intro-text" x="28" y="112">holds semantic models and ontologies, built on the data in OneLake.</text>
      <line class="s-rule" x1="28" y1="134" x2="${w - 28}" y2="134"/>
      ${facts.map(([t, lines], i) => `<g transform="translate(${28 + i * (cw + 20)} 160)"><text class="u-name">${t}</text>
        ${lines.map((l, j) => `<text class="u-sub" y="${20 + j * 16}">${esc(l)}</text>`).join('')}</g>`).join('')}
      <line class="s-rule" x1="28" y1="${h - 44}" x2="${w - 28}" y2="${h - 44}"/>
      <text class="s-intro-foot" x="28" y="${h - 20}">This demo has three semantic models in Fabric IQ, each for one group of people.</text>
    </g></g>`;
  }

  // Fabric IQ, the box the models sit in
  const fabricIQ = () => `<rect class="s-frame s-frame-iq" x="0.75" y="${F_TOP}" width="${VB_W - 1.5}" height="${F_BOT - F_TOP}" rx="6"/>
      ${legend(12, F_TOP, [['icon', 'iq.png', 18, 6], ['text', 'Fabric IQ', 5, 0]], 'u-legend-panel')}`;

  function draw(host) {
    host.innerHTML = `<svg class="u-svg s-svg" viewBox="0 0 ${VB_W} ${VB_H}" aria-hidden="true">
      ${fabricIQ()}
      ${onelake()}
      ${panel('r', researchDiagram())}${panel('d', discoveryDiagram())}${panel('q', requestsDiagram())}
      ${apps()}
      ${intro()}
    </svg>`;
  }

  /* ---- Playing it ---- */
  const fig = document.getElementById('semFig');
  draw(fig);
  const svg = fig.querySelector('svg');
  fitLegends(svg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(svg));
  const parts = [...svg.querySelectorAll('[data-col]')];
  const plural = (n, one, many) => `<b>${n}</b> ${n === 1 ? one : many}`;

  stepper({
    card, chips: document.getElementById('semSteps'), playBtn: document.getElementById('semPlay'),
    cap: document.getElementById('semCap'), ledger: document.getElementById('semLedger'),
    steps: STEPS, hold: HOLD, reducedStage: 0,
    render(n) {
      svg.dataset.stage = String(n);
      const live = LIVE[n];
      parts.forEach((el) => {
        const on = live.includes(el.dataset.col);
        el.classList.toggle('is-live', on);
        el.classList.toggle('is-dim', live.length > 0 && !on);
      });
    },
    ledgerAt: (n) => {
      const [t, r, s] = LEDGER[n];
      return { tables: plural(t, 'table', 'tables'), rels: plural(r, 'relationship', 'relationships'), items: plural(s, 'Fabric item', 'Fabric items') };
    },
  });
})();
