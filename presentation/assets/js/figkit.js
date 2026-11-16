/* Shared parts of the section figures. SVG helpers; the OneLake box (Fig 1 in section 01 ends with it and Fig 3 in
   section 02 starts with it, so both draw it from the geometry and items here and it looks the same in both); and the
   step player behind each figure's chips, Play button, caption and ledger. */
(function () {
  'use strict';

  const ICON = 'assets/icons/';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Calls fn(true) when a figure comes on screen and fn(false) when it leaves. On screen means most of it shows, or, in
  // a window too short for that (a laptop, or a preview pane such as Teams'), it fills at least half the window.
  const SEEN_AT = Array.from({ length: 21 }, (_, i) => i / 20);
  function watch(el, fn) {
    let was = null;
    new IntersectionObserver((entries) => entries.forEach((en) => {
      const view = (en.rootBounds && en.rootBounds.height) || innerHeight;
      const seen = en.isIntersecting && (en.intersectionRatio >= 0.45 || en.intersectionRect.height >= view / 2);
      if (seen !== was) { was = seen; fn(seen); }
    }), { threshold: SEEN_AT }).observe(el);
  }

  const image = (file, x, y, s) => `<image href="${ICON}${file}" x="${x}" y="${y}" width="${s}" height="${s}"/>`;
  // A pill with mono caps (a format or a table type); the width follows the text
  const pill = (text, xEnd, y, cls = '') => {
    const w = Math.round(text.length * 6.1 + 12);
    return `<g transform="translate(${xEnd - w} ${y})"><g class="u-tag ${cls}"><rect width="${w}" height="16" rx="2"/><text x="${w / 2}" y="11.2" text-anchor="middle">${esc(text)}</text></g></g>`;
  };

  // A label set into a box's top line, as the Microsoft Fabric label is set into the frame at the top of the page. Two
  // rects hide the line under it: the upper one in the colour outside the box, the lower one in the colour inside.
  // Parts are icons, swatches and text laid out left to right; fitLegends() spaces them by their measured widths. With
  // `end`, x is where the label ends rather than where it starts.
  const legend = (x, y, parts, cls = '', end = false) => `<g class="u-legend ${cls}"${end ? ` data-end="${x}" data-y="${y}"` : ''} transform="translate(${end ? x - 160 : x} ${y})">
      <rect class="u-ko u-ko-out" x="0" y="-11" width="40" height="11"/><rect class="u-ko u-ko-in" x="0" y="0" width="40" height="11"/>
      ${parts.map(([kind, v, size, gap]) => kind === 'icon'
        ? `<image class="u-lg" data-gap="${gap}" href="${ICON}${v}" x="8" y="${-size / 2}" width="${size}" height="${size}"/>`
        : kind === 'swatch'
          ? `<rect class="u-lg ${v}" data-gap="${gap}" x="8" y="${-size / 2}" width="${size}" height="${size}" rx="2"/>`
          : `<text class="u-lg" data-gap="${gap}" x="8" y="${size}">${esc(v)}</text>`).join('')}
    </g>`;
  function fitLegends(root) {
    root.querySelectorAll('.u-legend').forEach((g) => {
      const parts = [...g.querySelectorAll('.u-lg')];
      const widths = parts.map((el) => (el.tagName === 'text' ? el.getComputedTextLength() : Number(el.getAttribute('width'))));
      if (!parts.length || widths.some((w) => !w)) return;
      let x = 8;
      parts.forEach((el, i) => { el.setAttribute('x', x.toFixed(1)); x += widths[i] + (i < parts.length - 1 ? Number(el.dataset.gap) : 0); });
      g.querySelectorAll('.u-ko').forEach((r) => r.setAttribute('width', (x + 8).toFixed(1)));
      if (g.dataset.end) g.setAttribute('transform', `translate(${(Number(g.dataset.end) - x - 8).toFixed(1)} ${g.dataset.y})`);
    });
  }

  // The OneLake box, in viewBox units of a 1000-wide figure. The items are centred across it (the same margin on both
  // sides; Fig 1's join bracket runs in the left one) and down it, ITEM_GAP apart.
  const LAKE = (() => {
    const JOIN_X = 16, ITEM_X = 32, ITEM_W = 282, ITEM_H = 72, TOP = 14, BOX_H = 476, ITEM_GAP = 28;
    const PAD_Y = (BOX_H - 4 * ITEM_H - 3 * ITEM_GAP) / 2;
    return {
      VB_W: 1000, JOIN_X, ITEM_X, ITEM_W, ITEM_H, PANEL_W: ITEM_X * 2 + ITEM_W, TOP, BOX_H, ITEM_GAP, BOTTOM: TOP + BOX_H,
      ROW_Y: [0, 1, 2, 3].map((i) => TOP + PAD_Y + ITEM_H / 2 + i * (ITEM_H + ITEM_GAP)),
    };
  })();
  // What the box holds once every source is connected: the four Bronze items
  const LAKE_ITEMS = [
    { icon: 'lakehouse.svg', name: 'Bronze_Clarity and Bronze_Caboodle', sub: 'One lakehouse per Epic database', meta: '54 tables in Delta format', badges: ['DELTA'] },
    { icon: 'databases.svg', name: 'Bronze_PACS', sub: 'Replica of the PACS database', meta: '6 tables in Delta format', badges: ['DELTA'] },
    { icon: 'lakehouse.svg', name: 'Bronze_ImagingArchive', sub: 'Files/dicom/study/series/…', meta: 'Shortcut to the archive', badges: ['FILES'] },
    { icon: 'lakehouse.svg', name: 'Bronze_ClinicalDocuments', sub: 'Files/radiology_reports/…', meta: 'and Tables/document_index', badges: ['FILES'] },
  ];

  /* ---- The step player ----
     Draws the chips, plays the steps (Play / Pause / Play again), keeps the caption at the height of its longest step,
     updates the ledger, and steps with ← → while the figure crosses the middle of the screen. The figure itself is
     drawn by `render(n, animate)`. With `auto`, it starts playing the first time the card is on screen (see watch);
     otherwise the figure calls start(). */
  const PLAY_ICONS = {
    play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor"/></svg>',
    replay: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.05-4.95M5 4.5V9h4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  function stepper({ card, chips, playBtn, cap, ledger, steps, hold, render, ledgerAt, reducedStage, auto = true, onUser }) {
    const LAST = steps.length - 1;
    chips.innerHTML = steps.map((s, i) => `<button type="button" class="chip" data-step="${i}" aria-pressed="false">${esc(s.chip)}</button>`).join('');
    const chipEls = [...chips.querySelectorAll('.chip')];
    const capHTML = (s) => `<span class="uni-cap-step">${esc(s.label)}</span><p>${esc(s.text)}</p>`;

    function holdCaption() {
      const probe = cap.cloneNode(false);
      probe.removeAttribute('id');
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;min-height:0;';
      probe.style.width = `${cap.getBoundingClientRect().width}px`;
      cap.parentNode.appendChild(probe);
      let h = 0;
      steps.forEach((s) => { probe.innerHTML = capHTML(s); h = Math.max(h, probe.offsetHeight); });
      probe.remove();
      cap.style.minHeight = `${Math.ceil(h)}px`;
    }

    let stage = -1, swap = 0;
    function setStage(n, animate = true) {
      n = Math.max(0, Math.min(LAST, n));
      if (n === stage) return;
      stage = n;
      const anim = animate && !reduceMotion;
      chipEls.forEach((c, i) => { const on = i === n; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
      render(n, anim);
      if (ledger && ledgerAt) {
        const vals = ledgerAt(n);
        ledger.querySelectorAll('[data-ledger]').forEach((d) => {
          const dd = d.querySelector('dd');
          const next = vals[d.dataset.ledger];
          if (next === undefined || dd.innerHTML === next) return;
          dd.innerHTML = next;
          d.classList.remove('bump'); void d.offsetWidth;
          if (anim) d.classList.add('bump');
        });
      }
      clearTimeout(swap);
      if (!anim) { cap.classList.remove('out'); cap.innerHTML = capHTML(steps[n]); return; }
      cap.classList.add('out');
      swap = setTimeout(() => { cap.innerHTML = capHTML(steps[n]); cap.classList.remove('out'); }, 160);
    }

    let playing = false, visible = false, started = false, timer = 0;
    function syncPlay() {
      const [icon, label] = playing ? ['pause', 'Pause'] : stage >= LAST ? ['replay', 'Play again'] : ['play', 'Play'];
      playBtn.innerHTML = `${PLAY_ICONS[icon]}<span>${label}</span>`;
      playBtn.setAttribute('aria-pressed', String(playing));
    }
    function schedule() {
      clearTimeout(timer);
      if (!playing || !visible) return;
      if (stage >= LAST) { playing = false; syncPlay(); return; }
      timer = setTimeout(() => { setStage(stage + 1); schedule(); }, hold[stage]);
    }
    function play() { if (stage >= LAST) setStage(0); playing = true; syncPlay(); schedule(); }
    function pause() { playing = false; clearTimeout(timer); syncPlay(); }
    function go(n) { started = true; pause(); setStage(n); syncPlay(); }
    // The first play: from the first step, unless the reader has already taken over
    function start() { if (started) return; started = true; if (!reduceMotion) { setStage(0, false); play(); } }
    // A chip, the Play button or an arrow key: the figure may need to get ready first (Fig 3 lands its box)
    const user = () => { if (onUser) onUser(); };

    setStage(reduceMotion ? reducedStage : 0, false);
    syncPlay();
    holdCaption();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(holdCaption);
    let lastW = innerWidth, rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (innerWidth !== lastW) { lastW = innerWidth; holdCaption(); } }, 150); });

    chips.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { user(); go(Number(c.dataset.step)); } });
    playBtn.addEventListener('click', () => { user(); started = true; if (playing) pause(); else play(); });

    // It holds while it is off screen
    watch(card, (seen) => {
      visible = seen;
      if (visible && auto) start();
      schedule();
    });

    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      // The figure in full view takes the keys; otherwise the figure across the middle of the window
      const full = document.querySelector('.cd-plate.is-full'), r = card.getBoundingClientRect();
      if (full ? !card.contains(full) : r.top > innerHeight / 2 || r.bottom < innerHeight / 2) return;
      e.preventDefault();
      user();
      go(stage + (e.key === 'ArrowRight' ? 1 : -1));
    });

    return { go, start, play, pause, holdCaption, get stage() { return stage; }, get playing() { return playing; } };
  }

  // A ledger entry under a figure: new value, with a small bump when it changes during play
  function setLedger(ledger, key, html, bump) {
    const d = ledger.querySelector(`[data-ledger="${key}"]`), dd = d && d.querySelector('dd');
    if (!dd || dd.innerHTML === html) return;
    dd.innerHTML = html;
    d.classList.remove('bump'); void d.offsetWidth;
    if (bump) d.classList.add('bump');
  }

  /* ---- Replicas of the apps (Figs 5 and 6) ----
     Small builders for the apps' controls, and the scene runner. A replica is drawn at its design size (W x H) and
     scaled to the card. Each scene is an async function over a context (wait, type, point, click, scroll, tween...).
     To show scene n the replica is rebuilt, scenes 0..n-1 run instantly (.cd-instant turns transitions off), and scene
     n runs animated, unless motion is reduced. */
  const ui = {
    seg: (labels, on) => `<div class="cd-seg">${labels.map((l, i) => `<span${i === on ? ' class="on"' : ''}>${l}</span>`).join('')}</div>`,
    // The apps' own theme switch shows the page's theme
    themeSeg: '<div class="cd-seg cd-seg-theme"><span>Light</span><span>Dark</span></div>',
    field: (cls, placeholder) => `<div class="cd-field ${cls}"><span class="cd-typed"></span><span class="cd-caret"></span><span class="cd-ph">${esc(placeholder)}</span></div>`,
    status: (s, words = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', DELIVERED: 'Delivered', RUNNING: 'Running' }) =>
      `<span class="cd-status cd-status-${s}">${words[s] || s}</span>`,
    check: (label, note, cls = '') => `<div class="cd-check ${cls}"><span class="cd-box"></span><span>${esc(label)} <span class="cd-muted">· ${esc(note)}</span></span></div>`,
    cursor: '<div class="cd-cursor"><svg viewBox="0 0 20 24" width="20" height="24" aria-hidden="true"><path d="M2 1.5v18.2l4.6-4.3 3.1 7.1 3-1.3-3.1-7h6.4z"/></svg><span class="cd-ring"></span></div>',
  };

  function replica({ card, view, W, H, stageClass = '', html, onStage, onReset, scenes, steps, hold, chips, playBtn, cap }) {
    const stage = document.createElement('div');
    const cls = `cd-stage ${stageClass}`.trim();
    stage.className = cls;
    stage.style.width = `${W}px`;
    stage.style.height = `${H}px`;
    view.appendChild(stage);
    if (onStage) onStage(stage);
    let k = 1;
    const fit = () => { k = view.clientWidth / W; stage.style.transform = `scale(${k})`; view.style.height = `${H * k}px`; };
    new ResizeObserver(fit).observe(view);
    fit();
    view.style.setProperty('--ar', String(W / H));
    const plate = view.closest('.cd-plate');
    if (plate) fullView(plate, view, cap, steps, fit);

    const $ = (sel) => stage.querySelector(sel);
    const CANCEL = Symbol('cancel');
    let runId = 0;
    function reset() {
      stage.className = cls;
      stage.innerHTML = html() + ui.cursor;
      if (onReset) onReset();
    }

    function ctx(id, animate) {
      const guard = () => { if (id !== runId) throw CANCEL; };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const at = (el) => {
        const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        return [(r.left - s.left) / k, (r.top - s.top) / k, r.width / k, r.height / k];
      };
      const c = {
        animate, guard,
        async wait(ms) { guard(); if (animate) { await sleep(ms); guard(); } },
        // Types into a replica field, a character at a time
        async type(el, text, cps = 34) {
          guard();
          const out = el.querySelector('.cd-typed') || el;
          el.classList.add('is-typing', 'has-text');
          if (!animate) { out.textContent = text; el.classList.remove('is-typing'); return; }
          for (let i = 1; i <= text.length; i++) { out.textContent = text.slice(0, i); await sleep((1000 / cps) * (text[i - 1] === ' ' ? 1.6 : 0.6 + Math.random() * 0.8)); guard(); }
          el.classList.remove('is-typing');
        },
        // Writes text a few words at a time, as a streamed reply
        async stream(el, text) {
          guard();
          if (!animate) { el.textContent = text; return; }
          const words = text.split(' ');
          for (let i = 1; i <= words.length; i++) { el.textContent = words.slice(0, i).join(' '); await sleep(34 + Math.random() * 40); guard(); }
        },
        async point(el, ms = 650, dx = 0.5, dy = 0.55) {
          guard();
          const [x, y, w, h] = at(el), cur = $('.cd-cursor');
          cur.classList.add('is-on');
          cur.style.transitionDuration = animate ? `${ms}ms` : '0ms';
          cur.style.transform = `translate(${(x + w * dx).toFixed(1)}px, ${(y + h * dy).toFixed(1)}px)`;
          if (animate) { await sleep(ms + 60); guard(); }
        },
        hide() { $('.cd-cursor').classList.remove('is-on'); },
        async click(el) {
          guard();
          if (!animate) return;
          const cur = $('.cd-cursor');
          cur.classList.remove('is-press'); void cur.offsetWidth; cur.classList.add('is-press');
          if (el) { el.classList.add('is-press'); setTimeout(() => el.classList.remove('is-press'), 220); }
          await sleep(260); guard();
        },
        async scroll(el, y, ms = 900) {
          guard();
          el.style.transitionDuration = animate ? `${ms}ms` : '0ms';
          el.style.transform = `translateY(${-y}px)`;
          if (animate) { await sleep(ms); guard(); }
        },
        // Calls fn(p) for p from 0 to 1 over ms, eased; instantly fn(1)
        async tween(ms, fn, ease = (p) => 1 - Math.pow(1 - p, 3)) {
          guard();
          if (!animate) { fn(1); return; }
          const t0 = performance.now();
          await new Promise((done) => {
            const tick = (t) => {
              if (id !== runId) return done();
              const p = Math.max(0, Math.min(1, (t - t0) / ms));
              fn(ease(p));
              if (p < 1) requestAnimationFrame(tick); else done();
            };
            requestAnimationFrame(tick);
          });
          guard();
        },
        count(el, to, ms = 1100) { return c.tween(ms, (p) => { el.textContent = String(Math.round(to * p)); }); },
        // Distance from the top of a scrolled box to an element in it, in replica pixels
        top(box, el) { return (el.getBoundingClientRect().top - box.getBoundingClientRect().top) / k; },
      };
      return c;
    }

    let primed = false, started = false;
    function runTo(n, animate) {
      const id = ++runId;
      reset();
      if (!primed && n === 0 && !animate) return; // before the first play: the first scene's starting point
      stage.classList.add('cd-instant');
      const fast = ctx(id, false);
      (async () => {
        try {
          for (let i = 0; i < n; i++) await scenes[i](fast);
          if (!animate) { await scenes[n](fast); return; }
          void stage.offsetWidth;
          stage.classList.remove('cd-instant');
          await scenes[n](ctx(id, true));
        } catch (e) { if (e !== CANCEL) throw e; }
        finally { if (id === runId && !animate) { void stage.offsetWidth; stage.classList.remove('cd-instant'); } }
      })();
    }

    const player = stepper({
      card, chips, playBtn, cap, steps, hold, reducedStage: steps.length - 1, auto: false,
      onUser: () => { primed = true; started = true; },
      render(n, animate) { if (animate) primed = true; runTo(n, animate); },
    });
    // The first time the card is on screen, it plays from the start
    watch(card, (seen) => {
      if (!seen || started || reduceMotion) return;
      started = true;
      primed = true;
      runTo(0, true);
      player.start();
    });
    return { stage, $, player };
  }

  /* Full view of an app screen: the plate grows from its place in the card to the window. The screen keeps its
     proportions, so it scales up uniformly (its transform runs from the card size to none) while the plate's clip opens
     from the card's rectangle to the window. The caption under the screen copies the figure's caption. Esc closes it. */
  function fullView(plate, view, cap, steps, fit) {
    const btn = plate.querySelector('.cd-full'), label = btn.querySelector('span');
    const transport = plate.querySelector('.cd-transport'), mirror = plate.querySelector('.cd-plate-cap');
    const root = document.documentElement, MS = 640;
    let holder = null, from = null, busy = false;

    const copy = () => { mirror.innerHTML = cap.innerHTML; mirror.classList.toggle('out', cap.classList.contains('out')); };
    new MutationObserver(copy).observe(cap, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    copy();

    // Room under the screen for the controls and the longest caption at the screen's width (twice: the width depends on it)
    function chrome() {
      for (let i = 0; i < 2; i++) {
        const probe = mirror.cloneNode(false);
        probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;min-height:0;width:${mirror.getBoundingClientRect().width}px`;
        plate.appendChild(probe);
        let h = 0;
        steps.forEach((st) => { probe.innerHTML = `<span class="uni-cap-step">${esc(st.label)}</span><p>${esc(st.text)}</p>`; h = Math.max(h, probe.offsetHeight); });
        probe.remove();
        mirror.style.minHeight = `${h}px`;
        plate.style.setProperty('--chrome', `${transport.offsetHeight + h + 10}px`);
      }
      fit();
    }
    const box = (el) => el.getBoundingClientRect();
    const inset = (r) => `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px)`;
    const flip = (to, at) => `translate(${to.left - at.left}px, ${to.top - at.top}px) scale(${to.width / at.width})`;
    const label2 = (on) => { btn.setAttribute('aria-pressed', String(on)); label.textContent = on ? 'Exit full view' : 'Full view'; };

    function open() {
      if (busy || holder) return;
      busy = true;
      const p0 = box(plate), v0 = box(view);
      from = { p: p0, v: v0 };
      holder = document.createElement('div');
      holder.style.cssText = `height:${p0.height}px;margin-top:${getComputedStyle(plate).marginTop}`;
      plate.before(holder);
      root.classList.add('cd-full-lock');
      plate.classList.add('is-full', 'is-opening');
      chrome();
      label2(true);
      if (reduceMotion) { plate.classList.remove('is-opening'); busy = false; return; }
      const v1 = box(view);
      plate.style.clipPath = inset(p0);
      view.style.transformOrigin = '0 0';
      view.style.transform = flip(v0, v1);
      void plate.offsetWidth;
      plate.classList.add('is-moving');
      plate.classList.remove('is-opening');
      plate.style.clipPath = 'inset(0px 0px 0px 0px)';
      view.style.transform = 'none';
      setTimeout(() => { plate.classList.remove('is-moving'); plate.style.clipPath = ''; view.style.transform = ''; busy = false; }, MS);
    }
    function close() {
      if (busy || !holder) return;
      busy = true;
      const finish = () => {
        plate.classList.remove('is-full', 'is-moving', 'is-closing');
        plate.style.clipPath = ''; plate.style.removeProperty('--chrome');
        view.style.transform = ''; view.style.transformOrigin = ''; mirror.style.minHeight = '';
        holder.remove(); holder = null;
        root.classList.remove('cd-full-lock');
        fit();
        label2(false);
        busy = false;
      };
      if (reduceMotion) { finish(); return; }
      // Where the screen sits in the card: as it left, scaled if the card's width changed meanwhile
      const h = box(holder), v1 = box(view), k = h.width / from.p.width;
      const v0 = { left: h.left + (from.v.left - from.p.left) * k, top: h.top + (from.v.top - from.p.top) * k, width: from.v.width * k };
      plate.style.clipPath = 'inset(0px 0px 0px 0px)';
      view.style.transformOrigin = '0 0';
      view.style.transform = 'none';
      void plate.offsetWidth;
      plate.classList.add('is-moving', 'is-closing');
      plate.style.clipPath = inset(h);
      view.style.transform = flip(v0, v1);
      setTimeout(finish, MS);
    }
    btn.addEventListener('click', () => (holder ? close() : open()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && holder) { e.preventDefault(); close(); } });
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (holder && !busy) chrome(); }, 120); });
  }

  window.FigKit = { ICON, reduceMotion, esc, image, pill, legend, fitLegends, LAKE, LAKE_ITEMS, stepper, setLedger, ui, replica };
})();
