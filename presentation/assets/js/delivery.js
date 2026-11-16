/* 05 Data delivery. Fig 6 picks up where Fig 5 ends: request 1005 approved with "Deliver the data when I approve" and
   demo mode on. A replica of the approval app follows the delivery run step by step, as the app does, and then the
   delivery lakehouse opens in Fabric. The diagram under the screen shows the Fabric items behind each step, with the
   product icons of the opening figure: the approval app (Rayfin) starts the Cohort_Delivery_Pipeline (Data Factory),
   which runs the Cohort_Delivery notebook (Analytics); the notebook records each step in the Cohort_Requests database
   (Databases) and fills the delivery lakehouse in OneLake. Tables and documents are copied, imaging studies are
   linked with OneLake shortcuts, as cohort_delivery.py does.

   The numbers are those of a demo-mode delivery of query 1005 computed from the demo data with the delivery code's
   own rules (25 of 358 patients, 19 tables and 14,265 rows, 5 of 47 studies, one of each kind of image first, 20 of
   166 documents). The clock times are illustrative. */
(function () {
  'use strict';

  const card = document.getElementById('dvCard');
  if (!card || !window.FigKit) return;
  const { ICON, esc, image, legend, fitLegends, setLedger, ui, replica } = window.FigKit;

  const W = 1280, H = 740;
  const ME = 'researcher@contoso.com', QM = 1005;
  const COMMENT = 'Approved for the lung screening feasibility study.';
  const DECIDED = '5 Nov 2026, 07:36 UTC';
  const LAKEHOUSE = 'Delivery_QM1005_FormerSmokers50LungNodule6mm_Demo';
  const NOTEBOOK = 'Explore_QM1005_FormerSmokers50LungNodule6mm_Demo';
  const APP_HOST = 'contoso-approvals-centralus.webapp.fabricapps.net';
  const WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';
  const T0 = 7 * 3600 + 36 * 60 + 12; // the run was requested at 07:36:12 UTC
  // The steps the notebook records, at seconds after the request (as the app lists them)
  const RUN = [
    [68, 'The notebook started: 358 patients approved'],
    [79, 'Preparing the delivery of 358 approved patients; demo mode delivers 25 of them'],
    [92, `Created the lakehouse ${LAKEHOUSE}`],
    [106, 'Copied 19 tables (14,265 rows) for 25 patients'],
    [111, 'Linked 5 imaging studies with OneLake shortcuts (demo mode; 47 in all)'],
    [117, 'Copied 20 documents (demo mode; 166 in all)'],
    [121, `Created the notebook ${NOTEBOOK} to explore the data`],
    [125, 'Synced the SQL analytics endpoint: 20 tables can be queried'],
    [127, `Delivered 25 patients to ${LAKEHOUSE}`],
  ];
  const TABLES = ['cohort', 'cohort_definition', 'concept', 'condition_era', 'condition_occurrence', 'death', 'delivery_manifest',
    'document_links', 'drug_era', 'drug_exposure', 'image_feature', 'image_occurrence', 'measurement', 'note', 'observation',
    'observation_period', 'person', 'procedure_occurrence', 'specimen', 'visit_occurrence'];
  // The person rows of the first 12 delivered patients (synthetic), as the demo data has them
  const PERSON_COLS = ['person_id', 'gender_concept_id', 'year_of_birth', 'month_of_birth', 'race_concept_id', 'gender_source_value', 'race_source_value'];
  const PERSONS = [
    [1000006, 8532, 1970, 11, 8527, 'Female', 'White'], [1000008, 8507, 1967, 9, 8515, 'Male', 'Asian'],
    [1000013, 8532, 1966, 11, 8527, 'Female', 'White'], [1000025, 8532, 1972, 1, 8527, 'Female', 'White'],
    [1000033, 8532, 1970, 10, 8527, 'Female', 'White'], [1000043, 8532, 1944, 1, 8527, 'Female', 'White'],
    [1000046, 8507, 1940, 11, 8527, 'Male', 'White'], [1000055, 8532, 1941, 7, 8516, 'Female', 'Black or African American'],
    [1000064, 8507, 1974, 11, 8527, 'Male', 'White'], [1000068, 8507, 1947, 6, 8527, 'Male', 'White'],
    [1000083, 8507, 1946, 1, 8527, 'Male', 'White'], [1000108, 8507, 1973, 11, 8527, 'Male', 'White'],
  ];
  // The 5 linked studies, one of each kind first (two CTs with nodule outlines, a slide, an MR, an X-ray), listed by
  // name as Fabric lists them: a shortcut name can't contain dots, so the name is the UID with underscores
  const STUDIES = ['1.2.840.99999999.35693892.1388913518675',
    '1.3.6.1.4.1.14519.5.2.1.6279.6001.103174142685276436726743937181', '1.3.6.1.4.1.14519.5.2.1.6279.6001.113559330012918930951543504919',
    '1.3.6.1.4.1.14519.5.2.1.6279.6001.135649280843401063699693855484', '2.25.52276604285579967105318065932514803781'];
  const DOC_FOLDERS = [['progress_notes', 11], ['radiology_reports', 8], ['scanned_documents', 1]];

  const STEPS = [
    { chip: 'Queued', label: 'Step 1 of 6',
      text: 'With “Deliver the data when I approve” checked, approving the request starts the Cohort_Delivery_Pipeline in Data Factory, in demo mode. The approval app shows the run as Queued and then Running, and reads its recorded steps every four seconds.' },
    { chip: 'Prepare', label: 'Step 2 of 6',
      text: 'The pipeline runs the Cohort_Delivery notebook. The notebook reads the approved request and its 358 patients from the Cohort_Requests database, then maps the random i2b2 patient numbers back to OMOP persons with the mapping kept in Silver_OMOP. Demo mode delivers 25 of them, those with images and documents first.' },
    { chip: 'Tables', label: 'Step 3 of 6',
      text: 'The notebook creates the delivery lakehouse in the approval app’s folder, named after the request. It copies 19 OMOP tables, 14,265 rows, for the 25 patients, as a limited data set with year and month of birth only and notes without their text. The rows are copied because a shortcut would expose the whole table.' },
    { chip: 'Images and documents', label: 'Step 4 of 6',
      text: 'Each imaging study is linked with a OneLake shortcut to its folder in Bronze_ImagingArchive, and the DICOM files stay in the archive. The documents are copied, because Bronze_ClinicalDocuments files them by type and year and a folder shortcut would include other patients’ documents. Demo mode links 5 of the patients’ 47 studies, taking one of each kind of image first (a CT with nodule outlines, a slide, an MR and an X‑ray), and copies 20 of their 166 documents.' },
    { chip: 'Delivered', label: 'Step 5 of 6',
      text: `Cohort_Delivery adds the notebook ${NOTEBOOK}, attached to the lakehouse, with charts and images for a first look at the data. It syncs the SQL analytics endpoint, which makes the 20 tables queryable, and records the delivery. The request changes to Delivered and the app links to the lakehouse. The run took about two minutes, most of it starting the pipeline and the notebook session.` },
    { chip: 'Explore', label: 'Step 6 of 6',
      text: 'The lakehouse opens in Fabric. The person table has the 25 patients, Files/dicom has one shortcut per study, and Files/documents has the copied reports and notes. In image_occurrence, local_path points at the shortcuts, and a notebook can read the images through them.' },
  ];
  const HOLD = [6400, 7600, 6800, 7000, 7200];

  const { field, status } = ui;
  const clock = (s) => { const t = T0 + s; return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')} UTC`; };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
  const glyph = (file) => `<svg class="fx-ico" viewBox="0 0 20 20" aria-hidden="true">${file === 'table.svg' ? TABLE_PATH : SHORTCUT_PATH}</svg>`;

  /* ---- The approval app, scrolled to the delivery of request 1005 ---- */
  function approvalApp() {
    return `<div class="cd-win dv-win-app">
      <div class="cd-url"><span class="cd-url-text">${APP_HOST}/#/requests/${QM}</span><span class="cd-url-note">Approval app, a Rayfin app on Fabric</span></div>
      <header class="cd-top"><span class="cd-mark"></span><span class="cd-brand">Cohort data requests</span><span class="cd-brand-sub">Review and approval</span>
        <span class="cd-top-gap"></span><span class="cd-mono cd-who">MedicalCohortDemo</span><span class="cd-who">${ME}</span>${ui.themeSeg}</header>
      <div class="cd-pages"><section class="cd-page"><div class="cd-page-in dv-page">
        <p class="cd-note dv-tail">Each count is obfuscated on its own, so the categories don't add up exactly to the total.</p>
        <h2 class="cd-h2">Decision</h2>
        <p class="cd-p">${status('APPROVED')} by ${ME} on ${DECIDED}. <span class="cd-muted">“${esc(COMMENT)}”</span></p>
        <h2 class="cd-h2">Delivery</h2>
        <p class="cd-p">Delivery runs the <b>Cohort_Delivery_Pipeline</b>. It creates a lakehouse next to this app, named after the request (<span class="cd-mono">Delivery_QM${QM}_…</span>): the cohort’s OMOP tables are copied, its DICOM studies are linked with OneLake shortcuts, and its documents are copied.</p>
        <div class="cd-run dv-run">
          <div class="cd-run-head"><span class="dv-status">${status('RUNNING', { RUNNING: 'Queued' })}</span>
            <span class="cd-muted">Cohort_Delivery_Pipeline · demo mode · <span class="dv-elapsed">0:03</span> · started by ${ME}, ${DECIDED}</span></div>
          <ol class="cd-steps dv-steps"><li class="cd-step pending dv-pending">Queued: the pipeline is starting</li></ol>
          <p class="dv-open"><span class="cd-btn dv-open-btn">Open ${LAKEHOUSE} in Fabric ↗</span></p>
          <p class="cd-note"><span class="cd-link dv-runner">Open the running pipeline in Fabric ↗</span><span class="dv-live-note"> · this page updates as each step finishes</span></p>
        </div>
        <div class="dv-again">${ui.check('Demo mode', '25 patients, 20 documents and 5 imaging studies, to keep a live demo short')}
          <p class="cd-p"><span class="cd-btn cd-btn-primary">Deliver again (demo)</span></p></div>
        <p class="cd-notice">Request ${QM} approved by ${ME} at 2026-11-05 07:36 UTC. The delivery has started in demo mode.</p>
        <h2 class="cd-h2">Audit trail</h2>
        <ol class="cd-timeline"><li class="ev-SUBMITTED"><div class="cd-tl-title">Submitted</div><div class="cd-tl-meta">${ME} · 5 Nov 2026, 07:33 UTC</div></li>
          <li class="ev-APPROVED"><div class="cd-tl-title">Approved</div><div class="cd-tl-meta">${ME} · ${DECIDED}</div><div class="cd-tl-detail">${esc(COMMENT)}</div></li>
          <li class="ev-DELIVERY_REQUESTED"><div class="cd-tl-title">Delivery started</div><div class="cd-tl-meta">${ME} · ${DECIDED}</div><div class="cd-tl-detail">Cohort_Delivery_Pipeline in demo mode</div></li></ol>
      </div></section></div>
    </div>`;
  }

  /* ---- The delivery lakehouse in Fabric ---- */
  function fabricApp() {
    const cell = (v) => `<td${typeof v === 'number' ? ' class="num"' : ''}>${esc(v)}</td>`;
    const view = (key, icon, title, meta, body) => `<div class="fx-view" data-v="${key}"><div class="fx-view-h">${icon}<span class="fx-view-t">${title}</span><span class="cd-muted">${meta}</span></div>${body}</div>`;
    return `<div class="cd-win dv-win-fab">
      <div class="cd-url"><span class="cd-url-text">app.fabric.microsoft.com/groups/${WORKSPACE_ID}/lakehouses/…</span><span class="cd-url-note">Microsoft Fabric, the delivery lakehouse</span></div>
      <header class="fx-top"><img src="${ICON}fabric.svg" alt="" width="20" height="20">
        <span class="fx-crumb">MedicalCohortDemo</span><span class="fx-sep">/</span><span class="fx-crumb">Cohort requests</span><span class="fx-sep">/</span>
        <img src="${ICON}lakehouse.svg" alt="" width="18" height="18"><span class="fx-crumb fx-cur">${LAKEHOUSE}</span>
        <span class="cd-top-gap"></span>${ui.seg(['Lakehouse', 'SQL analytics endpoint'], 0)}</header>
      <div class="fx-ribbon"><span class="fx-tab on">Home</span><span class="fx-rb">Get data</span><span class="fx-rb">Open notebook</span><span class="fx-rb">New semantic model</span></div>
      <div class="fx-body">
        <aside class="fx-explorer"><div class="fx-pane-h">Explorer</div>
          <div class="fx-row fx-root"><img src="${ICON}lakehouse.svg" alt="" width="16" height="16"><span class="fx-name">${LAKEHOUSE}</span></div>
          <div class="fx-row fx-group"><span class="fx-tw">⌄</span><span>Tables</span><span class="fx-n">20</span></div>
          ${TABLES.map((t) => `<div class="fx-row fx-leaf${t === 'person' ? ' sel' : ''}" data-t="${t}">${glyph('table.svg')}<span class="fx-name">${t}</span></div>`).join('')}
          <div class="fx-row fx-group"><span class="fx-tw">⌄</span><span>Files</span></div>
          <div class="fx-row fx-leaf" data-f="dicom"><img src="${ICON}folder.svg" alt="" width="16" height="16"><span class="fx-name">dicom</span></div>
          <div class="fx-row fx-leaf" data-f="documents"><img src="${ICON}folder.svg" alt="" width="16" height="16"><span class="fx-name">documents</span></div>
        </aside>
        <main class="fx-main" data-view="person">
          ${view('person', glyph('table.svg'), 'person', '25 rows · Delta table · showing the first 12',
            `<table class="fx-grid"><thead><tr>${PERSON_COLS.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${PERSONS.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table>`)}
          ${view('dicom', '<img src="' + ICON + 'folder.svg" alt="" width="18" height="18">', 'Files / dicom', '5 shortcuts to Bronze_ImagingArchive',
            `<table class="fx-grid fx-files"><thead><tr><th>Name</th><th>Type</th><th>Points to</th></tr></thead><tbody>${STUDIES.map((u) => `<tr><td>${glyph('folder-shortcut.svg')}<span class="fx-name">${u.replace(/\./g, '_')}</span></td><td>Shortcut</td><td><span class="fx-name">Bronze_ImagingArchive/Files/dicom/${u}</span></td></tr>`).join('')}</tbody></table>
            <p class="cd-note">image_occurrence.local_path points at these shortcuts. The DICOM files stay in Bronze_ImagingArchive.</p>`)}
          ${view('documents', '<img src="' + ICON + 'folder.svg" alt="" width="18" height="18">', 'Files / documents', '20 documents copied from Bronze_ClinicalDocuments',
            `<table class="fx-grid fx-files"><thead><tr><th>Name</th><th>Type</th><th class="num">Files</th></tr></thead><tbody>${DOC_FOLDERS.map(([f, n]) => `<tr><td><img src="${ICON}folder.svg" alt="" width="16" height="16"><span class="fx-name">${f}</span></td><td>Folder</td><td class="num">${n}</td></tr>`).join('')}</tbody></table>
            <p class="cd-note">Each folder keeps the year folders of Bronze_ClinicalDocuments. document_links lists all 166 documents, with a link for the 20 copied.</p>`)}
        </main>
      </div>
    </div>`;
  }

  /* ---- The Fabric items behind each step, under the screen ---- */
  // data-on: the step from which a part is shown; data-live: the steps in which it is the part being described;
  // --d: its delay within its first step, to follow the app's steps
  const part = (on, live, d = 0) => `data-on="${on}" data-live="${live}" style="--d:${d}s"`;
  const NODE_Y = 44, NODE_H = 60, LY = NODE_Y + NODE_H / 2;
  const NODES = [
    { x: 0, icon: 'rayfin.svg', name: 'Approval app', sub: 'Rayfin app on Fabric', on: 0, live: '0,4' },
    { x: 263, icon: 'data-factory.svg', name: 'Cohort_Delivery_Pipeline', sub: 'Data Factory pipeline', on: 0, live: '0', d: 0.9 },
    { x: 526, icon: 'analytics.svg', name: 'Cohort_Delivery', sub: 'Python notebook', on: 1, live: '1,2,3', d: 0.3 },
    { x: 790, icon: 'databases.svg', name: 'Cohort_Requests', sub: 'SQL database in Fabric', on: 1, live: '1,4', d: 0.8 },
  ];
  const NW = 210;
  const ROWS = [222, 268, 314], RH = 38, SRC = [16, 236], DLV = [624, 984], SUB = [640, 968];
  const BAND = [146, 352];
  function flowMap() {
    const nodes = NODES.map((n) => `<g class="dv-node" ${part(n.on, n.live, n.d)} transform="translate(${n.x} ${NODE_Y})">
        <rect x="0.75" y="0.75" width="${NW - 1.5}" height="${NODE_H - 1.5}" rx="4"/>${image(n.icon, 14, 15, 30)}
        <text class="u-name dv-node-name" x="54" y="27">${esc(n.name)}</text><text class="u-meta" x="54" y="44">${esc(n.sub)}</text></g>`).join('');
    const arrow = (x1, x2, label, on, live, d) => `<g class="dv-lane" ${part(on, live, d)}>
        <line x1="${x1}" y1="${LY}" x2="${x2}" y2="${LY}" pathLength="1"/><path class="dv-head" d="M${x2 - 6} ${LY - 4}L${x2} ${LY}l-6 4"/>
        <text class="u-meta dv-lane-label" x="${(x1 + x2) / 2}" y="${LY - 8}" text-anchor="middle">${label}</text>
        <g transform="translate(${x1 + 2} ${LY - 3.5})"><rect class="dv-pk" width="8" height="7" rx="1" style="--dx:${x2 - x1 - 14}px"/></g></g>`;
    const lanes = arrow(212, 261, 'starts', 0, '0', 0.4) + arrow(475, 524, 'runs', 1, '1') + arrow(738, 788, 'records', 1, '1,2,3', 0.6);
    // The app reads the recorded steps: from the request store back over the top to the app
    const arc = `<g class="dv-lane dv-arc" ${part(1, '1,4', 1.2)}>
        <path d="M895 ${NODE_Y - 4}V24Q895 18 889 18H111Q105 18 105 24V${NODE_Y - 4}" pathLength="1"/><path class="dv-head" d="M101 ${NODE_Y - 10}L105 ${NODE_Y - 4}l4 -6"/>
        <text class="u-meta dv-lane-label" x="500" y="12" text-anchor="middle">The app reads the recorded steps every 4 seconds</text></g>`;
    // The notebook writes into OneLake
    const down = `<g class="dv-lane" ${part(2, '2,3', 0.5)}><path d="M631 ${NODE_Y + NODE_H + 4}V150" pathLength="1"/><path class="dv-head" d="M627 144L631 150l4 -6"/>
        <text class="u-meta dv-lane-label" x="641" y="132">copies and links</text></g>`;

    // [icon, name, sub, first step, live steps, delay]
    const srcRows = [['lakehouse.svg', 'Silver_OMOP', 'OMOP tables', 1, '1,2', 2.2], ['lakehouse.svg', 'Bronze_ClinicalDocuments', 'Reports and notes', 3, '3', 2.4],
      ['lakehouse.svg', 'Bronze_ImagingArchive', 'DICOM studies', 3, '3', 0.6]];
    const sources = srcRows.map(([icon, name, sub, on, live, d], i) => `<g class="dv-item" ${part(on, live, d)} transform="translate(${SRC[0]} ${ROWS[i] - RH / 2})">
        <rect x="0.5" y="0.5" width="${SRC[1] - SRC[0] - 1}" height="${RH - 1}" rx="3"/>${image(icon, 10, 10, 18)}
        <text class="dv-iname" x="36" y="16">${esc(name)}</text><text class="u-meta" x="36" y="30">${esc(sub)}</text></g>`).join('');
    // [icon, name, meta, step, class, delay]: each row appears when its step is recorded in the app
    const subRows = [['table.svg', 'Tables', '19 tables, 14,265 rows', 2, 'dv-sub-tables', 3.1], ['folder.svg', 'Files/documents', '20 documents copied', 3, '', 3.0],
      ['folder-shortcut.svg', 'Files/dicom', '5 study shortcuts', 3, '', 1.2]];
    const dlvH = BAND[1] - 8 - (BAND[0] + 12);
    const delivery = `<g class="dv-slot"><rect x="${DLV[0] + 0.5}" y="${BAND[0] + 12}" width="${DLV[1] - DLV[0] - 1}" height="${dlvH}" rx="4"/>
        <text x="${(DLV[0] + DLV[1]) / 2}" y="${BAND[0] + 12 + dlvH / 2 + 4}" text-anchor="middle">The delivery lakehouse</text></g>
      <g class="dv-dlv" ${part(2, '2,3,5', 0.9)}><rect class="dv-dlv-box" x="${DLV[0] + 0.75}" y="${BAND[0] + 12}" width="${DLV[1] - DLV[0] - 1.5}" height="${dlvH}" rx="4"/>
        ${image('lakehouse.svg', DLV[0] + 14, BAND[0] + 22, 18)}<text class="dv-iname dv-dlv-name" x="${DLV[0] + 40}" y="${BAND[0] + 36}">${LAKEHOUSE}</text>
        ${subRows.map(([icon, name, sub, on, cls, d], i) => `<g class="dv-sub ${cls}" ${part(on, String(on), d)} transform="translate(${SUB[0]} ${ROWS[i] - RH / 2})">
          <rect x="0.5" y="0.5" width="${SUB[1] - SUB[0] - 1}" height="${RH - 1}" rx="3"/>
          ${icon === 'folder.svg' ? image(icon, 10, 10, 18) : `<g class="dv-glyph" transform="translate(10 10) scale(0.9)">${icon === 'table.svg' ? TABLE_PATH : SHORTCUT_PATH}</g>`}
          <text class="dv-iname" x="36" y="16">${esc(name)}</text><text class="u-meta dv-sub-meta" x="36" y="30">${esc(sub)}</text></g>`).join('')}</g>`;
    // Copies (solid, rows moving to the lakehouse) and the shortcut (dashed pointer to the source, dashes marching
    // toward it, nothing moving along it), as in Fig 1
    const x1 = SRC[1] + 4, x2 = DLV[0] - 4;
    const copy = (i, label, on, d) => `<g class="dv-lane dv-copy" ${part(on, String(on), d)}>
        <line x1="${x1}" y1="${ROWS[i]}" x2="${x2}" y2="${ROWS[i]}" pathLength="1"/><path class="dv-head" d="M${x2 - 6} ${ROWS[i] - 4}L${x2} ${ROWS[i]}l-6 4"/>
        <text class="u-meta dv-lane-label" x="${(x1 + x2) / 2}" y="${ROWS[i] - 8}" text-anchor="middle">${label}</text>
        ${[0, 0.9].map((o) => `<g transform="translate(${x1 + 4} ${ROWS[i] - 4.5})"><g class="dv-row" style="--dx:${x2 - x1 - 26}px;--o:${o}s"><rect width="12" height="9" rx="1.5"/><path d="M2.5 3h7M2.5 6h7"/></g></g>`).join('')}</g>`;
    const shortcut = `<g class="dv-lane dv-short" ${part(3, '3', 0.6)}>
        <line x1="${x2}" y1="${ROWS[2]}" x2="${x1}" y2="${ROWS[2]}"/><path class="dv-head" d="M${x1 + 6} ${ROWS[2] - 4}L${x1} ${ROWS[2]}l6 4"/>
        <text class="u-meta dv-lane-label" x="${(x1 + x2) / 2}" y="${ROWS[2] - 8}" text-anchor="middle">a OneLake shortcut per study</text></g>`;
    return `<svg class="u-svg dv-svg" viewBox="0 0 1000 ${BAND[1] + 4}" aria-hidden="true">
      ${arc}${nodes}${lanes}
      <rect class="dv-band" x="0.75" y="${BAND[0]}" width="998.5" height="${BAND[1] - BAND[0]}" rx="6"/>
      ${legend(12, BAND[0], [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel')}
      ${down}${sources}${delivery}
      ${copy(0, 'copied, the cohort’s rows', 2, 1.6)}${copy(1, 'copied, the cohort’s documents', 3, 2.4)}${shortcut}
    </svg>`;
  }
  // Fluent glyphs from the Fabric icon package (table, folder shortcut), drawn in the text colour
  const TABLE_PATH = '<path d="M5.5 17A2.5 2.5 0 0 1 3 14.5v-9A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5zM16 7V5.5a1.5 1.5 0 0 0-1.356-1.493L14.5 4H13v3zm-4-3H8v3h4zM7 4H5.5a1.5 1.5 0 0 0-1.493 1.356L4 5.5V7h3zM4 8v6.5a1.5 1.5 0 0 0 1.356 1.493L5.5 16h9a1.5 1.5 0 0 0 1.493-1.356L16 14.5V8z"/>';
  const SHORTCUT_PATH = '<path d="M17 11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zm-3.5 2a.5.5 0 0 0 0 1h1.793l-2.146 2.146a.5.5 0 0 0 .707.707L16 14.707V16.5a.5.5 0 0 0 1 0v-3a.5.5 0 0 0-.5-.5z"/><path d="M6.982 3c.464 0 .91.185 1.238.513L9.707 5H15.5A2.5 2.5 0 0 1 18 7.5v2.674A3 3 0 0 0 17 10V7.5A1.5 1.5 0 0 0 15.5 6H9.707l-1.56 1.56A1.5 1.5 0 0 1 7.085 8H3v6.5A1.5 1.5 0 0 0 4.5 16H10v1H4.5A2.5 2.5 0 0 1 2 14.5v-9A2.5 2.5 0 0 1 4.5 3zM4.5 4A1.5 1.5 0 0 0 3 5.5V7h4.086a.5.5 0 0 0 .353-.146L8.793 5.5l-1.28-1.28a.75.75 0 0 0-.53-.22z"/>';

  const flowHost = document.getElementById('dvFlow');
  flowHost.innerHTML = flowMap();
  const fsvg = flowHost.querySelector('svg');
  fitLegends(fsvg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(fsvg));
  const fparts = [...fsvg.querySelectorAll('[data-on]')];
  function setFlow(n) {
    fsvg.dataset.stage = String(n);
    fparts.forEach((el) => {
      const on = Number(el.dataset.on), live = el.dataset.live ? el.dataset.live.split(',').map(Number) : [];
      el.classList.toggle('is-on', n >= on);
      el.classList.toggle('is-now', n === on);
      el.classList.toggle('is-live', live.includes(n));
    });
  }

  /* ---- Scenes ---- */
  const ledgerEl = document.getElementById('dvLedger');
  const LEDGER0 = { patients: '<b>–</b> patients', tables: '<b>–</b> tables', files: '<b>–</b> files' };
  const ledger = (c, key, html) => { c.guard(); setLedger(ledgerEl, key, html, c.animate); };
  let stage = null;
  const $ = (sel) => stage.querySelector(sel);

  function addStep(c, i) {
    c.guard();
    const [s, text] = RUN[i], final = i === RUN.length - 1;
    const li = document.createElement('li');
    li.className = `cd-step${final ? ' final' : ''}${c.animate ? ' is-new' : ''}`;
    li.innerHTML = `<span>${esc(text)}</span><span class="cd-step-time">${clock(s)}</span>`;
    $('.dv-steps').insertBefore(li, $('.dv-pending'));
    $('.dv-pending').textContent = 'Working…';
  }
  let elapsed = 3;
  const tick = (c, to, ms) => { const from = elapsed; elapsed = to; return c.tween(ms, (p) => { $('.dv-elapsed').textContent = mmss(from + (to - from) * p); }, (p) => p); };

  const SCENES = [
    // 1. Queued, then running: the pipeline starts the notebook session
    async (c) => {
      elapsed = 3; setFlow(0);
      await c.wait(700);
      await tick(c, 36, 2600);
      $('.dv-status').innerHTML = status('RUNNING');
      $('.dv-pending').textContent = 'Starting the notebook session';
      await tick(c, 66, 2400);
    },
    // 2. The notebook starts and prepares the patient list
    async (c) => {
      setFlow(1);
      await tick(c, 68, 400);
      addStep(c, 0);
      await c.wait(1300);
      await tick(c, 79, 900);
      addStep(c, 1);
      ledger(c, 'patients', '<b>25</b> of 358 patients');
    },
    // 3. The lakehouse is created and the tables copied
    async (c) => {
      setFlow(2);
      await tick(c, 92, 900);
      addStep(c, 2);
      await c.wait(900);
      await tick(c, 106, 1300);
      addStep(c, 3);
      ledger(c, 'tables', '<b>19</b> tables copied');
    },
    // 4. Imaging studies linked, documents copied
    async (c) => {
      setFlow(3);
      await tick(c, 111, 1200);
      addStep(c, 4);
      await c.wait(700);
      await tick(c, 117, 1100);
      addStep(c, 5);
      ledger(c, 'files', '<b>5</b> shortcuts, 20 documents');
    },
    // 5. The endpoint is synced and the request is Delivered
    async (c) => {
      setFlow(4);
      await tick(c, 121, 700);
      addStep(c, 6);
      await c.wait(400);
      await tick(c, 125, 700);
      addStep(c, 7);
      await c.wait(400);
      await tick(c, 127, 300);
      addStep(c, 8);
      $('.dv-pending').remove();
      $('.dv-status').innerHTML = status('DELIVERED');
      $('.dv-run').classList.add('is-done');
      $('.dv-runner').textContent = 'Open the pipeline in Fabric ↗';
      ledger(c, 'tables', '<b>20</b> tables to query');
      fsvg.querySelector('.dv-sub-tables .dv-sub-meta').textContent = '20 tables, with the delivery manifest';
      await c.wait(500);
      const page = $('.dv-page');
      const again = $('.dv-again');
      await c.scroll(page, c.top(page, again) + again.offsetHeight + 28 - page.parentElement.clientHeight, 1000);
    },
    // 6. The lakehouse in Fabric: the person table, the DICOM shortcuts, the documents
    async (c) => {
      setFlow(5);
      const open = $('.dv-open-btn');
      await c.point(open, 800, 0.4);
      await c.click(open);
      c.hide();
      stage.classList.add('is-fab');
      await c.wait(2600);
      for (const f of ['dicom', 'documents']) {
        const row = $(`.fx-row[data-f="${f}"]`);
        await c.point(row, 750, 0.3);
        await c.click(row);
        stage.querySelectorAll('.fx-row.sel').forEach((r) => r.classList.remove('sel'));
        row.classList.add('sel');
        $('.fx-main').dataset.view = f;
        await c.wait(f === 'dicom' ? 2600 : 600);
      }
      c.hide();
    },
  ];

  replica({
    card, view: document.getElementById('dvView'), W, H, stageClass: 'dv-stage', html: () => approvalApp() + fabricApp(),
    scenes: SCENES, steps: STEPS, hold: HOLD,
    chips: document.getElementById('dvSteps'), playBtn: document.getElementById('dvPlay'), cap: document.getElementById('dvCap'),
    onStage: (el) => { stage = el; },
    onReset: () => {
      elapsed = 3;
      setFlow(-1);
      fsvg.querySelector('.dv-sub-tables .dv-sub-meta').textContent = '19 tables, 14,265 rows';
      Object.entries(LEDGER0).forEach(([key, html]) => setLedger(ledgerEl, key, html, false));
    },
  });
})();
