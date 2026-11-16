/* Page orchestration, ported from the CMS Quality Dashboard: theme toggle, numbered sections that fold, the contents
   rail with the section you're reading open, and the section bar that pins on narrow screens. */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const RAIL_MQ = window.matchMedia('(min-width: 1100px)');
  const THEME_KEY = 'cohort-deck-theme';
  const FOLD_KEY = 'cohort-deck-collapsed';

  function initTheme() {
    const btns = [...document.querySelectorAll('#themeSeg [data-theme-set]')];
    const isDark = () => document.documentElement.dataset.theme === 'dark';
    const sync = () => btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === (isDark() ? 'dark' : 'light'))));
    const apply = (t) => { document.documentElement.dataset.theme = t; sync(); };
    sync();
    btns.forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.themeSet === (isDark() ? 'dark' : 'light')) return;
      try { localStorage.setItem(THEME_KEY, b.dataset.themeSet); } catch (e) { /* storage unavailable */ }
      apply(b.dataset.themeSet);
    }));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* ignore */ }
      if (!saved) apply(e.matches ? 'dark' : 'light');
    });
  }

  // Numbered sections fold away under their rules. What is folded is remembered, and following a link to a folded
  // section (the rail, the section bar or a #hash) opens it again.
  function initChapters() {
    const root = document.documentElement;
    const chapters = [...document.querySelectorAll('section.chapter')];
    if (!chapters.length) return;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch (e) { /* storage unavailable */ }
    const save = () => {
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(chapters.filter((c) => c.classList.contains('collapsed')).map((c) => c.id))); } catch (e) { /* ignore */ }
    };
    const set = (ch, collapsed) => {
      if (ch.classList.contains('collapsed') === collapsed) return;
      ch.querySelectorAll('.chapter-toggle, .chapter-act').forEach((b) => b.setAttribute('aria-expanded', String(!collapsed)));
      ch.querySelector('.chapter-act-label').textContent = collapsed ? 'Show' : 'Hide';
      // Content is clipped only while it folds, so focus rings are never cut off in an open section
      ch.classList.add('folding');
      clearTimeout(ch.foldTimer);
      ch.foldTimer = setTimeout(() => ch.classList.remove('folding'), 560);
      ch.classList.toggle('collapsed', collapsed);
    };
    const pillsFor = (ch) => chapters.map((c) => {
      const name = esc(c.querySelector('.chapter-name').textContent);
      const on = c === ch;
      return `<a class="chapter-pill${on ? ' on' : ''}" href="#${c.id}"${on ? ' aria-current="location"' : ''} title="${c.dataset.num} ${name}" aria-label="Section ${c.dataset.num}: ${name}">${c.dataset.num}</a>`;
    }).join('');
    chapters.forEach((ch) => {
      ch.querySelector('.chapter-stick').insertAdjacentHTML('afterbegin',
        `<div class="chapter-tag" aria-hidden="true"><span class="chapter-tag-num">${ch.dataset.num}</span>${esc(ch.dataset.label || '')}</div>`);
    });
    buildRail(chapters);
    root.classList.add('fold-init');
    chapters.forEach((ch) => {
      if (saved.includes(ch.id)) set(ch, true);
      ch.querySelectorAll('.chapter-toggle, .chapter-act').forEach((b) => b.addEventListener('click', () => { set(ch, !ch.classList.contains('collapsed')); save(); }));
    });
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('fold-init')));
    const openFor = (hash) => {
      const target = hash && hash.length > 1 && document.getElementById(decodeURIComponent(hash.slice(1)));
      const ch = target && target.closest('section.chapter');
      if (!ch || !ch.classList.contains('collapsed')) return;
      // The section's spacing settles at once (the content still unfolds), so the scroll lands on its final position
      ch.style.transition = 'none';
      set(ch, false);
      save();
      void ch.offsetHeight;
      requestAnimationFrame(() => { ch.style.transition = ''; });
    };
    document.addEventListener('click', (e) => {
      const a = e.target.closest('.chapter-pill[href], .section-bar-name, .q-toc-link, a[href^="#"]');
      if (a) openFor(a.getAttribute('href'));
    });
    window.addEventListener('hashchange', () => { openFor(location.hash); queue(); });
    openFor(location.hash);

    // Narrow screens: once a section's title has scrolled under the header, the section bar pins its number and title;
    // the bar leaves just before the section ends, so it never covers the next one. Beside the rail it isn't needed.
    const topbar = document.querySelector('.topbar');
    const bar = document.getElementById('sectionBar');
    let pinned = null, queued = false;
    function track() {
      queued = false;
      const T = topbar.getBoundingClientRect().bottom;
      let pin = null;
      if (!RAIL_MQ.matches) {
        chapters.forEach((ch) => {
          const r = ch.getBoundingClientRect();
          if (!r.height || ch.classList.contains('collapsed')) return;
          if (ch.querySelector('.chapter-title').getBoundingClientRect().bottom < T && r.bottom > T + 110) pin = ch;
        });
      }
      if (pin === pinned) return;
      pinned = pin;
      if (pin) {
        bar.querySelector('.chapter-pills').innerHTML = pillsFor(pin);
        const name = bar.querySelector('.section-bar-name');
        name.textContent = pin.querySelector('.chapter-name').textContent;
        name.setAttribute('href', `#${pin.id}`);
      }
      bar.classList.toggle('on', !!pin);
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(track); } }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    queue();
  }

  // The contents rail (wide screens): every section's number and short name; the section you're reading expands to its
  // title and description. Those are copies of the section's own, which stay in the section for screen readers and for
  // narrow screens, where the rail is just the numbers.
  function buildRail(chapters) {
    const toc = document.getElementById('qToc');
    if (!toc) return;
    const copy = (from, to) => {
      const sync = () => {
        to.innerHTML = from.innerHTML;
        to.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      };
      sync();
      new MutationObserver(sync).observe(from, { childList: true, subtree: true, characterData: true });
    };
    chapters.forEach((ch) => {
      const li = document.createElement('li');
      li.className = 'q-toc-item';
      li.innerHTML = `<a class="q-toc-link" href="#${ch.id}"><span class="chapter-pill">${ch.dataset.num}</span><span class="q-toc-name">${esc(ch.dataset.label || '')}</span></a>
        <div class="q-toc-detail" aria-hidden="true"><div><div class="q-toc-title"></div><div class="q-toc-desc"></div></div></div>`;
      toc.appendChild(li);
      copy(ch.querySelector('.chapter-name'), li.querySelector('.q-toc-title'));
      copy(ch.querySelector('.chapter-lede > div'), li.querySelector('.q-toc-desc'));
    });
    // Beside the rail a section's title is visually hidden (the rail shows it), so its fold button leaves the tab order;
    // the Hide/Show control on the section's rule does the same job
    const tabbable = () => chapters.forEach((ch) => ch.querySelectorAll('.chapter-toggle').forEach((b) => {
      if (RAIL_MQ.matches) b.setAttribute('tabindex', '-1'); else b.removeAttribute('tabindex');
    }));
    tabbable();
    RAIL_MQ.addEventListener('change', tabbable);
  }

  // The rail marks and expands the section you are reading: the last section whose top has passed a line a third of the
  // way down the screen
  function initScrollspy() {
    const items = [...document.querySelectorAll('#qToc .q-toc-item')];
    if (!items.length) return;
    const sections = items.map((li) => document.getElementById(li.querySelector('.q-toc-link').getAttribute('href').slice(1)));
    const rail = document.querySelector('.q-rail-inner');
    const topbar = document.querySelector('.topbar');
    let queued = false, current = null, settle = 0;
    // When the rail is taller than the screen, scroll it (not the page) so the expanded section shows in full
    const reveal = (li) => {
      if (!rail || rail.scrollHeight <= rail.clientHeight + 1) return;
      const r = rail.getBoundingClientRect(), b = li.getBoundingClientRect();
      let dy = 0;
      if (b.bottom > r.bottom - 8) dy = b.bottom - r.bottom + 8;
      if (b.top - dy < r.top + 4) dy = b.top - r.top - 4;
      if (dy) rail.scrollBy({ top: dy, behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    const mark = () => {
      queued = false;
      const T = topbar.getBoundingClientRect().bottom, line = T + (innerHeight - T) * 0.33;
      let cur = 0;
      sections.forEach((sec, i) => { if (sec.getBoundingClientRect().top <= line) cur = i; });
      if (cur === current) return;
      current = cur;
      items.forEach((li, i) => {
        const on = i === cur, a = li.querySelector('.q-toc-link');
        li.classList.toggle('on', on);
        li.querySelector('.chapter-pill').classList.toggle('on', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
      clearTimeout(settle);
      settle = setTimeout(() => reveal(items[cur]), 520);
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(mark); } };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    queue();
  }

  function boot() {
    initTheme();
    initChapters();
    initScrollspy();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
