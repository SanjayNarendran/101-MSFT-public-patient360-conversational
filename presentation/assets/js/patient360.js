/* 07 Research: Patient 360. Fig 8 is a replica of the Patient 360 app (apps/patient360) as a Fabric App, played as six
   scenes with a pointer: the Patients page with the demo patients first; Levi Hills' record, whose lifetime timeline
   draws from his Epic visits, conditions and orders, his PACS studies, his slide and his documents; Read in place, the
   15 queries that assembled the page; his screening CT in the viewer with the radiologists' nodule outlines; his
   biopsy slide zoomed to 20×; and a research patient, Damian Macejkovic (TCGA), with the AI lymphocyte map on his
   slide and his tumour genome. Under it, a diagram of where the record is read. The data and images are the app's
   own (assets/js/p360kit.js). */
(function () {
  'use strict';

  const card = document.getElementById('ptCard');
  if (!card || !window.FigKit || !window.P360Kit) return;
  const { ICON, esc, image, legend, fitLegends, setLedger, ui, replica } = window.FigKit;
  const K = window.P360Kit, D = K.D, L = D.levi;

  const W = 1280, H = 760;
  const HOST = 'contoso-patient360-centralus.webapp.fabricapps.net';
  const ME = 'researcher@contoso.com';

  const STEPS = [
    { chip: 'Patients', label: 'Step 1 of 6',
      text: 'The Patients page lists the 27 demo patients first, each with the reason it was picked. Search finds any of the 3,554 by name, MRN, ID or condition, and the filters narrow them to what each has online. Levi Hills is a daily smoker whose screening CT found ten nodules a year before his lung cancer was diagnosed.' },
    { chip: 'The record', label: 'Step 2 of 6',
      text: 'His record opens on one timeline from birth to death, with a lane each for visits, conditions and medications, the cancer course, imaging with pathology and documents, and the tumour board. The marks come from 132 visits and 176 prescriptions in Epic, five studies in the PACS and nine documents.' },
    { chip: 'Read in place', label: 'Step 3 of 6',
      text: 'Read in place shows how the page was assembled: 15 queries through the Patient360 lakehouse’s SQL analytics endpoint, which reaches the Epic tables, the PACS database and the documents lakehouse where they are. One statement joins the PACS studies to their Epic orders and reports.' },
    { chip: 'Screening CT', label: 'Step 4 of 6',
      text: 'Selecting the CT on the timeline opens the screening CT of 18 November 2019 in the lung window, centred on the largest nodule, 16.2 mm in the left lower lobe. The outlines are the LIDC radiologists’ own. Go to moves through the slices to the 13.0 mm nodule in the right lower lobe.' },
    { chip: 'Biopsy slide', label: 'Step 5 of 6',
      text: 'The biopsy slide of 8 December 2020 opens in the deep-zoom viewer. Its tiles were made from the DICOM in the imaging archive and stream from OneLake through read-only links scoped to this patient. At 20× the view fills with the squamous cell carcinoma the pathology report describes.' },
    { chip: 'Research patient', label: 'Step 6 of 6',
      text: 'The 15 research patients are real TCGA cases. Damian Macejkovic’s diagnostic slide has an AI lymphocyte map, which flags 16.9% of the tissue as lymphocyte-rich, the highest of the 15 research patients. At 10× the map is hidden again to show the cells under it. His tumour genome has 285 mutations, among them TP53 and KEAP1, and the chromosome 3q gain that carries SOX2 and TP63.' },
  ];
  const HOLD = [7600, 8800, 9000, 9800, 9000];

  /* ---- The app's top bar and the patients rail ---- */
  const appTop = (active) => `<div class="cd-url"><span class="cd-url-text">${HOST}/${active === 'list' ? '' : 'p/Z1001228'}</span><span class="cd-url-note">Patient 360, a Rayfin app on Fabric</span></div>
    <header class="p3-top"><span class="cd-mark"></span><span class="p3-brand">Patient 360</span>
      <nav class="p3-nav-tabs"><span class="on">Patients</span><span>Ask</span><span>Where the data lives</span><span>Sources</span></nav>
      <span class="cd-top-gap"></span><span class="cd-mono cd-who">MedicalCohortDemo</span><span class="cd-who">${ME}</span><span class="cd-who">Sign out</span>${ui.themeSeg}</header>`;
  const INITIALS = ['SR', 'LH', 'CH', 'KL', 'BF', 'EN', 'SB', 'BC', 'AS', 'AH'];
  const rail = (on) => `<aside class="p3-rail"><span class="p3-rail-btn">›</span>${INITIALS.map((x) => `<span class="${x === on ? 'on' : ''}">${x}</span>`).join('')}</aside>`;

  /* ---- The Patients page ---- */
  function patientsPage() {
    const rows = D.demo.map(([id, name, mrn, who, title, why, online, visits, studies, onl, docs]) => `<tr class="${id === 'Z1001228' ? 'p3-row-levi' : ''}">
      <td><b>${esc(name)}</b><span class="p3-mono">${id} · MRN ${mrn}</span><span>${esc(who)}</span></td>
      <td><b>${esc(title)}</b><span class="p3-why">${esc(why)}</span></td><td>${esc(online)}</td>
      <td class="p3-num">${visits}</td><td class="p3-num">${studies}<span>${onl} online</span></td><td class="p3-num">${docs}</td></tr>`).join('');
    return `<section class="p3-page p3-pg-list">${rail('')}<div class="p3-main">
      <div class="p3-eyebrow">Patient 360</div><h1 class="p3-h1">Patients</h1>
      <p class="p3-lede">3,539 synthetic patients, each with a whole record across the hospital’s systems: visits, problems, prescriptions and results from Epic, studies from the PACS, DICOM images from the archive, and reports and notes, typed and scanned. The demo patients come first; search to find anyone else. Select a patient to open their record.</p>
      <div class="p3-search">${ui.field('p3-q', 'Name, MRN, patient ID or condition')}<span class="cd-btn">Search</span>${ui.seg(['Demo patients', 'All patients'], 0)}</div>
      <div class="p3-filters"><span class="p3-fl">Has online</span>${['Chest CT', 'Outlined nodules', 'Brain MRI', 'X-ray', 'Pathology slide', 'Scanned document', 'Tumour genome'].map((f) => `<span class="p3-cb"><i></i>${f}</span>`).join('')}</div>
      <div class="p3-count">27 patients in the demo · showing 10</div>
      <table class="p3-table"><thead><tr><th>Patient</th><th>Why this patient</th><th>Online</th><th>Visits</th><th>Studies</th><th>Documents</th></tr></thead><tbody>${rows}</tbody></table>
    </div></section>`;
  }

  /* ---- Levi Hills' record: header, lifetime timeline, tabs and their panes ---- */
  const TW = 1176, X0 = 214, X1 = TW - 12, PW = X1 - X0, BIRTH = L.born, BREAK = 2018.5, END = 2026.25, CUT = 0.45;
  const X = (y) => (y <= BREAK ? X0 + ((y - BIRTH) / (BREAK - BIRTH)) * CUT * PW : X0 + (CUT + ((y - BREAK) / (END - BREAK)) * (1 - CUT)) * PW);
  const SYS = { meta: 'var(--p3-meta)', resp: 'var(--p3-resp)', mind: 'var(--p3-mind)', msk: 'var(--p3-msk)', other: 'var(--p3-other)' };
  const measure = (() => {
    const cx = document.createElement('canvas').getContext('2d');
    return (t, size = 11.5, weight = 500) => { cx.font = `${weight} ${size}px "Fira Sans", system-ui, sans-serif`; return cx.measureText(t).width; };
  })();
  const fitText = (t, room) => {
    if (measure(t) <= room) return t;
    let s = t;
    while (s.length > 3 && measure(`${s}…`) > room) s = s.slice(0, -1);
    return `${s.trimEnd()}…`;
  };
  const dateLabel = (y) => {
    const d = new Date(Date.UTC(Math.floor(y), 0, 1) + (y % 1) * 365.25 * 864e5);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const LANES = [['Visits', 'Epic, synthetic', 48, 40], ['Conditions and medications', 'Epic, synthetic', 92, 140], ['Cancer course and treatment', 'Epic problem list and orders', 236, 62],
    ['Imaging, pathology and documents', 'PACS, archive, documents', 302, 46], ['Tumour board', '', 352, 26]];
  const TH = 384;
  function timeline() {
    let s = '';
    // The axis: ages, then years; the early decades are drawn closer together
    const ages = [[BIRTH, 'birth'], ...[10, 20, 30, 40, 50, 60, 70].map((a) => [BIRTH + a, String(a)]), ...[79, 80, 81, 82, 83, 84, 85].map((a) => [BIRTH + a, String(a)])];
    ages.forEach(([y, t]) => { s += `<text class="p3-tl-age" x="${X(y).toFixed(1)}" y="13" text-anchor="middle">${t}</text>`; });
    [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].forEach((y) => {
      s += `<text class="p3-tl-yr" x="${X(y).toFixed(1)}" y="31" text-anchor="middle">${y}</text><line class="p3-tl-grid" x1="${X(y).toFixed(1)}" x2="${X(y).toFixed(1)}" y1="40" y2="${TH - 4}"/>`;
    });
    s += `<text class="p3-tl-brk" x="${X(BREAK).toFixed(1)}" y="46" text-anchor="middle">||</text>`;
    LANES.forEach(([name, src, y, h], i) => {
      if (i) s += `<line class="p3-tl-lane" x1="0" x2="${TW}" y1="${y - 2}" y2="${y - 2}"/>`;
      const words = name.split(' and ');
      s += `<text class="p3-tl-ln" x="2" y="${y + 14}">${words.length > 1 && measure(name, 13, 600) > 190 ? `${esc(words[0])} and</text><text class="p3-tl-ln" x="2" y="${y + 28}">${esc(words.slice(1).join(' and '))}` : esc(name)}</text>`;
      if (src) s += `<text class="p3-tl-src" x="2" y="${y + (words.length > 1 && measure(name, 13, 600) > 190 ? 42 : 28)}">${esc(src)}</text>`;
    });
    let marks = '';
    // Visits
    L.visits.forEach((v, i) => { marks += `<line class="p3-tl-visit" x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${i % 3 === 0 ? 58 : 62}" y2="74"/>`; });
    // Conditions: an onset dot each, then a bar from onset for the main ones; the two long medications under them
    L.conds.forEach(([y, , sys]) => { marks += `<circle cx="${X(y).toFixed(1)}" cy="104" r="4.5" style="fill:${SYS[sys]}"/>`; });
    const bars = [...['Body mass index 30+ - obesity', 'Prediabetes', 'Smokes tobacco daily', 'Alcoholism', 'Chronic sinusitis', 'Hyperlipidemia', 'Pulmonary emphysema', 'Multiple pulmonary nodules']
      .map((n) => { const c = L.conds.find((x) => x[1] === n); return [c[0], L.died, n, c[2]]; }),
    ...L.meds.filter((m) => m[1] - m[0] > 5).map(([a, b, g, sys]) => [a, b, g.replace(/^./, (x) => x.toUpperCase()).replace(' / ', '/'), sys])];
    bars.forEach(([a, b, n, sys], i) => {
      const y = 118 + i * 11.2, xa = X(a), room = xa - 112;
      marks += `<line class="p3-tl-bar" x1="${xa.toFixed(1)}" x2="${X(b).toFixed(1)}" y1="${y}" y2="${y}" style="stroke:${SYS[sys]}"/>`;
      marks += `<text class="p3-tl-bl" x="${(xa - 6).toFixed(1)}" y="${y + 3.6}" text-anchor="end" style="fill:${SYS[sys]}">${esc(fitText(n, room))}</text>`;
    });
    // Cancer course: diagnosis, the two drugs, death
    const yc = 236;
    marks += `<path class="p3-tl-dx" d="M${X(L.dx).toFixed(1)} ${yc + 6}l8 8-8 8-8-8z"/>`;
    L.tx.forEach(([n, a, b], i) => {
      const y = yc + 34 + i * 12;
      marks += `<line class="p3-tl-tx" x1="${X(a).toFixed(1)}" x2="${X(b).toFixed(1)}" y1="${y}" y2="${y}"/><text class="p3-tl-bl" x="${(X(a) - 6).toFixed(1)}" y="${y + 3.6}" text-anchor="end">${n}</text>`;
    });
    marks += `<path class="p3-tl-death" d="M${(X(L.died) - 6).toFixed(1)} ${yc + 8}l12 12M${(X(L.died) + 6).toFixed(1)} ${yc + 8}l-12 12"/>`;
    // Imaging: online studies filled, offline hollow; the slide in the pathology colour; documents small and hollow
    L.studies.forEach(([y, mod, online], i) => {
      if (mod === 'SM') return;
      marks += `<rect class="p3-tl-img${online ? ' on' : ''}${mod === 'CT' && online ? ' p3-ctmark' : ''}" x="${(X(y) - 5.5).toFixed(1)}" y="${online ? 310 : 326}" width="11" height="11"/>`;
    });
    marks += `<rect class="p3-tl-img p3-tl-slide on p3-slmark" x="${(X(L.slide) - 5.5 + 7).toFixed(1)}" y="310" width="11" height="11"/>`;
    L.docs.forEach(([y], i) => { marks += `<rect class="p3-tl-doc" x="${(X(y) - 3.5 + (i % 2) * 3).toFixed(1)}" y="340" width="7" height="7"/>`; });
    marks += `<circle class="p3-tl-note" cx="${X(L.dx).toFixed(1)}" cy="365" r="5"/>`;
    // Death and the selected date
    marks += `<line class="p3-tl-died" x1="${X(L.died).toFixed(1)}" x2="${X(L.died).toFixed(1)}" y1="42" y2="${TH - 4}"/><text class="p3-tl-mk" x="${(X(L.died) - 4).toFixed(1)}" y="56" text-anchor="end">Died</text>`;
    marks += `<text class="p3-tl-mk" x="${(X(L.dx) + 5).toFixed(1)}" y="56">Diagnosis</text>`;
    const sel = `<g class="p3-sel" style="--x:${X(L.dx).toFixed(1)}px"><line x1="0" x2="0" y1="38" y2="${TH - 4}"/><g transform="translate(0 22)"><rect x="-38" y="-9" width="76" height="17" rx="8.5"/><text class="p3-sel-t" x="0" y="3.6" text-anchor="middle">${dateLabel(L.dx)}</text></g></g>`;
    return `<svg class="p3-tl" viewBox="0 0 ${TW} ${TH}" aria-hidden="true"><defs><clipPath id="p3Wipe"><rect class="p3-wipe" x="0" y="0" width="0" height="${TH}"/></clipPath></defs>
      ${s}<g clip-path="url(#p3Wipe)">${marks}</g>${sel}<line class="p3-tl-edge" x1="0" x2="0" y1="40" y2="${TH - 4}"/></svg>`;
  }
  const TABS = [['summary', 'Summary'], ['visits', 'Visits', 132], ['meas', 'Measurements', 27], ['cond', 'Conditions', 15], ['meds', 'Medications', 10], '|', ['cancer', 'Cancer course', 3], ['tx', 'Treatment', 3], '|',
    ['radiology', 'Radiology', 4], ['pathology', 'Pathology'], ['docs', 'Documents', 9], '|', ['board', 'Tumour board']];
  const tabs = (list) => `<div class="p3-tabs">${list.map((t) => (t === '|' ? '<i></i>' : `<span data-tab="${t[0]}"${t[0] === 'summary' ? ' class="on"' : ''}>${t[1]}${t[2] ? ` <small>${t[2]}</small>` : ''}</span>`)).join('')}</div>`;
  const section = (label, extra = '') => `<div class="p3-sec"><span class="p3-pill">${label}</span><i></i>${extra}</div>`;

  function recordPage() {
    const strip = [['clin', 'Epic Clarity', '132 visits · 522 results'], ['clin', 'Problems and orders', '15 problems · 176 prescriptions'], ['rad', 'PACS', '5 studies · 2 online · 10 nodules'],
      ['path', 'Slide', '1 · 0.2 gigapixels'], ['doc', 'Documents', '9 · 0 scanned'], ['acc', 'Read in place', '<u class="p3-rip">15 queries · 4 sources</u>']];
    return `<section class="p3-page p3-pg-rec">${rail('LH')}<div class="p3-main p3-scrollbox"><div class="p3-scroll">
      <div class="p3-head"><span class="p3-name">Levi Hills</span><span class="p3-mono">Z1001228</span><span class="p3-badge">synthetic patient</span>
        <span class="p3-headline">Non-small cell lung cancer · 85 M · MRN 20951180 · died Dec 2025</span><u>Ask about this patient</u><span class="cd-top-gap"></span><span class="cd-btn">Key</span></div>
      ${section('Timeline', '<span class="p3-hide">Hide</span>')}
      ${timeline()}
      ${section('Details')}
      ${tabs(TABS)}
      <div class="p3-panes">
        <div class="p3-pane-tab" data-pane="summary">
          <div class="p3-sum"><div><div class="p3-sum-t">Non-small cell lung cancer; Non-small cell carcinoma of lung TNM stage 1</div><div class="p3-sum-s">Man, died aged 85 · White · Not Hispanic or Latino · Springfield, MA</div></div>
            <dl class="p3-dl"><div><dt>In the record</dt><dd>74 years 2 months<span>Oct 1951 to Dec 2025</span></dd></div><div><dt>Died</dt><dd class="p3-alert">6 Dec 2025</dd></div>
              <div><dt>Primary care</dt><dd>Jeffie Zieme</dd></div><div><dt>Identifiers</dt><dd class="p3-mono">MRN 20951180 · Z1001228</dd></div></dl></div>
          <div class="p3-strip">${strip.map(([c, k, v]) => `<div><span><i class="p3-sw p3-sw-${c}"></i>${k}</span><b>${v}</b></div>`).join('')}</div>
        </div>
        <div class="p3-pane-tab" data-pane="radiology">
          <div class="p3-when"><span>18 Nov 2019 · age 79 · 384 days before diagnosis</span><span class="p3-mono">public images, synthetic patient</span><span class="p3-mono"><i class="p3-sw p3-sw-rad"></i>Bronze_PACS: pacs.Study, pacs.Series, pacs.NoduleFinding</span></div>
          <div class="p3-ptitle">CT Chest Lung Cancer Screening Low Dose</div>
          ${K.ctViewer(372)}
        </div>
        <div class="p3-pane-tab" data-pane="pathology">
          <div class="p3-when"><span>8 Dec 2020 · age 80 · 2 days after diagnosis</span><span class="p3-mono">public images, synthetic patient</span><span class="p3-mono"><i class="p3-sw p3-sw-path"></i>Bronze_PACS: pacs.Study, pacs.Series</span></div>
          <div class="p3-ptitle">Surgical pathology, lung</div>
          ${K.slideViewer('levi', 352)}
        </div>
      </div>
    </div></div>${drawer()}</section>`;
  }

  /* ---- Read in place: how the page was assembled ---- */
  const GROUPS = [['clarity', 'clin', 'Epic Clarity', 'Delta tables in a lakehouse'], ['p360', 'acc', 'Patient 360', 'Lakehouse: patient index and viewer files'],
    ['pacs', 'rad', 'PACS index', 'Fabric SQL database'], ['documents', 'doc', 'Clinical documents', 'Lakehouse: text, scanned PDFs, facts']];
  function drawer() {
    const row = (q) => `<div class="p3-prov"><span class="p3-mono">${q[2].join(', ')}</span><span>${K.fmt(q[3])} rows</span></div>`;
    const cross = L.prov.filter((q) => q[1].length > 1);
    return `<div class="p3-scrim"></div><aside class="p3-drawer"><div class="p3-dr-head"><div><div class="p3-eyebrow">Read in place</div><div class="p3-dr-t">How this page was assembled</div></div><span class="cd-btn p3-close">Close</span></div>
      <div class="p3-dr-body"><div class="p3-dr-in">
        <p>The app queried <span class="p3-mono">Patient360</span> through its SQL analytics endpoint, which reads the Epic tables, the PACS database and the documents lakehouse where they live. Files stream from OneLake through read-only links scoped to this patient.</p>
        <div class="p3-dr-l">One statement across Epic, the PACS and the documents</div>
        <pre class="p3-sql">${esc(L.sql)}</pre>
        <div class="p3-dr-l">Queries that join sources</div>${cross.map(row).join('')}
        ${GROUPS.map(([id, c, label, sys]) => `<div class="p3-dr-l"><i class="p3-sw p3-sw-${c}"></i>${label} <span>· ${sys}</span></div>${L.prov.filter((q) => q[1].length === 1 && q[1][0] === id).map(row).join('')}`).join('')}
        <div class="p3-dr-l">Signed file access (read-only, expires in 55 minutes)</div>
        ${['Patient360/Files/viewer', 'Bronze_ClinicalDocuments/Files', 'Bronze_ImagingArchive/Files/dicom'].map((x) => `<div class="p3-prov"><span class="p3-mono">${x}</span><span>read</span></div>`).join('')}
      </div></div></aside>`;
  }

  /* ---- Damian Macejkovic, a research patient: the diagnostic slide with its lymphocyte map, then the genome ---- */
  function researchPage() {
    const list = [['summary', 'Summary'], ['visits', 'Visits', 127], ['meas', 'Measurements', 65], ['cond', 'Conditions', 19], ['meds', 'Medications', 83], '|', ['cancer', 'Cancer course', 3], ['tx', 'Treatment', 3], '|',
      ['radiology', 'Radiology', 2], ['pathology', 'Pathology', 5], ['report', 'Report'], ['genomics', 'Genomics'], '|', ['board', 'Tumour board']];
    return `<section class="p3-page p3-pg-tcga">${rail('')}<div class="p3-main p3-scrollbox"><div class="p3-scroll">
      <div class="p3-head"><span class="p3-name">Damian Macejkovic</span><span class="p3-mono">TCGA-60-2722</span><span class="p3-badge">name is synthetic</span>
        <span class="p3-headline">Lung squamous cell carcinoma · stage IIB · 66 M · Alive, 2 years 6 months after diagnosis</span><u>Ask about this patient</u><span class="cd-top-gap"></span><span class="cd-btn">Key</span></div>
      ${section('Timeline', '<span class="p3-hide">Show</span>')}
      ${section('Details')}
      ${tabs(list)}
      <div class="p3-panes">
        <div class="p3-pane-tab" data-pane="pathology">
          <div class="p3-when"><span>22 Mar 2008 · age 66 · at diagnosis</span><span class="p3-mono">real, TCGA</span><span class="p3-mono"><i class="p3-sw p3-sw-path"></i>imaging_lakehouse: pathology_slide</span></div>
          <div class="p3-ptitle">Diagnostic slide, primary tumour</div>
          ${K.slideViewer('damian', 336)}
        </div>
        <div class="p3-pane-tab" data-pane="genomics">
          <div class="p3-when"><span>22 Mar 2008 · age 66 · at diagnosis</span><span class="p3-mono">real, TCGA</span><span class="p3-mono"><i class="p3-sw p3-sw-gen"></i>genomics_lakehouse: molecular_profile, somatic_mutation</span></div>
          ${K.genomeView('damian', 1150)}
        </div>
      </div>
    </div></div></section>`;
  }

  /* ---- Where the record is read, under the screen ---- */
  const part = (on, live, d = 0) => `data-on="${on}" data-live="${live}" style="--d:${d}s"`;
  const NODE_Y = 14, NODE_H = 58, NW = 232, LY = NODE_Y + NODE_H / 2;
  const NODES = [
    { x: 0, icon: 'rayfin.svg', name: 'Patient 360', sub: 'Rayfin app, in the browser', live: '0,1,2,3,4,5' },
    { x: 384, icon: 'functions.svg', name: 'Rayfin functions', sub: 'searchPatients, getPatient', live: '0,1,2,5' },
    { x: 768, icon: 'lakehouse.svg', name: 'Patient360', sub: 'SQL analytics endpoint', live: '0,1,2,5' },
  ];
  // [icon, name, sub, live steps] in the OneLake band
  const ITEMS = [['lakehouse.svg', 'Bronze_Clarity', 'Epic Clarity tables', '0,1,2'], ['databases.svg', 'Bronze_PACS', 'Fabric SQL database', '0,1,2,3'],
    ['lakehouse.svg', 'Bronze_Clinical­Documents', 'Reports and notes', '0,1,2'], ['lakehouse.svg', 'Patient360', 'Index, viewer files', '0,2,3,4'], ['lakehouse.svg', 'Bronze_Oncology_*', 'TCGA research data', '5']];
  const BAND = [150, 238], IW = 186, IG = 9, IY = 176, SY = 100, RY = 126;
  function flowMap() {
    const nodes = NODES.map((n) => `<g class="dv-node is-on" ${part(0, n.live)} transform="translate(${n.x} ${NODE_Y})"><rect x="0.75" y="0.75" width="${NW - 1.5}" height="${NODE_H - 1.5}" rx="4"/>${image(n.icon, 14, 14, 30)}
      <text class="u-name dv-node-name" x="54" y="26">${esc(n.name)}</text><text class="u-meta" x="54" y="43">${esc(n.sub)}</text></g>`).join('');
    const arrow = (x1, x2, label, live) => `<g class="dv-lane is-on" ${part(0, live)}><line x1="${x1}" y1="${LY}" x2="${x2}" y2="${LY}" pathLength="1"/><path class="dv-head" d="M${x2 - 6} ${LY - 4}L${x2} ${LY}l-6 4"/>
      <text class="u-meta dv-lane-label" x="${(x1 + x2) / 2}" y="${LY - 8}" text-anchor="middle">${label}</text><g transform="translate(${x1 + 2} ${LY - 3.5})"><rect class="dv-pk" width="8" height="7" rx="1" style="--dx:${x2 - x1 - 14}px"/></g></g>`;
    const ix = (i) => 8 + i * (IW + IG);
    const items = ITEMS.map(([icon, name, sub, live], i) => `<g class="dv-item is-on" ${part(0, live)} transform="translate(${ix(i)} ${IY})"><rect x="0.5" y="0.5" width="${IW - 1}" height="44" rx="3"/>${image(icon, 10, 13, 18)}
      <text class="dv-iname" x="36" y="19">${esc(name.replace('­', ''))}</text><text class="u-meta" x="36" y="34">${esc(sub)}</text></g>`).join('');
    // The endpoint reads each item in place (three-part names); the browser reads viewer files with signed links
    const ex = NODES[2].x + NW / 2;
    const reads = [0, 1, 2, 3, 4].map((i) => {
      const live = ITEMS[i][3].split(',').filter((s) => ['0', '1', '2', '5'].includes(s)).join(',') || '-1';
      const tx = ix(i) + IW / 2 + 30;
      return `<g class="dv-lane is-on" ${part(0, live)}><path d="M${ex} ${NODE_Y + NODE_H + 2}V${RY - 6}Q${ex} ${RY} ${ex - 6} ${RY}H${tx + 6}Q${tx} ${RY} ${tx} ${RY + 6}V${IY - 2}" pathLength="1"/><path class="dv-head" d="M${tx - 4} ${IY - 8}L${tx} ${IY - 2}l4 -6"/></g>`;
    }).join('');
    const ax = NODES[0].x + 70;
    const signed = [3, 4].map((i) => {
      const tx = ix(i) + IW / 2 - 30, live = i === 3 ? '3,4' : '5';
      return `<g class="dv-lane dv-short is-on" ${part(0, live)}><path d="M${ax} ${NODE_Y + NODE_H + 2}V${SY - 6}Q${ax} ${SY} ${ax + 6} ${SY}H${tx - 6}Q${tx} ${SY} ${tx} ${SY + 6}V${IY - 2}"/><path class="dv-head" d="M${tx - 4} ${IY - 8}L${tx} ${IY - 2}l4 -6"/></g>`;
    }).join('');
    return `<svg class="u-svg dv-svg" viewBox="0 0 1000 ${BAND[1] + 4}" aria-hidden="true">
      <rect class="dv-band" x="0.75" y="${BAND[0]}" width="998.5" height="${BAND[1] - BAND[0]}" rx="6"/>
      ${legend(12, BAND[0], [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel')}
      ${reads}${signed}${nodes}${arrow(NW + 2, NODES[1].x - 2, 'calls', '0,1,2,5')}${arrow(NODES[1].x + NW + 2, NODES[2].x - 2, 'T-SQL', '0,1,2,5')}
      <text class="u-meta p3-fl-l" x="${ax + 10}" y="${SY - 6}">signed read-only links to files</text><text class="u-meta p3-fl-l" x="${ex + 10}" y="${NODE_Y + NODE_H + 18}">reads each source<tspan x="${ex + 10}" dy="13">where it is</tspan></text>
      ${items}
    </svg>`;
  }
  const flowHost = document.getElementById('ptFlow');
  flowHost.innerHTML = flowMap();
  const fsvg = flowHost.querySelector('svg');
  fitLegends(fsvg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(fsvg));
  const fparts = [...fsvg.querySelectorAll('[data-on]')];
  function setFlow(n) {
    fsvg.dataset.stage = String(n);
    fparts.forEach((el) => {
      const live = el.dataset.live ? el.dataset.live.split(',').map(Number) : [];
      el.classList.toggle('is-live', live.includes(n));
      el.classList.toggle('is-dim', n >= 0 && !live.includes(n));
    });
  }

  /* ---- Scenes ---- */
  const ledgerEl = document.getElementById('ptLedger');
  const LEDGER0 = { patients: '<b>–</b> patients', sources: '<b>–</b> sources', images: '<b>–</b> viewers' };
  const ledger = (c, key, html) => { c.guard(); setLedger(ledgerEl, key, html, c.animate); };
  let stage = null;
  const $ = (sel) => stage.querySelector(sel);
  const PATHS = { 'p3-pg-list': '', 'p3-pg-rec': 'p/Z1001228', 'p3-pg-tcga': 'p/TCGA-60-2722?tab=pathology' };
  const show = (page) => {
    stage.querySelectorAll('.p3-page').forEach((p) => p.classList.toggle('is-on', p.classList.contains(page)));
    $('.cd-url-text').textContent = `${HOST}/${PATHS[page]}`;
  };
  const tab = (root, id) => {
    root.querySelectorAll('.p3-tabs span').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
    root.querySelectorAll('.p3-pane-tab').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === id));
  };
  const wipe = (c, ms) => c.tween(ms, (p) => {
    $('.p3-wipe').setAttribute('width', String(TW * p));
    $('.p3-tl-edge').setAttribute('transform', `translate(${(X0 + (X1 - X0) * p).toFixed(1)} 0)`);
    $('.p3-tl-edge').style.opacity = p > 0 && p < 1 ? '1' : '0';
  }, (p) => p);
  const selectDate = (y) => {
    const g = $('.p3-sel');
    g.style.setProperty('--x', `${X(y).toFixed(1)}px`);
    g.querySelector('.p3-sel-t').textContent = dateLabel(y);
  };

  const SCENES = [
    // 1. The Patients page; Levi Hills is opened from the demo list
    async (c) => {
      setFlow(0); show('p3-pg-list');
      await c.wait(900);
      ledger(c, 'patients', '<b>3,554</b> patients, 27 in the demo');
      await c.wait(1500);
      const row = $('.p3-row-levi');
      await c.point(row.querySelector('b'), 900, 0.4);
      row.classList.add('is-hover');
      await c.wait(500);
      await c.click(row);
      c.hide();
    },
    // 2. The record: the lifetime timeline draws, then the summary
    async (c) => {
      setFlow(1); show('p3-pg-rec'); tab($('.p3-pg-rec'), 'summary');
      $('.p3-sel').classList.remove('is-on');
      await c.wait(600);
      await wipe(c, 2600);
      $('.p3-sel').classList.add('is-on');
      ledger(c, 'sources', '<b>4</b> sources');
    },
    // 3. Read in place: the drawer with the 15 queries
    async (c) => {
      setFlow(2);
      const link = $('.p3-rip');
      await c.point(link, 800);
      await c.click(link);
      c.hide();
      $('.p3-pg-rec').classList.add('is-drawer');
      ledger(c, 'sources', '<b>4</b> sources, 15 queries');
      await c.wait(2400);
      const body = $('.p3-dr-in');
      await c.scroll(body, 330, 2600);
    },
    // 4. The CT from the timeline: the viewer opens on the largest nodule, then Go to the 13.0 mm one
    async (c) => {
      setFlow(3);
      const rec = $('.p3-pg-rec');
      rec.classList.remove('is-drawer');
      await c.wait(c.animate ? 500 : 0);
      const mark = $('.p3-ctmark');
      await c.point(mark, 800);
      await c.click(mark);
      c.hide();
      selectDate(2019.882);
      tab(rec, 'radiology');
      K.ctSet(rec, 'n1');
      ledger(c, 'images', '<b>1</b> CT, 10 nodules outlined');
      await c.wait(500);
      const box = $('.p3-pg-rec .p3-scrollbox');
      await c.scroll($('.p3-pg-rec .p3-scroll'), c.top(box, $('.p3-pg-rec .p3-tabs')) - 4, 1100);
      await c.wait(1300);
      await K.ctScroll(c, rec, [1, 2, 1, 0]);
      const go = $('.p3-pg-rec .p3-nod[data-n="6"] .p3-goto');
      await c.point(go, 800);
      await c.click(go);
      c.hide();
      await K.ctGoto(c, rec, 'n6');
    },
    // 5. The biopsy slide: fitted, then zoomed to 20× over the tumour
    async (c) => {
      setFlow(4);
      const rec = $('.p3-pg-rec');
      const tabEl = rec.querySelector('.p3-tabs [data-tab="pathology"]');
      await c.point(tabEl, 700);
      await c.click(tabEl);
      c.hide();
      tab(rec, 'pathology');
      selectDate(2020.937);
      K.fit(rec);
      ledger(c, 'images', '<b>2</b> viewers, a CT and a slide');
      await c.wait(1500);
      const z = rec.querySelector('.p3-z[data-z="20"]');
      await c.point(z, 700);
      await c.click(z);
      c.hide();
      await K.zoomTo(c, rec, 20, 3000);
    },
    // 6. A research patient: the lymphocyte map on the diagnostic slide, then the tumour genome
    async (c) => {
      setFlow(5); show('p3-pg-tcga');
      const pg = $('.p3-pg-tcga');
      tab(pg, 'pathology');
      K.fit(pg);
      ledger(c, 'images', '<b>4</b> viewers, with a TCGA slide and genome');
      await c.wait(1100);
      const btn = pg.querySelector('.p3-tilbtn');
      await c.point(btn, 700);
      await c.click(btn);
      c.hide();
      btn.textContent = 'Hide AI lymphocyte map';
      pg.querySelector('.p3-sv').classList.add('is-til');
      await c.wait(1800);
      await K.zoomTo(c, pg, 10, 2200);
      await c.wait(1400);
      await c.point(btn, 600);
      await c.click(btn);
      c.hide();
      btn.textContent = 'Show AI lymphocyte map';
      pg.querySelector('.p3-sv').classList.remove('is-til');
      await c.wait(2000);
      const g = pg.querySelector('.p3-tabs [data-tab="genomics"]');
      await c.point(g, 700);
      await c.click(g);
      c.hide();
      tab(pg, 'genomics');
      pg.querySelector('.p3-gen').classList.add('is-drawn');
    },
  ];

  replica({
    card, view: document.getElementById('ptView'), W, H, stageClass: 'p3-stage', html: () => `<div class="cd-win p3-win">${appTop('rec')}<div class="p3-body">${patientsPage()}${recordPage()}${researchPage()}</div></div>`,
    scenes: SCENES, steps: STEPS, hold: HOLD,
    chips: document.getElementById('ptSteps'), playBtn: document.getElementById('ptPlay'), cap: document.getElementById('ptCap'),
    onStage: (el) => { stage = el; },
    onReset: () => {
      setFlow(-1);
      show('p3-pg-list');
      Object.entries(LEDGER0).forEach(([key, html]) => setLedger(ledgerEl, key, html, false));
    },
  });
})();
