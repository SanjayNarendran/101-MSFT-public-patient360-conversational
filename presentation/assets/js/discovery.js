/* 04 Cohort discovery. Fig 5 plays the researcher's and the reviewer's experience as scenes in a replica of the two
   apps (apps/discovery, the local Cohort Discovery app, and apps/approval, the Rayfin approval app): the question is
   typed, Copilot finds the ontology terms and fills the i2b2 panels, the query runs and returns obfuscated counts, the
   researcher submits a request, and a reviewer opens and approves it. The i2b2 track under the screen lights up in
   step with what each scene writes. The text and numbers are those of query 1005 in the demo's CRC store; the request
   times are illustrative.

   The scenes run on the replica runner in figkit.js. Section 05 (delivery.js) picks up where the last scene ends: the
   request approved and its delivery started. */
(function () {
  'use strict';

  const card = document.getElementById('cdCard');
  if (!card || !window.FigKit) return;
  const { esc, setLedger, ui, replica } = window.FigKit;

  const W = 1280, H = 780; // the replica's design size; it is scaled to the card
  const Q = 'How many adults aged 50 or older are former smokers with a lung nodule of at least 6 mm?';
  const TITLE = 'Former smokers 50+, lung nodule 6 mm or more';
  const COMMENT = 'Approved for the lung screening feasibility study.';
  const ME = 'researcher@contoso.com';
  const QM = 1005, QNAME = '50-64-Forme-Nodul@01:20:52';
  const APP_HOST = 'contoso-approvals-centralus.webapp.fabricapps.net';
  const REQUESTED = '5 Nov 2026, 07:33 UTC', DECIDED = '5 Nov 2026, 07:36 UTC', DECIDED_ISO = '2026-11-05 07:36';
  const DEMO_LIMITS = '25 patients, 20 documents and 5 imaging studies';
  const PANELS = [
    { folder: 'Demographics', items: [['50-64 years old'], ['65-79 years old'], ['80 years old and over']] },
    { folder: 'Vital Signs and Assessments', items: [['Former smoker']] },
    { folder: 'Imaging', items: [['Nodule size', '≥ 6 mm']] },
  ];
  const BREAKDOWNS = [
    ['Age', [['0-17 years old', 0], ['18-34 years old', 0], ['35-49 years old', 0], ['50-64 years old', 113], ['65-79 years old', 122], ['80 years old and over', 127]]],
    ['Gender', [['Female', 175], ['Male', 186]]],
    ['Race', [['Amer. Indian', 0], ['Asian', 16], ['Black', 31], ['Other', 0], ['Pac Islander', 0], ['White', 309]]],
    ['Vital status', [['Deceased', 46], ['Living', 311]]],
  ];
  const FOLDERS = [['Clinical Notes', 2896], ['Demographics', 3539], ['Diagnoses', 3536], ['Imaging', 2896], ['Labs', 3440],
    ['Medications', 3448], ['Procedures', 3523], ['Specimens', 709], ['Visit Details', 3539], ['Vital Signs and Assessments', 3503]];
  const STARTERS = [
    ['Multi-panel questions', [
      ['How many patients with type 2 diabetes and chronic kidney disease have had an HbA1c of 6.5% or higher at least twice, but have never been prescribed metformin?', 'Two diagnoses, a repeated lab value and NOT'],
      ['How many patients aged 65 or older with heart failure and hypertension have had an eGFR below 60 at least twice and two or more inpatient stays?', 'Five panels, two of them repeated']]],
    ['One feature each', [
      ['How many patients with type 2 diabetes have never been prescribed metformin?', 'A diagnosis folder AND NOT a medication'],
      ['How many patients have a lung nodule of at least 8 mm in the right upper lobe?', 'A measurement with a location modifier']]],
  ];
  // The two requests already in the approval app (from the demo's request store)
  const INBOX = [
    { id: 1006, title: 'Type 2 diabetes, never prescribed metformin', q: 'How many patients with type 2 diabetes have never been prescribed metformin?', n: '167 ±3', at: '5 Nov 2026, 07:28 UTC', status: 'APPROVED' },
    { id: 1002, title: 'Lung screening: nodules 8 mm or larger, no emphysema', q: 'Adults aged 50 to 79 who had a low-dose CT of the chest and have a lung nodule of at least 8 mm, excluding anyone with emphysema', n: '191 ±3', at: '5 Nov 2026, 06:44 UTC', status: 'PENDING' },
  ];

  const STEPS = [
    { chip: 'Ask', label: 'Step 1 of 6',
      text: 'A researcher opens the Cohort Discovery app, which runs on their own machine, and types the study question in plain language. The app passes it to GitHub Copilot through the Copilot SDK, together with the cohort tools that read the i2b2 ontology and run queries.' },
    { chip: 'Build', label: 'Step 2 of 6',
      text: 'Copilot searches the i2b2 ontology for each criterion and finds five terms, three age bands, Former smoker and Nodule size. It puts them in three panels. Terms in one panel are joined with OR and panels with AND, and Nodule size carries a value of 6 mm or more.' },
    { chip: 'Run', label: 'Step 3 of 6',
      text: 'Copilot runs the query. The panels are compiled to DAX and run on the Cohort Discovery semantic model as the researcher, and the run is stored in i2b2’s query tables as QUERY_MASTER_ID 1005. The true count is 358. The app shows 356 ±3, with noise added as i2b2 does for an obfuscated user, and the breakdowns are obfuscated too.' },
    { chip: 'Submit', label: 'Step 4 of 6',
      text: 'The researcher gives the request a title and submits it. The request is stored as PENDING in the Cohort_Requests database, and the app links to the request’s page in the approval app.' },
    { chip: 'Review', label: 'Step 5 of 6',
      text: 'A reviewer opens the approval app, a Rayfin app on Fabric, and sees the new request in the inbox with its count and status. The request page shows the question, the i2b2 panels, the counts by category and the query XML.' },
    { chip: 'Approve', label: 'Step 6 of 6',
      text: 'The reviewer adds a comment and clicks Approve and deliver, with demo mode on. The decision is stored with the reviewer’s account and the time in UTC, and the delivery pipeline starts straight away. Section 05 follows the delivery.' },
  ];
  const HOLD = [5600, 9400, 10000, 7400, 7200];

  /* ---- The replica ---- */
  const bars = (rows) => {
    const max = Math.max(1, ...rows.map(([, n]) => n));
    return `<div class="cd-bars">${rows.map(([c, n]) => `<span class="cd-bar-label">${esc(c)}</span>
      <span class="cd-bar-track"><span class="cd-bar-fill" data-w="${(n / max) * 100}"></span></span>
      <span class="cd-bar-value${n ? '' : ' zero'}">${n}</span>`).join('')}</div>`;
  };
  const barGroups = (groups) => `<div class="cd-bars-grid">${groups.map(([t, rows]) => `<div><h3 class="cd-h3">${t}</h3>${bars(rows)}</div>`).join('')}</div>`;
  const { seg, field, status } = ui;
  const chip = ([name, cons], extra = '') => `<div class="cd-chip${extra}"><span class="cd-chip-name">${esc(name)}</span>${cons ? `<span class="cd-chip-cons">${esc(cons)}</span>` : ''}<span class="cd-chip-x">×</span></div>`;
  // The approval app draws the query as panels in a row
  const rowPanels = () => `<div class="cd-rpanels">${PANELS.map((p, i) => `${i ? '<span class="cd-joiner">AND</span>' : ''}<div class="cd-rpanel">
      <div class="cd-panel-head">Panel ${i + 1}</div>${p.items.map((it, j) => `${j ? '<div class="cd-or">or</div>' : ''}${chip(it, ' cd-chip-ro')}`).join('')}</div>`).join('')}</div>`;

  function discoveryApp() {
    return `<div class="cd-win cd-win-disc">
      <div class="cd-url"><span class="cd-url-text">127.0.0.1:8766</span><span class="cd-url-note">Cohort Discovery app, on the researcher’s machine</span></div>
      <header class="cd-top"><span class="cd-mark"></span><span class="cd-brand">Cohort Discovery</span><span class="cd-brand-sub">Contoso Health · i2b2 on Microsoft Fabric</span>
        <span class="cd-top-gap"></span>${seg(['i2b2 query', 'DAX explore'], 0)}<span class="cd-select">Claude Sonnet 5.5</span><span class="cd-select">Thinking: medium</span>
        <span class="cd-who">GitHub: SanjayNarendran</span>${ui.themeSeg}</header>
      <div class="cd-disc">
        <aside class="cd-rail">
          <div class="cd-rail-head">${seg(['Ontology', 'History'], 0)}</div>
          <div class="cd-search">${field('cd-search-field one', 'Search terms, e.g. nodule, E11, metformin')}</div>
          <div class="cd-tree">${FOLDERS.map(([f, n]) => `<div class="cd-node" data-folder="${esc(f)}"><span class="cd-tw">›</span><span class="cd-node-name">${esc(f)}</span><span class="cd-node-n">${n}</span></div>`).join('')}</div>
        </aside>
        <section class="cd-chat">
          <div class="cd-msgs"><div class="cd-msgs-in">
            <div class="cd-welcome">
              <p class="cd-eyebrow">Cohort feasibility with i2b2</p>
              <h1 class="cd-headline">Ask how many patients match your criteria.</h1>
              <p class="cd-lede">Copilot finds the terms in the i2b2 ontology, builds the query on the right and runs it on the Cohort Discovery semantic model in Microsoft Fabric. Every run gets a QUERY_MASTER_ID. You can also build or change the query by hand.</p>
              ${STARTERS.map(([h, list]) => `<h3 class="cd-h3 cd-starter-h">${h}</h3><div class="cd-starters">${list.map(([q, s]) => `<div class="cd-starter">${esc(q)}<small>${esc(s)}</small></div>`).join('')}</div>`).join('')}
            </div>
            <div class="cd-msg cd-msg-user"><div class="cd-msg-who">You</div><div class="cd-msg-body">${esc(Q)}</div></div>
            <div class="cd-msg cd-msg-ai"><div class="cd-msg-who">Copilot</div>
              <div class="cd-tools"></div><div class="cd-msg-body cd-ai-text"></div><div class="cd-activity"><span></span></div></div>
          </div></div>
          <div class="cd-composer">${field('cd-input', 'Ask a cohort question')}<span class="cd-btn cd-btn-primary cd-ask">Ask</span></div>
          <div class="cd-meta"><span>i2b2 mode: every run is recorded with a QUERY_MASTER_ID; counts are obfuscated.</span><span class="cd-link">New conversation</span></div>
        </section>
        <aside class="cd-side"><div class="cd-side-in">
          <div class="cd-row cd-sp"><div class="cd-col-title">The i2b2 query</div><div class="cd-row cd-links"><span>☐ Same visit</span><span class="cd-link">Add panel</span><span class="cd-link">Clear</span></div></div>
          <div class="cd-panels">
            <div class="cd-panel cd-target" data-p="0"><div class="cd-panel-head">Panel 1 · new terms go here</div><div class="cd-panel-empty">Add terms with + in the ontology, or ask Copilot.</div><div class="cd-panel-items"></div></div>
            <div class="cd-joiner cd-j1">AND</div>
            <div class="cd-panel" data-p="1"><div class="cd-panel-head">Panel 2</div><div class="cd-panel-items"></div></div>
            <div class="cd-joiner cd-j2">AND</div>
            <div class="cd-panel" data-p="2"><div class="cd-panel-head">Panel 3</div><div class="cd-panel-items"></div></div>
          </div>
          <div class="cd-row cd-runrow">${field('cd-qnote one', 'Question for the record (optional)')}<span class="cd-btn cd-btn-primary cd-run is-disabled">Run query</span></div>
          <div class="cd-result">
            <p class="cd-empty-side">Run the query, or ask Copilot, to see the obfuscated count and breakdowns.</p>
            <div class="cd-result-body">
              <div class="cd-col-title">Result</div>
              <p class="cd-eyebrow cd-qm">QUERY_MASTER_ID <span class="cd-mono">${QM}</span> · <span class="cd-mono">${QNAME}</span></p>
              <div class="cd-count"><span class="cd-count-n">0</span><small>±3 patients, obfuscated</small></div>
              <p class="cd-note">“${esc(Q)}”</p>
              <div class="cd-res-bars">${barGroups(BREAKDOWNS)}<p class="cd-note">Each count is obfuscated on its own, so categories don’t add up exactly to the total.</p></div>
              <div class="cd-request">
                <div class="cd-req-form"><h3 class="cd-h3">Request the data</h3>
                  <p class="cd-note">Submitting creates a data request. It is approved or rejected in the approval app, and delivered after approval.</p>
                  <div class="cd-row">${field('cd-title one', 'Title for the request')}<span class="cd-btn cd-btn-ink cd-submit">Submit request</span></div></div>
                <div class="cd-req-done"><h3 class="cd-h3">Data request</h3>
                  <p class="cd-p">${status('PENDING')}</p><p class="cd-p"><b>${esc(TITLE)}</b></p>
                  <p class="cd-p"><span class="cd-btn">Open the approval page ↗</span></p></div>
              </div>
            </div>
          </div>
        </div></aside>
      </div>
    </div>`;
  }

  // The approval app's text above a delivery run
  const deliveryText = () => `<p class="cd-p">Delivery runs the <b>Cohort_Delivery_Pipeline</b>. It creates a lakehouse next to this app, named after the request (<span class="cd-mono">Delivery_QM${QM}_…</span>): the cohort’s OMOP tables are copied, its DICOM studies are linked with OneLake shortcuts, and its documents are copied.</p>`;

  function approvalApp() {
    const rows = [{ id: QM, title: TITLE, q: Q, n: '356 ±3', at: REQUESTED, status: 'PENDING', mine: true }, ...INBOX];
    return `<div class="cd-win cd-win-appr">
      <div class="cd-url"><span class="cd-url-text">${APP_HOST}<span class="cd-url-path">/#/</span></span><span class="cd-url-note">Approval app, a Rayfin app on Fabric</span></div>
      <header class="cd-top"><span class="cd-mark"></span><span class="cd-brand">Cohort data requests</span><span class="cd-brand-sub">Review and approval</span>
        <span class="cd-top-gap"></span><span class="cd-mono cd-who">MedicalCohortDemo</span><span class="cd-who">${ME}</span>${ui.themeSeg}</header>
      <div class="cd-pages">
        <section class="cd-page cd-inbox"><div class="cd-page-in">
          <p class="cd-eyebrow">Contoso Health · i2b2 cohort discovery</p>
          <h1 class="cd-headline">Cohort data requests</h1>
          <p class="cd-lede">Each request is an i2b2 query a researcher ran and submitted. Open one to review the question, the query and its counts, then approve or reject it. Approved requests are delivered separately, from the request page.</p>
          <div class="cd-filter">${seg(['All <i>3</i>', 'Pending <i>2</i>', 'Approved <i>1</i>', 'Delivered <i>0</i>', 'Rejected <i>0</i>'], 0)}</div>
          <table class="cd-table"><thead><tr><th class="num">Request</th><th>Title and question</th><th class="num">Patients</th><th>Requested by</th><th>Requested</th><th>Status</th></tr></thead>
            <tbody>${rows.map((r) => `<tr${r.mine ? ' class="cd-mine"' : ''}><td class="num cd-mono">${r.id}</td><td><span class="cd-a">${esc(r.title)}</span><div class="cd-sub">${esc(r.q)}</div></td>
              <td class="num">${r.n}</td><td>${ME}</td><td class="nowrap">${r.at}</td><td>${status(r.status)}</td></tr>`).join('')}</tbody></table>
          <p class="cd-note">Patient counts are obfuscated as for an i2b2 DATA_OBFSC user: Gaussian noise is added and 3 or fewer is shown as "Fewer than 4".</p>
        </div></section>
        <section class="cd-page cd-req"><div class="cd-page-in cd-req-in">
          <span class="cd-back">← All requests</span>
          <p class="cd-eyebrow">Request <span class="cd-mono">${QM}</span> · i2b2 query <span class="cd-mono">${QNAME}</span></p>
          <h1 class="cd-headline">${esc(TITLE)}</h1>
          <p class="cd-lede">“${esc(Q)}”</p>
          <div class="cd-facts">
            <div class="cd-fact"><div class="cd-fact-label">Patients (obfuscated)</div><div class="cd-fact-value">356 ±3</div></div>
            <div class="cd-fact"><div class="cd-fact-label">Status</div><div class="cd-fact-value cd-fact-status"><span class="cd-sw-a">${status('PENDING')}</span><span class="cd-sw-b">${status('APPROVED')}</span></div></div>
            <div class="cd-fact"><div class="cd-fact-label">Requested by</div><div class="cd-fact-value small">${ME}<br><span class="cd-muted">${REQUESTED}</span></div></div>
            <div class="cd-fact"><div class="cd-fact-label">Decision</div><div class="cd-fact-value small cd-fact-decision"><span class="cd-sw-a cd-muted">Not decided yet</span><span class="cd-sw-b">${ME}<br><span class="cd-muted">${DECIDED}</span></span></div></div>
          </div>
          <h2 class="cd-h2">The i2b2 query</h2>${rowPanels()}
          <div class="cd-row cd-xmlrow"><span class="cd-btn">Download i2b2 query XML</span><span class="cd-muted cd-small">i2b2 query definition -> DAX</span></div>
          <h2 class="cd-h2 cd-counts-h">Counts by category</h2>${barGroups(BREAKDOWNS)}
          <p class="cd-note">Each count is obfuscated on its own, so the categories don't add up exactly to the total.</p>
          <h2 class="cd-h2 cd-decision-h">Decision</h2>
          <div class="cd-decide">
            <div class="cd-fact-label">Comment (optional)</div>${field('cd-comment', 'Reason, conditions of use, or a note for the requester')}
            <div class="cd-checks">${ui.check('Deliver the data when I approve', 'starts the Cohort_Delivery_Pipeline')}
              ${ui.check('Demo mode', `${DEMO_LIMITS}, to keep a live demo short`, 'cd-check-sub')}</div>
            <div class="cd-row cd-buttons"><span class="cd-btn cd-btn-primary cd-approve">Approve and deliver</span><span class="cd-btn cd-btn-ink">Reject</span></div>
            <p class="cd-note">Your decision is recorded as <b>${ME}</b>, with the time in UTC.</p>
          </div>
          <div class="cd-decided"><p class="cd-p">${status('APPROVED')} by ${ME} on ${DECIDED}. <span class="cd-muted">“${esc(COMMENT)}”</span></p>
            <h2 class="cd-h2">Delivery</h2>
            ${deliveryText()}
            <div class="cd-run is-live"><div class="cd-run-head">${status('RUNNING', { RUNNING: 'Queued' })}<span class="cd-muted">Cohort_Delivery_Pipeline · demo mode · 0:03 · started by ${ME}, ${DECIDED}</span></div>
              <ol class="cd-steps"><li class="cd-step pending">Queued: the pipeline is starting</li></ol>
              <p class="cd-note"><span class="cd-link">Open the running pipeline in Fabric ↗</span> · this page updates as each step finishes</p></div>
            <p class="cd-notice">Request ${QM} approved by ${ME} at ${DECIDED_ISO} UTC. The delivery has started in demo mode.</p></div>
          <h2 class="cd-h2">Audit trail</h2>
          <ol class="cd-timeline"><li class="ev-SUBMITTED"><div class="cd-tl-title">Submitted</div><div class="cd-tl-meta">${ME} · ${REQUESTED}</div></li>
            <li class="ev-APPROVED cd-ev-new"><div class="cd-tl-title">Approved</div><div class="cd-tl-meta">${ME} · ${DECIDED}</div><div class="cd-tl-detail">${esc(COMMENT)}</div></li>
            <li class="ev-DELIVERY_REQUESTED cd-ev-new"><div class="cd-tl-title">Delivery started</div><div class="cd-tl-meta">${ME} · ${DECIDED}</div><div class="cd-tl-detail">Cohort_Delivery_Pipeline in demo mode</div></li></ol>
        </div></section>
      </div>
    </div>`;
  }

  const stageHTML = () => `${discoveryApp()}${approvalApp()}`;

  /* ---- The i2b2 track ---- */
  const TRACK = [
    ['Ontology', 'search_ontology finds five terms', '\\i2b2\\Imaging\\Lung nodule findings (LIDC)\\SNOMED_246120007\\'],
    ['Query definition', 'Three panels, AND between panels, OR inside one', '&lt;constrain_by_value&gt; GE 6 mm'],
    ['DAX', 'Compiled from the panels, run on the Cohort Discovery model', 'INTERSECT(age, smoker, nodule)'],
    ['Query store', 'The run is stored in the i2b2 QT_ tables', 'QT_QUERY_MASTER 1005'],
    ['Obfuscation', 'Noise added as for an i2b2 DATA_OBFSC user', '358 true, 356 ±3 shown'],
    ['Data request', 'COHORT_REQUEST, read by the approval app', '<span class="cd-sw-a">PENDING</span><span class="cd-sw-b">APPROVED</span>'],
  ];
  const track = document.getElementById('cdTrack');
  track.innerHTML = TRACK.map(([t, d, m], i) => `<li class="cd-st" data-st="${i}"><span class="cd-st-n">${String(i + 1).padStart(2, '0')}</span>
    <span class="cd-st-t">${t}</span><span class="cd-st-d">${d}</span><span class="cd-st-m">${m}</span></li>`).join('');
  const stations = [...track.querySelectorAll('.cd-st')];

  /* ---- The replica's stage, the track and the ledger ---- */
  let stage = null;
  const $ = (sel) => stage.querySelector(sel);
  const ledgerEl = document.getElementById('cdLedger');
  const LEDGER0 = { query: '<b>–</b> QUERY_MASTER_ID', patients: '<b>–</b> patients', request: '<b>–</b> request' };
  const ledger = (c, key, html) => { c.guard(); setLedger(ledgerEl, key, html, c.animate); };
  function station(c, i, state = 'live') {
    c.guard();
    stations.forEach((s, j) => {
      if (j < i && s.classList.contains('is-live')) { s.classList.remove('is-live'); s.classList.add('is-done'); }
    });
    stations[i].classList.remove('is-done');
    stations[i].classList.add(state === 'live' ? 'is-live' : 'is-done');
  }

  // A tool step in Copilot's reply: the activity line names it, then it is listed with a tick
  async function tool(c, name, ms) {
    const act = $('.cd-activity'), tools = $('.cd-tools');
    act.classList.add('is-on'); act.querySelector('span').textContent = name;
    const line = document.createElement('div');
    line.className = 'cd-tool'; line.textContent = name;
    tools.appendChild(line);
    await c.wait(ms);
    line.classList.add('done');
    act.classList.remove('is-on');
  }

  const SCENES = [
    // 1. Ask
    async (c) => {
      const input = $('.cd-input');
      await c.wait(500);
      await c.point(input, 800, 0.3);
      await c.click(input);
      await c.type(input, Q, 36);
      await c.wait(250);
      const ask = $('.cd-ask');
      await c.point(ask, 500);
      await c.click(ask);
      input.querySelector('.cd-typed').textContent = '';
      input.classList.remove('has-text');
      $('.cd-chat').classList.add('is-asked');
      await c.wait(500);
      const act = $('.cd-activity');
      act.classList.add('is-on'); act.querySelector('span').textContent = 'Thinking';
    },
    // 2. Build: three ontology searches fill the three panels, then the query is checked
    async (c) => {
      $('.cd-cursor').classList.remove('is-on');
      await c.wait(300);
      for (let p = 0; p < PANELS.length; p++) {
        const node = $(`.cd-node[data-folder="${PANELS[p].folder}"]`);
        node.classList.add('is-hit');
        if (p === 0) station(c, 0);
        await tool(c, 'Searching the ontology', 1000);
        const panel = $(`.cd-panel[data-p="${p}"]`), items = panel.querySelector('.cd-panel-items');
        panel.classList.add('is-on');
        if (p) $(`.cd-j${p}`).classList.add('is-on');
        for (let j = 0; j < PANELS[p].items.length; j++) {
          if (j) items.insertAdjacentHTML('beforeend', '<div class="cd-or">or</div>');
          items.insertAdjacentHTML('beforeend', chip(PANELS[p].items[j], ' cd-chip-new'));
          await c.wait(160);
        }
        node.classList.remove('is-hit');
        await c.wait(350);
      }
      station(c, 1);
      await tool(c, 'Checking the query', 900);
      const note = $('.cd-qnote');
      note.classList.add('has-text'); note.querySelector('.cd-typed').textContent = Q;
      $('.cd-run').classList.remove('is-disabled');
      await c.stream($('.cd-ai-text'), 'The query has three panels joined with AND: the age bands from 50 years up, Former smoker, and Nodule size of 6 mm or more. Running it now.');
    },
    // 3. Run: DAX on the model, the run stored in the QT_ tables, obfuscated counts and breakdowns
    async (c) => {
      $('.cd-cursor').classList.remove('is-on');
      await c.wait(200);
      station(c, 2);
      const act = $('.cd-activity'), tools = $('.cd-tools');
      act.classList.add('is-on'); act.querySelector('span').textContent = 'Running the i2b2 query';
      const line = document.createElement('div');
      line.className = 'cd-tool'; line.textContent = 'Running the i2b2 query';
      tools.appendChild(line);
      await c.wait(1100);
      station(c, 3);
      $('.cd-result').classList.add('is-on');
      ledger(c, 'query', `<b>${QM}</b> QUERY_MASTER_ID`);
      const side = $('.cd-side-in');
      await c.scroll(side, c.top(side, $('.cd-result-body')) - 18, 900);
      station(c, 4);
      await c.count($('.cd-count-n'), 356, 1100);
      ledger(c, 'patients', '<b>356</b> ±3 patients');
      $('.cd-res-bars').classList.add('is-on');
      stage.querySelectorAll('.cd-win-disc .cd-bar-fill').forEach((b) => { b.style.width = `${b.dataset.w}%`; });
      line.classList.add('done');
      act.classList.remove('is-on');
      await c.wait(500);
      const text = $('.cd-ai-text');
      await c.stream(text, `${text.textContent} QUERY_MASTER_ID ${QM} found about 356 patients (±3). The breakdowns by age, gender, race and vital status are beside the query, and you can submit it from there to request the data.`);
    },
    // 4. Submit
    async (c) => {
      const side = $('.cd-side-in'), form = $('.cd-req-form');
      await c.scroll(side, c.top(side, form) - 280, 800);
      const title = $('.cd-title');
      await c.point(title, 700, 0.3);
      await c.click(title);
      await c.type(title, TITLE, 30);
      const submit = $('.cd-submit');
      await c.point(submit, 450);
      await c.click(submit);
      submit.textContent = 'Submitting…';
      await c.wait(700);
      $('.cd-request').classList.add('is-done');
      station(c, 5);
      ledger(c, 'request', '<b>Pending</b> request');
      await c.wait(600);
      await c.point($('.cd-req-done .cd-btn'), 650);
    },
    // 5. Review: the approval app's inbox, then the request page
    async (c) => {
      $('.cd-cursor').classList.remove('is-on');
      stage.classList.add('is-appr');
      await c.wait(900);
      const row = $('.cd-mine');
      row.classList.add('is-new');
      await c.wait(700);
      await c.point(row.querySelector('.cd-a'), 800, 0.4);
      await c.click(row);
      $('.cd-url-path').textContent = `/#/requests/${QM}`;
      $('.cd-pages').classList.add('is-req');
      stage.querySelectorAll('.cd-req .cd-bar-fill').forEach((b) => { b.style.width = `${b.dataset.w}%`; });
      $('.cd-cursor').classList.remove('is-on');
      await c.wait(2200);
      const page = $('.cd-req-in');
      await c.scroll(page, c.top(page, $('.cd-counts-h')) - 24, 1400);
    },
    // 6. Approve
    async (c) => {
      const page = $('.cd-req-in');
      await c.scroll(page, c.top(page, $('.cd-decision-h')) - 300, 1000);
      const comment = $('.cd-comment');
      await c.point(comment, 700, 0.25);
      await c.click(comment);
      await c.type(comment, COMMENT, 32);
      const approve = $('.cd-approve');
      await c.point(approve, 450);
      await c.click(approve);
      approve.textContent = 'Approving and delivering…';
      await c.wait(900);
      $('.cd-req').classList.add('is-approved');
      stations[5].classList.add('is-b');
      station(c, 5);
      ledger(c, 'request', '<b>Approved</b> request');
      c.hide();
      await c.wait(400);
      // To the decision and the delivery run that has just started
      await c.scroll(page, c.top(page, $('.cd-decision-h')) - 24, 900);
    },
  ];

  replica({
    card, view: document.getElementById('cdView'), W, H, html: stageHTML, scenes: SCENES, steps: STEPS, hold: HOLD,
    chips: document.getElementById('cdSteps'), playBtn: document.getElementById('cdPlay'), cap: document.getElementById('cdCap'),
    onStage: (el) => { stage = el; },
    onReset: () => {
      stations.forEach((s) => s.classList.remove('is-live', 'is-done', 'is-b'));
      Object.entries(LEDGER0).forEach(([key, html]) => setLedger(ledgerEl, key, html, false));
    },
  });
})();
