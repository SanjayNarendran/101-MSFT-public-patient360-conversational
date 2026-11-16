/* 02 Medallion architecture. Fig 3 starts with the OneLake box of section 01: as the figure scrolls into view the box
   slides down into it, in step with the scroll, and lands as the Bronze layer. The steps then show the enrichment of
   the imaging data in Bronze, the Silver layer in OMOP and the Gold layer in i2b2, and end with the study question
   answered in both. The SVG is drawn from the data below; CSS does the motion, keyed off the stage classes set here
   (data-stage, ge1-ge4 for "this step or later", is-arriving / is-landed for the box). */
(function () {
  'use strict';

  const card = document.getElementById('medCard');
  if (!card || !window.FigKit) return;
  const { reduceMotion, esc, image, pill, legend, fitLegends, LAKE, LAKE_ITEMS, stepper } = window.FigKit;
  const { VB_W, ITEM_X, ITEM_W, ITEM_H, PANEL_W, TOP, BOTTOM, BOX_H, ROW_Y } = LAKE;

  // Geometry, in viewBox units: Bronze is the OneLake box exactly as Fig 1 draws it, then Silver and Gold to its right,
  // all three the same height. The enrichment panel uses the space Silver and Gold take later.
  const SIL_X = 406, SIL_R = 676, GOLD_X = 736, GOLD_R = VB_W, ENR_X = 480;
  const VB_H = BOTTOM + 58;
  const DROP = BOTTOM + 40; // where the box starts: this far above its place, out of sight above the figure
  const ROW = (i) => 116 + i * 18.5; // Silver's table rows

  // Enrichment: the meta line two Bronze items get, and one lane of the enrichment panel per Bronze row 0-2
  const ENRICHED = { 1: '2,651 nodule findings added', 2: 'Headers carry Epic IDs' };
  const ENRICH = [
    { title: 'Epic identifiers', text: 'MRN, name and accession number of each imaging order, read from Bronze_Clarity' },
    { title: '2,651 nodule findings added to the PACS', text: 'Diameter, volume, lobe and malignancy score of each nodule the radiologists marked' },
    { title: '262,171 DICOM headers rewritten with the Epic identifiers', text: 'The nodule annotations are read from the same archive (DICOM SR and SEG)' },
    { title: 'Clinical documents', text: 'Each document already carries the MRN and accession number of its order' },
  ];
  // Silver_OMOP tables (rows from the build); q = used by the study question, key = the protected i2b2 ID mapping
  const OMOP = [['person', '3,539', 'q'], ['visit_occurrence', '286,647'], ['condition_occurrence', '112,412'],
    ['drug_exposure', '371,774'], ['procedure_occurrence', '119,031'], ['measurement', '1,384,071', 'q'],
    ['observation', '61,257', 'q'], ['note', '17,910'], ['image_occurrence', '28,179'], ['concept_ancestor', '70,186,504'],
    ['i2b2_patient_mapping', '7,078', 'key']];
  // One diagnosis code on its way to a standard concept and up the hierarchy (R91.1: 717 records in this demo)
  const MAP = [['ICD-10-CM', 'R91.1', 'Solitary pulmonary nodule'], ['SNOMED', '427359005, concept 4142875', 'Solitary nodule of lung'],
    ['SNOMED', '786838002', 'Nodule of lung']];
  const MAP_LINK = ['maps to', 'is a'];
  // Gold_i2b2 ontology folders with their patient counts
  const ONTOLOGY = [['Demographics', '3,539', 'q'], ['Visit Details', '3,539'], ['Diagnoses', '3,536'], ['Medications', '3,448'],
    ['Labs', '3,440'], ['Vital Signs and Assessments', '3,503', 'q'], ['Procedures', '3,523'], ['Imaging', '2,896', 'q'],
    ['Clinical Notes', '2,896'], ['Specimens', '709']];
  const COHORT = 358;

  const STEPS = [
    { chip: 'Bronze', label: 'Bronze',
      text: 'The OneLake box from section 01 is the Bronze layer. It holds the data as each source delivered it, in 62 tables and about 280,000 files. Silver and Gold are built from Bronze and can be rebuilt from it whenever a source changes.' },
    { chip: 'Enrichment', label: 'Step 1 of 4',
      text: 'Two things were added to the imaging data in Bronze. Every DICOM header was rewritten with the Epic MRN, name and accession number of its order, which links all 262,171 files to the EHR. The radiologists’ nodule annotations, stored in the archive as DICOM SR and SEG objects, were read into 2,651 nodule findings in the PACS.' },
    { chip: 'Silver', label: 'Step 2 of 4',
      text: 'The Silver_OMOP_Build notebook reshapes Bronze into the OMOP Common Data Model v5.4 and maps each Epic code to a standard concept. ICD-10-CM R91.1 becomes SNOMED “Solitary nodule of lung”, which the vocabulary files under “Nodule of lung”, so a search for lung nodules finds it. 99 to 100% of clinical records have a standard concept.' },
    { chip: 'Gold', label: 'Step 3 of 4',
      text: 'The Gold_i2b2_Build notebook turns OMOP into an i2b2 star schema, with 2,221,427 facts in observation_fact and an ontology of 1,534 nodes that each carry a patient count. Patients get random numbers in Gold, and the mapping back to their Epic IDs stays in Silver.' },
    { chip: 'Cohort check', label: 'Step 4 of 4',
      text: 'The study question, former smokers aged 50 or over with a CT nodule of at least 6 mm, finds 358 patients in OMOP and 358 in i2b2. In OMOP it reads the person, observation and measurement tables, and in i2b2 the Demographics, Vital Signs and Assessments, and Imaging folders. Section 03 is about the semantic model on these layers.' },
  ];
  // How long each step holds while playing, in ms; the last one stays
  const HOLD = [3400, 8000, 8500, 8500];

  const lock = (x, y) => `<g class="m-lock" transform="translate(${x} ${y})"><rect x="0" y="3.5" width="8" height="6" rx="1"/><path d="M1.9 3.5V2.3a2.1 2.1 0 0 1 4.2 0v1.2"/></g>`;
  const folder = (x, y) => `<path class="m-folder" d="M${x} ${y - 7}h3.6l1.2 1.4h4.7v6.1h-9.5z"/>`;
  // A moving mark on a lane: the outer group places it, the inner one moves (a CSS transform would replace the
  // transform attribute)
  const mark = (x, y, d, delay, body) => `<g transform="translate(${x} ${y})"><g class="m-pk" style="--d:${d}px;animation-delay:${delay}s">${body}</g></g>`;
  const chipMark = (t) => `<rect class="m-pk-chip" width="${t.length * 5.6 + 8}" height="12" rx="2"/><text class="m-pk-text" x="${(t.length * 5.6 + 8) / 2}" y="8.6" text-anchor="middle">${t}</text>`;
  const rowMark = '<rect class="m-pk-row" width="12" height="9" rx="1.5"/><path class="m-pk-lines" d="M2.5 3h7M2.5 6h7"/>';
  const arrowR = (x1, x2, y, cls) => `<line class="${cls}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><path class="${cls}-head" d="M${x2 - 7} ${y - 4.5}L${x2} ${y}l-7 4.5"/>`;
  const arrowL = (x1, x2, y, cls) => `<line class="${cls}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><path class="${cls}-head" d="M${x2 + 7} ${y - 4.5}L${x2} ${y}l7 4.5"/>`;

  /* ---- Drawing ---- */
  function bronzeItem(d, i) {
    const meta = ENRICHED[i]
      ? `<g class="m-fa"><text class="u-meta" x="44" y="24">${esc(d.meta)}</text></g><g class="m-fb"><text class="u-meta m-new" x="44" y="24">${esc(ENRICHED[i])}</text></g>`
      : `<text class="u-meta" x="44" y="24">${esc(d.meta)}</text>`;
    return `<g class="m-bitem" data-row="${i}" transform="translate(${ITEM_X} ${ROW_Y[i]})">
      <rect class="m-item" x="0.5" y="${-ITEM_H / 2 + 0.5}" width="${ITEM_W - 1}" height="${ITEM_H - 1}" rx="3"/>
      ${image(d.icon, 12, -26, 22)}
      <text class="u-name u-dest-name" x="44" y="-11">${esc(d.name)}</text>
      <text class="u-sub" x="44" y="7">${esc(d.sub)}</text>
      ${meta}${pill(d.badges[d.badges.length - 1], ITEM_W - 10, 12)}
    </g>`;
  }
  // The box from Fig 1. "OneLake" in its top line gives way to "Bronze" once it lands, and its green to bronze.
  const bronze = () => `<g clip-path="url(#medClip)"><g class="m-drop"${reduceMotion ? '' : ` style="transform:translateY(${-DROP}px)"`}>
      <rect class="m-box m-box-b" x="0.75" y="${TOP}" width="${PANEL_W - 1.5}" height="${BOX_H}" rx="6"/>
      ${legend(12, TOP, [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel m-lg-lake')}
      ${legend(12, TOP, [['swatch', 'm-sw m-sw-b', 10, 7], ['text', 'Bronze', 5, 0]], 'u-legend-panel m-lg-layer')}
      ${LAKE_ITEMS.map(bronzeItem).join('')}
    </g></g>`;

  const slots = () => [[0.75, PANEL_W - 1.5, 'Bronze', 'b'], [SIL_X + 0.75, SIL_R - SIL_X - 1.5, 'Silver', 's'], [GOLD_X + 0.75, GOLD_R - GOLD_X - 1.5, 'Gold', 'g']]
    .map(([x, w, name, k]) => `<g class="m-slot m-slot-${k}"><rect x="${x}" y="${TOP}" width="${w}" height="${BOX_H}" rx="6"/><text x="${x + w / 2}" y="${TOP + BOX_H / 2 + 4}" text-anchor="middle">${name}</text></g>`).join('');

  function enrichment() {
    const a = PANEL_W + 4, b = ENR_X - 4, run = b - a - 34;
    const lanes = [
      arrowR(a, b, ROW_Y[0], 'm-eline') + [0, -1.2].map((dl) => mark(a + 4, ROW_Y[0] - 6, run, dl, chipMark('MRN'))).join(''),
      arrowL(b, a, ROW_Y[1], 'm-eline') + [0, -1.2].map((dl) => mark(b - 16, ROW_Y[1] - 4.5, -run + 4, dl, rowMark)).join(''),
      arrowR(a, b, ROW_Y[2] - 7, 'm-eline') + arrowL(b, a, ROW_Y[2] + 7, 'm-eline')
        + [0, -1.2].map((dl) => mark(a + 4, ROW_Y[2] - 13, run + 6, dl, chipMark('SR'))).join('')
        + [-0.6, -1.8].map((dl) => mark(b - 22, ROW_Y[2] + 1, -run + 4, dl, chipMark('ID'))).join(''),
    ].join('');
    return `<g class="m-enrich">${lanes}
      <rect class="m-panel" x="${ENR_X}" y="${TOP}" width="${VB_W - ENR_X - 0.75}" height="${BOX_H}" rx="6"/>
      ${image('notebook.svg', ENR_X + 16, TOP + 18, 20)}
      <text class="u-name" x="${ENR_X + 44}" y="${TOP + 33}">Enrichment of the imaging data</text>
      ${ENRICH.map((e, i) => `<g class="m-erow" data-row="${i}"><text class="m-etitle" x="${ENR_X + 16}" y="${ROW_Y[i] - 3}">${esc(e.title)}</text>
        <text class="u-meta" x="${ENR_X + 16}" y="${ROW_Y[i] + 14}">${esc(e.text)}</text></g>`).join('')}
    </g>`;
  }

  // Lanes from one layer into the next, one per Bronze row, with records moving along them
  const flow = (x1, x2, k) => `<g class="m-flow m-flow-${k}">${ROW_Y.map((y, i) => arrowR(x1, x2, y, 'm-fline')
    + [0, -0.8].map((dl) => mark(x1 + 2, y - 3.5, x2 - x1 - 22, dl - i * 0.25, '<rect class="m-pk-dot" width="9" height="7" rx="1"/>')).join('')).join('')}</g>`;

  const layerHead = (x, r, sw, layerName, item, model, notebook) => `
      <rect class="m-box m-box-${sw}" x="${x + 0.75}" y="${TOP}" width="${r - x - 1.5}" height="${BOX_H}" rx="6"/>
      ${legend(x + 12, TOP, [['swatch', `m-sw m-sw-${sw}`, 10, 7], ['text', layerName, 5, 0]], 'u-legend-panel')}
      ${image('lakehouse.svg', x + 16, TOP + 26, 20)}
      <text class="u-name" x="${x + 44}" y="${TOP + 41}">${esc(item)}</text>
      <text class="u-sub" x="${x + 44}" y="${TOP + 58}">${esc(model)}</text>
      <text class="u-meta" x="${x + 44}" y="${TOP + 73}">Built by the ${esc(notebook)} notebook</text>
      <line class="m-rule" x1="${x + 16}" y1="${TOP + 86}" x2="${r - 16}" y2="${TOP + 86}"/>`;

  function silver() {
    const x = SIL_X + 16, r = SIL_R - 16;
    const rows = OMOP.map(([t, n, tag], i) => `<g class="m-trow${tag ? ` m-${tag}` : ''}" style="--i:${i}">
        ${tag === 'key' ? lock(x, ROW(i) - 8.5) : ''}<text class="m-tname" x="${tag === 'key' ? x + 13 : x}" y="${ROW(i)}">${esc(t)}</text>
        <text class="u-meta m-tnum" x="${r}" y="${ROW(i)}" text-anchor="end">${n}</text></g>`).join('');
    const cTop = 312, chipW = SIL_R - SIL_X - 48, chipY = [cTop + 26, cTop + 74, cTop + 122];
    const chips = MAP.map(([voc, code, name], i) => `<g class="m-map" style="--m:${i * 2}" transform="translate(${SIL_X + 24} ${chipY[i]})">
        <rect class="m-mchip" width="${chipW}" height="34" rx="3"/>
        <text class="m-mcode" x="10" y="14">${esc(voc)} ${esc(code)}</text>
        <text class="m-mname" x="10" y="28">${esc(name)}</text></g>`).join('');
    const links = MAP_LINK.map((l, i) => `<g class="m-map" style="--m:${i * 2 + 1}">
        <path class="m-mlink" d="M${SIL_X + 40} ${chipY[i] + 35}V${chipY[i + 1] - 1}"/><path class="m-mlink" d="M${SIL_X + 36.5} ${chipY[i + 1] - 5}l3.5 4 3.5-4"/>
        <text class="u-meta" x="${SIL_X + 50}" y="${chipY[i] + 44}">${l}</text></g>`).join('');
    return `<g class="m-layer m-silver">${layerHead(SIL_X, SIL_R, 's', 'Silver', 'Silver_OMOP', 'OMOP Common Data Model v5.4', 'Silver_OMOP_Build')}
      ${rows}
      <rect class="m-mcard" x="${SIL_X + 12}" y="${cTop}" width="${SIL_R - SIL_X - 24}" height="${BOTTOM - 12 - cTop}" rx="3"/>
      <text class="u-sub m-mtitle" x="${SIL_X + 24}" y="${cTop + 17}">A diagnosis code and its concept</text>
      ${chips}${links}
    </g>`;
  }

  function gold() {
    const x = GOLD_X + 16, r = GOLD_R - 16, cx = (GOLD_X + GOLD_R) / 2;
    // A small star: observation_fact in the middle, its dimensions around it
    const fact = { x: cx - 52, y: 128, w: 104, h: 36 };
    const dims = [['patient', x, 112, 'start'], ['visit', r, 112, 'end'], ['concept', x, 176, 'start'], ['provider', r, 176, 'end'], ['modifier', cx, 188, 'middle']]
      .map(([t, px, py, anchor]) => {
        const w = t.length * 5.8 + 10;
        const left = anchor === 'start' ? px : anchor === 'end' ? px - w : px - w / 2;
        return { t, left, w, y: py, cxp: left + w / 2 };
      });
    const spokes = dims.map((d) => `<line class="m-spoke" x1="${d.cxp}" y1="${d.y}" x2="${cx}" y2="${fact.y + fact.h / 2}"/>`).join('');
    const pills = dims.map((d, i) => `<g class="m-star" style="--i:${i + 1}" transform="translate(${d.left} ${d.y - 8})"><rect class="m-dim" width="${d.w}" height="15" rx="2"/><text class="m-dim-text" x="${d.w / 2}" y="10.6" text-anchor="middle">${d.t}</text></g>`).join('');
    const star = `<g class="m-star" style="--i:0">${spokes}<rect class="m-fact" x="${fact.x}" y="${fact.y}" width="${fact.w}" height="${fact.h}" rx="3"/>
        <text class="m-fact-name" x="${cx}" y="${fact.y + 15}" text-anchor="middle">observation_fact</text>
        <text class="u-meta" x="${cx}" y="${fact.y + 29}" text-anchor="middle">2,221,427 facts</text></g>${pills}`;
    const oy = (i) => 238 + i * 16.5;
    const tree = ONTOLOGY.map(([name, n, tag], i) => `<g class="m-orow${tag ? ` m-${tag}` : ''}" style="--i:${i}">${folder(x + 2, oy(i))}
        <text class="m-oname" x="${x + 16}" y="${oy(i)}">${esc(name)}</text><text class="u-meta m-tnum" x="${r}" y="${oy(i)}" text-anchor="end">${n}</text></g>`).join('');
    const nTop = 402;
    return `<g class="m-layer m-gold">${layerHead(GOLD_X, GOLD_R, 'g', 'Gold', 'Gold_i2b2', 'i2b2 star schema and ontology', 'Gold_i2b2_Build')}
      ${star}
      <text class="u-sub m-otitle" x="${x}" y="218">Ontology, 1,534 nodes in 10 folders</text>
      ${tree}
      <g class="m-keynote">
        <rect class="m-mcard" x="${GOLD_X + 12}" y="${nTop}" width="${GOLD_R - GOLD_X - 24}" height="${BOTTOM - 12 - nTop}" rx="3"/>
        ${lock(x, nTop + 12)}<text class="m-mcode" x="${x + 13}" y="${nTop + 21}">patient_num 57531609</text>
        <text class="u-meta" x="${x}" y="${nTop + 40}">Random numbers replace the Epic IDs.</text>
        <text class="u-meta" x="${x}" y="${nTop + 56}">The mapping stays in Silver.</text>
      </g>
    </g>`;
  }

  // The study question and its answer under each model
  function check() {
    const sx = (SIL_X + SIL_R) / 2, gx = (GOLD_X + GOLD_R) / 2, y = BOTTOM + 38;
    const answer = (cx, model) => `<path class="m-tick" d="M${cx} ${BOTTOM + 3}V${BOTTOM + 16}"/>
      <text x="${cx}" y="${y}" text-anchor="middle"><tspan class="m-count">${COHORT}</tspan><tspan class="u-meta" dx="6">patients in ${model}</tspan></text>`;
    return `<g class="m-check">
      <text class="u-meta" x="0" y="${BOTTOM + 22}">Study question</text>
      <text class="m-question" x="0" y="${BOTTOM + 40}">Former smokers aged 50+ with a CT nodule ≥ 6 mm</text>
      ${answer(sx, 'OMOP')}${answer(gx, 'i2b2')}
    </g>`;
  }

  function draw(host) {
    host.innerHTML = `<svg class="u-svg m-svg${reduceMotion ? ' is-landed' : ' is-arriving'}" viewBox="0 0 ${VB_W} ${VB_H}" aria-hidden="true">
      <defs><clipPath id="medClip"><rect x="-20" y="0" width="${VB_W + 40}" height="${VB_H + 20}"/></clipPath></defs>
      ${slots()}
      ${enrichment()}
      ${flow(PANEL_W + 4, SIL_X - 4, 's')}${silver()}
      ${flow(SIL_R + 4, GOLD_X - 4, 'g')}${gold()}
      ${check()}
      ${bronze()}
    </svg>`;
  }

  /* ---- Playing it ---- */
  const fig = document.getElementById('medFig');
  draw(fig);
  const svg = fig.querySelector('svg');
  fitLegends(svg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(svg));
  const drop = svg.querySelector('.m-drop');
  const counts = [...svg.querySelectorAll('.m-count')];

  let countRaf = 0;
  function countUp(animate) {
    cancelAnimationFrame(countRaf);
    if (!animate) { counts.forEach((c) => { c.textContent = String(COHORT); }); return; }
    const t0 = performance.now(), dur = 1100, delay = 500;
    const tick = (t) => {
      const k = Math.max(0, Math.min(1, (t - t0 - delay) / dur));
      const v = Math.round(COHORT * (1 - Math.pow(1 - k, 3)));
      counts.forEach((c) => { c.textContent = String(v); });
      if (k < 1) countRaf = requestAnimationFrame(tick);
    };
    countRaf = requestAnimationFrame(tick);
  }

  // The box lands once; until then it follows the scroll. Reading on (a chip, Play, an arrow key) lands it at once.
  let landed = reduceMotion, raf = 0, player = null;
  function land(glide) {
    if (landed) return;
    landed = true;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (glide) drop.classList.add('glide');
    drop.style.transform = '';
    svg.classList.remove('is-arriving');
    svg.classList.add('is-landed');
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  function progress() {
    const r = svg.getBoundingClientRect(), vh = innerHeight;
    if (!r.height) return 0;
    const from = vh * 0.92, to = vh * 0.3;
    return Math.max(0, Math.min(1, (from - r.top) / (from - to)));
  }
  function frame() {
    raf = 0;
    const p = progress();
    if (p >= 1) { land(true); player.start(); return; }
    drop.style.transform = `translateY(${(-(1 - smooth(p)) * DROP).toFixed(1)}px)`;
  }
  function onScroll() { if (!raf) raf = requestAnimationFrame(frame); }

  player = stepper({
    card, chips: document.getElementById('medSteps'), playBtn: document.getElementById('medPlay'),
    cap: document.getElementById('medCap'), ledger: document.getElementById('medLedger'),
    steps: STEPS, hold: HOLD, reducedStage: STEPS.length - 1, auto: false,
    onUser: () => land(true),
    render(n, animate) {
      svg.dataset.stage = String(n);
      for (let k = 1; k <= 4; k++) svg.classList.toggle(`ge${k}`, n >= k);
      if (n === 4) countUp(animate);
    },
    ledgerAt: (n) => ({
      bronze: '<b>62</b> tables',
      silver: n >= 2 ? '<b>32</b> OMOP tables' : '<b>0</b> OMOP tables',
      gold: n >= 3 ? '<b>2.2M</b> facts' : '<b>0</b> facts',
    }),
  });

  if (!reduceMotion) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    frame();
  }
})();
