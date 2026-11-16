/* 08 Research: Conversational insights. Fig 9 is a replica of Ask in Patient 360, replaying two answers GitHub Copilot
   gave in the app's evaluation (run 5, Claude Opus 5.5 at high thinking): the question, Copilot's steps in the order and
   at the times they ran (shown faster), the answer's text and its cards, drawn with the record's own viewers. The first
   question is about one patient, Levi Hills (his screening CT and the biopsy slide); the second compares two research
   patients' genomes, slides and treatment. Under it, a diagram of how an answer is made: the chat relay talks to
   Copilot, and every tool runs in the page through the same functions and signed links as the record. */
(function () {
  'use strict';

  const card = document.getElementById('akCard');
  if (!card || !window.FigKit || !window.P360Kit) return;
  const { esc, image, legend, fitLegends, setLedger, ui, replica } = window.FigKit;
  const K = window.P360Kit, D = K.D, [A1, A2] = D.ask;

  const W = 1280, H = 760;
  const HOST = 'contoso-patient360-centralus.webapp.fabricapps.net';
  const ME = 'researcher@contoso.com';

  const STEPS = [
    { chip: 'Ask', label: 'Step 1 of 6',
      text: 'Ask is a conversation with GitHub Copilot about one patient, several, or all of them, on the reader’s own Copilot plan. Suggested questions are grouped by who would ask them. A clinician picks the one about Levi Hills: show the nodules on his screening CT and the biopsy slide that confirmed his lung cancer.' },
    { chip: 'Steps', label: 'Step 2 of 6',
      text: 'Copilot finds the patient, reads his record and imaging list, and reads both reports, then opens the CT and the slide. Each step is a tool that runs in the page through the same functions as the record, and Copilot reads what it returns. The answer shows every step with its time: seven steps in 17 seconds.' },
    { chip: 'The answer', label: 'Step 3 of 6',
      text: 'The answer comes first, then the record’s own viewers as cards: the CT centred on the 16.2 mm nodule with the radiologists’ outlines, and the biopsy slide, each with a note under it from the reports. Both sit in the left lower lobe. Every fact names where it came from.' },
    { chip: 'Two patients', label: 'Step 4 of 6',
      text: 'The second question compares two research patients with lung cancer, Jettie Osinski and Damian Macejkovic, across their genomes, slides and treatment. Copilot takes nine steps in 23 seconds and opens five cards.' },
    { chip: 'Genomes', label: 'Step 5 of 6',
      text: 'Her adenocarcinoma has 67 mutations, 2.3 per megabase, with an EGFR exon 19 deletion. His squamous tumour has 285, about four times the burden, with TP53, FBXW7 and KEAP1 mutations and the 3q gain that carries SOX2 and TP63. Each genome is set against the TCGA tumours of the same type.' },
    { chip: 'Slides and treatment', label: 'Step 6 of 6',
      text: 'On the AI lymphocyte maps, 6.5% of her tissue and 16.9% of his is lymphocyte-rich. Aligned at diagnosis, both had a platinum doublet first; at recurrence she had erlotinib, which matches her EGFR deletion, and he had radiation. The answer ends by leaving treatment decisions to the treating team.' },
  ];
  const HOLD = [6200, 9400, 11500, 8000, 9500];

  /* ---- The page ---- */
  const appTop = `<div class="cd-url"><span class="cd-url-text">${HOST}/ask</span><span class="cd-url-note">Patient 360, a Rayfin app on Fabric</span></div>
    <header class="p3-top"><span class="cd-mark"></span><span class="p3-brand">Patient 360</span>
      <nav class="p3-nav-tabs"><span>Patients</span><span class="on">Ask</span><span>Where the data lives</span><span>Sources</span></nav>
      <span class="cd-top-gap"></span><span class="cd-mono cd-who">MedicalCohortDemo</span><span class="cd-who">${ME}</span><span class="cd-who">Sign out</span>${ui.themeSeg}</header>`;
  const ROLES = ['Oncology', 'Radiology', 'Pathology', 'Primary care', 'Research', 'Data'];
  const STARTERS = [
    ["Walk me through Stephan Rutherford's two cancers on one timeline: diagnosis, pathology, treatment and outcome.", 'Lifetime timeline, both slides and the treatment courses'],
    [A1.q, 'From screening CT to the pathology slide'],
    ['Line up the lung cancer patients in the demo at their diagnosis. What imaging and treatment did each have before and after?', 'Several patients on one timeline, aligned on diagnosis'],
    ['Cassie Heidenreich had breast cancer in 1993 and colon cancer in 2018. Draft a tumour board note that covers both.', 'A note drafted from the record, added only if you choose'],
    ['Compare the treatment of Betty Feeney and Karly Lakin for breast cancer, and what imaging each had afterwards.', 'Two patients, cancer course and imaging'],
  ];
  function page() {
    return `<div class="p3a-body"><div class="p3a-scroll">
      <div class="p3a-hero"><div class="p3-eyebrow">Patient 360</div><h1 class="p3-h1">Ask</h1>
        <p class="p3-lede">Ask GitHub Copilot about one patient, several together, or all 3,554. Copilot reads each record where it lives (Epic Clarity, the PACS database, the documents lakehouse and the oncology research silos) and answers with the record's own views: timelines, results over time, scans with the radiologists' outlines, slides, reports and tumour genomes. Each answer shows the steps it took.</p>
        <div class="p3a-who"><span>Copilot runs as</span><b>SanjayNarendran</b></div></div>
      <div class="p3a-cols">
        <aside class="p3a-chats"><div class="p3a-chats-h">Your chats</div><div class="cd-btn p3a-new">+ New chat</div><div class="p3a-find">Search chats and patients</div>
          <div class="p3a-chat p3a-c1">Levi Hills had a screening CT…</div><div class="p3a-chat p3a-c2">Compare Jettie Osinski's EGFR…</div></aside>
        <div class="p3a-main">
          <div class="p3a-start"><div class="p3a-roles"><span class="p3a-rl">Questions a clinician or researcher might ask</span>${ui.seg(ROLES, 0)}</div>
            <div class="p3a-cards">${STARTERS.map(([q, why], i) => `<div class="p3a-st${i === 1 ? ' p3a-pick' : ''}"><span>${esc(q)}</span><small>${esc(why)}</small><i>→</i></div>`).join('')}</div></div>
          <div class="p3a-conv">${turn(1, A1)}${turn(2, A2)}</div>
        </div>
      </div>
    </div></div>
    <div class="p3a-dock"><div class="p3a-pts"><span>No patients added</span><span class="p3a-add">Add a patient by name or ID</span><span class="cd-top-gap"></span><span class="p3a-pick">Model <b>Claude Opus 5.5</b></span><span class="p3a-pick">Thinking <b>High</b></span><u>Suggested questions</u></div>
      <div class="p3a-box">${ui.field('p3a-input', 'Ask about one patient, several, or all of them')}<span class="cd-btn cd-btn-primary p3a-send">Ask</span></div>
      <p class="p3a-fine">For demonstration, education and research only. Every patient is synthetic or a public, de-identified research case. Copilot describes what the record shows; clinical decisions belong to the treating team.</p></div>`;
  }

  /* ---- One turn: the question, Copilot's steps, the answer with its cards ---- */
  const paras = (t) => t.trim().split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join('');
  function turn(n, a) {
    // The text before the first card: progress notes written while working (shown as steps), then the opening
    const first = a.parts[0].trim().split(/\n\n+/), lead = first.pop(), notes = first;
    const steps = [];
    a.steps.forEach(([t0, label, title, secs], i) => {
      if (notes.length && n === 2 && (i === 0 || i === 4)) steps.push([t0 - 0.4, 'Wrote', notes.shift()]);
      steps.push([t0, label, title, secs]);
    });
    const cards = [];
    for (let i = 1; i < a.parts.length; i += 2) {
      const tag = a.parts[i], text = a.parts[i + 1];
      if (tag === 'summary') cards.push(`<div class="p3a-sum p3a-part">${paras(text)}</div>`);
      else { const k = Number(tag.split(' ')[1]) - 1; cards.push(`<div class="p3a-card p3a-part" data-card="${n}-${k + 1}"><div class="p3a-ct">${esc(a.figs[k])}</div>${view(n, k)}<div class="p3a-note">${paras(text)}</div></div>`); }
    }
    return `<div class="p3a-turn" data-turn="${n}">
      <div class="p3a-q"><span>${esc(a.q)}</span></div>
      <div class="p3a-meta"><b>GitHub Copilot</b><span class="p3a-phase">Thinking</span><span class="p3a-tog">${esc(a.stepsText)} <i>⌃</i></span></div>
      <ol class="p3a-steps">${steps.map(([t0, label, title], i) => `<li data-t="${t0}"><i></i><b>${esc(label)}</b><span>${esc(title)}</span><small>under 1 s</small></li>`).join('')}</ol>
      <div class="p3a-lead p3a-part"><p>${esc(lead)}</p></div>
      ${cards.join('')}
    </div>`;
  }
  // The cards: the CT and the slide for the first question; two genomes, two slides and a timeline for the second
  function view(n, k) {
    if (n === 1) return k === 0 ? K.ctViewer(300, { foot: false }) : K.slideViewer('levi', 280, { foot: false });
    if (k < 2) return K.genomeView(k === 0 ? 'jettie' : 'damian', 966, { drivers: true });
    if (k < 4) return K.slideViewer(k === 2 ? 'jettie' : 'damian', 300, { foot: false });
    return K.alignedTimeline(966);
  }

  /* ---- How an answer is made, under the screen ---- */
  const part = (live) => `data-live="${live}"`;
  const NY = 14, NH = 58, NW = 250;
  const NODES = [
    { x: 0, icon: 'rayfin.svg', name: 'Ask, in Patient 360', sub: 'Rayfin app, in the browser' },
    { x: 375, icon: 'container-apps.svg', name: 'patient360-chat', sub: 'Container App, Copilot SDK' },
    { x: 750, icon: 'github-copilot.svg', name: 'GitHub Copilot', sub: 'The reader’s plan, Claude Opus 5.5', mono: true },
  ];
  const ITEMS = [['lakehouse.svg', 'Bronze_Clarity'], ['databases.svg', 'Bronze_PACS'], ['lakehouse.svg', 'Bronze_ClinicalDocuments'], ['lakehouse.svg', 'Patient360'], ['lakehouse.svg', 'Bronze_Oncology_*']];
  const BAND = [146, 210];
  function flowMap() {
    const nodes = NODES.map((n) => `<g class="dv-node is-on" transform="translate(${n.x} ${NY})"><rect x="0.75" y="0.75" width="${NW - 1.5}" height="${NH - 1.5}" rx="4"/>${image(n.icon, 14, 14, 30).replace('<image', `<image class="${n.mono ? 'p3-mono-ico' : ''}"`)}
      <text class="u-name dv-node-name" x="54" y="26">${esc(n.name)}</text><text class="u-meta" x="54" y="43">${esc(n.sub)}</text></g>`).join('');
    // Two lanes between each pair: to the right on top, back to the left below
    const lane = (x1, x2, y, label, live, back) => {
      const [a, b] = back ? [x2, x1] : [x1, x2], dir = back ? 1 : -1;
      return `<g class="dv-lane is-on" ${part(live)}><line x1="${a}" y1="${y}" x2="${b}" y2="${y}" pathLength="1"/><path class="dv-head" d="M${b + dir * 6} ${y - 4}L${b} ${y}l${dir * 6} 4"/>
        <text class="u-meta dv-lane-label" x="${(x1 + x2) / 2}" y="${back ? y + 15 : y - 7}" text-anchor="middle">${label}</text>
        <g transform="translate(${a + (back ? -10 : 2)} ${y - 3.5})"><rect class="dv-pk" width="8" height="7" rx="1" style="--dx:${(b - a) + (back ? 12 : -14)}px"/></g></g>`;
    };
    const y1 = NY + 20, y2 = NY + 40;
    const lanes = lane(NW + 2, NODES[1].x - 2, y1, 'question, tool result', '0,1,3,4', false) + lane(NODES[1].x + NW + 2, NODES[2].x - 2, y1, 'question, tool result', '0,1,3,4', false)
      + lane(NW + 2, NODES[1].x - 2, y2, 'tool request, answer', '1,2,4,5', true) + lane(NODES[1].x + NW + 2, NODES[2].x - 2, y2, 'tool call, answer', '1,2,4,5', true);
    const iw = 188, ix = (i) => 8 + i * (iw + 10), iy = BAND[0] + 18;
    const items = ITEMS.map(([icon, name], i) => `<g class="dv-item is-on" data-live="${i === 4 ? '4' : i === 3 ? '1,4' : '1'}" transform="translate(${ix(i)} ${iy})"><rect x="0.5" y="0.5" width="${iw - 1}" height="32" rx="3"/>${image(icon, 9, 7, 18)}<text class="dv-iname" x="34" y="20">${esc(name)}</text></g>`).join('');
    const tx = 70;
    const tools = `<g class="dv-lane is-on" ${part('1,4')}><path d="M${tx} ${NY + NH + 2}V${BAND[0] - 2}" pathLength="1"/><path class="dv-head" d="M${tx - 4} ${BAND[0] - 8}L${tx} ${BAND[0] - 2}l4 -6"/></g>
      <text class="u-meta p3-fl-l" x="${tx + 10}" y="${NY + NH + 26}">the page runs each tool through the record’s functions and signed links</text>`;
    return `<svg class="u-svg dv-svg p3-flow" viewBox="0 0 1000 ${BAND[1] + 4}" aria-hidden="true">
      ${lanes}${nodes}${tools}
      <rect class="dv-band" x="0.75" y="${BAND[0]}" width="998.5" height="${BAND[1] - BAND[0]}" rx="6"/>
      ${legend(12, BAND[0], [['icon', 'onelake.svg', 18, 6], ['text', 'OneLake', 5, 0]], 'u-legend-panel')}${items}
    </svg>`;
  }
  const flowHost = document.getElementById('akFlow');
  flowHost.innerHTML = flowMap();
  const fsvg = flowHost.querySelector('svg');
  fitLegends(fsvg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitLegends(fsvg));
  const fparts = [...fsvg.querySelectorAll('[data-live]')];
  function setFlow(n) {
    fparts.forEach((el) => {
      const live = el.dataset.live.split(',').map(Number);
      el.classList.toggle('is-live', live.includes(n));
      el.classList.toggle('is-dim', n >= 0 && !live.includes(n));
    });
  }

  /* ---- Scenes ---- */
  const ledgerEl = document.getElementById('akLedger');
  const LEDGER0 = { questions: '<b>–</b> questions', steps: '<b>–</b> steps', cards: '<b>–</b> cards' };
  const ledger = (c, key, html) => { c.guard(); setLedger(ledgerEl, key, html, c.animate); };
  let stage = null, y = 0;
  const $ = (sel) => stage.querySelector(sel);
  async function scrollTo(c, el, ms = 900, margin = 18) {
    const box = $('.p3a-body'), sc = $('.p3a-scroll');
    y = Math.max(0, y + c.top(box, el) - margin);
    await move(c, sc, ms);
  }
  // Your chats stays 16px below the top while the conversation scrolls, like the app's sticky sidebar
  async function move(c, sc, ms) {
    const side = $('.p3a-chats');
    side.style.transitionDuration = c.animate ? `${ms}ms` : '0ms';
    side.style.transform = `translateY(${Math.max(0, y + 16 - side.offsetTop)}px)`;
    await c.scroll(sc, y, ms);
  }
  // Scrolls so the end of what has been written sits above the dock
  async function follow(c, el, ms = 800) {
    const box = $('.p3a-body'), bottom = c.top(box, el) + el.offsetHeight;
    const room = box.offsetHeight - 24;
    if (bottom > room) { y += bottom - room; await move(c, $('.p3a-scroll'), ms); }
  }
  const PHASE = { 'Searched the patients': 'Searching the patients', 'Read the record': 'Reading the record', 'Listed the imaging': 'Reading the imaging', 'Read a document': 'Reading a document',
    'Opened a scan': 'Opening a scan', 'Opened a slide': 'Opening a slide', 'Opened the tumour genome': 'Opening the tumour genome', 'Drew a timeline': 'Drawing a timeline', Wrote: 'Writing' };
  // Copilot's steps appear in the order and at the times they ran, shown at the given speed
  async function runSteps(c, t, speed) {
    const items = [...t.querySelectorAll('.p3a-steps li')], phase = t.querySelector('.p3a-phase');
    t.classList.add('is-running');
    let at = 0;
    for (const li of items) {
      const t0 = Number(li.dataset.t);
      await c.wait(Math.max(120, (t0 - at) * 1000 * speed));
      at = t0;
      phase.textContent = PHASE[li.querySelector('b').textContent] || 'Working';
      li.classList.add('is-on');
      await c.follow(li);
    }
    phase.textContent = 'Writing the answer';
  }
  async function ask(c, n) {
    const t = $(`.p3a-turn[data-turn="${n}"]`);
    t.classList.add('is-on');
    $('.p3a-main').classList.add('is-conv');
    $(`.p3a-c${n}`).classList.add('is-on');
    return t;
  }
  function finish(c, t) {
    c.guard();
    t.classList.remove('is-running');
    t.classList.add('is-done');
  }
  async function showPart(c, el, after = 600) {
    c.guard();
    el.classList.add('is-on');
    if (el.querySelector('.p3-sv')) K.fit(el);
    if (el.querySelector('.p3-ct')) K.ctSet(el, 'n1');
    if (el.querySelector('.p3-gen')) setTimeout(() => el.querySelector('.p3-gen').classList.add('is-drawn'), c.animate ? 80 : 0);
    if (!c.animate) el.querySelector('.p3-gen')?.classList.add('is-drawn');
    await c.wait(after);
  }

  const SCENES = [
    // 1. The Ask page; the question about Levi Hills is picked from the suggestions
    async (c) => {
      y = 0; setFlow(-1);
      c.follow = (el) => follow(c, el, 500);
      await c.wait(1400);
      const pick = $('.p3a-pick');
      await c.point(pick, 1000, 0.35);
      pick.classList.add('is-hover');
      await c.wait(400);
      await c.click(pick);
      c.hide();
      setFlow(0);
      const t = await ask(c, 1);
      ledger(c, 'questions', '<b>1</b> question');
      await scrollTo(c, t, 1000, 14);
    },
    // 2. Copilot's steps, as they ran
    async (c) => {
      setFlow(1);
      c.follow = (el) => follow(c, el, 400);
      const t = $('.p3a-turn[data-turn="1"]');
      await runSteps(c, t, 0.42);
      ledger(c, 'steps', '<b>7</b> steps in 17 s');
    },
    // 3. The answer: the opening, the CT card, the slide card zoomed in, the closing
    async (c) => {
      setFlow(2);
      const t = $('.p3a-turn[data-turn="1"]');
      finish(c, t);
      const parts = [...t.querySelectorAll('.p3a-part')];
      await showPart(c, parts[0], 500);
      await scrollTo(c, parts[0], 700, 70);
      await showPart(c, parts[1], 1400);
      ledger(c, 'cards', '<b>2</b> cards');
      await scrollTo(c, parts[1], 900, 10);
      await c.wait(900);
      await K.ctScroll(c, parts[1], [1, 2, 1, 0]);
      await showPart(c, parts[2], 500);
      await scrollTo(c, parts[2], 1000, 10);
      await K.zoomTo(c, parts[2], 20, 2600);
      await showPart(c, parts[3], 400);
      await follow(c, parts[3], 800);
    },
    // 4. The second question, typed: two research patients compared
    async (c) => {
      setFlow(3);
      c.follow = (el) => follow(c, el, 300);
      const box = $('.p3a-input');
      await c.point(box, 800, 0.3);
      await c.click(box);
      c.hide();
      await c.type(box, A2.q, 90);
      await c.wait(300);
      const send = $('.p3a-send');
      await c.point(send, 500);
      await c.click(send);
      c.hide();
      box.querySelector('.cd-typed').textContent = '';
      box.classList.remove('has-text');
      const t = await ask(c, 2);
      ledger(c, 'questions', '<b>2</b> questions');
      await scrollTo(c, t, 900, 14);
      setFlow(4);
      await runSteps(c, t, 0.16);
      ledger(c, 'steps', '<b>16</b> steps in 40 s');
    },
    // 5. The answer opens; the two genomes are drawn
    async (c) => {
      setFlow(5);
      const t = $('.p3a-turn[data-turn="2"]');
      finish(c, t);
      const parts = [...t.querySelectorAll('.p3a-part')];
      await showPart(c, parts[0], 500);
      await scrollTo(c, parts[0], 700, 70);
      await showPart(c, parts[1], 500);
      ledger(c, 'cards', '<b>3</b> cards');
      await scrollTo(c, parts[1], 900, 10);
      await c.wait(2600);
      await showPart(c, parts[2], 400);
      ledger(c, 'cards', '<b>4</b> cards');
      await scrollTo(c, parts[2], 1200, 10);
    },
    // 6. The two slides with their lymphocyte maps, the treatment timeline, the closing
    async (c) => {
      setFlow(5);
      const t = $('.p3a-turn[data-turn="2"]');
      const parts = [...t.querySelectorAll('.p3a-part')];
      for (const i of [3, 4]) {
        await showPart(c, parts[i], 300);
        await scrollTo(c, parts[i], 1000, 10);
        parts[i].querySelector('.p3-tilbtn').textContent = 'Hide AI lymphocyte map';
        parts[i].querySelector('.p3-sv').classList.add('is-til');
        ledger(c, 'cards', `<b>${i + 2}</b> cards`);
        await c.wait(1600);
      }
      await showPart(c, parts[5], 600);
      ledger(c, 'cards', '<b>7</b> cards');
      await scrollTo(c, parts[5], 1000, 10);
      await showPart(c, parts[6], 400);
      await follow(c, parts[6], 800);
    },
  ];

  replica({
    card, view: document.getElementById('akView'), W, H, stageClass: 'p3a-stage', html: () => `<div class="cd-win p3-win">${appTop}<div class="p3-body p3a">${page()}</div></div>`,
    scenes: SCENES, steps: STEPS, hold: HOLD,
    chips: document.getElementById('akSteps'), playBtn: document.getElementById('akPlay'), cap: document.getElementById('akCap'),
    onStage: (el) => { stage = el; },
    onReset: () => {
      y = 0;
      setFlow(-1);
      Object.entries(LEDGER0).forEach(([key, html]) => setLedger(ledgerEl, key, html, false));
    },
  });
})();
