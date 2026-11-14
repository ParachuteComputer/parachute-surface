// Recipe (tag `recipe`): R1 ingredient lines, R2 steps and cook mode, R3 times and heat in steps, and the Made log (G4).
import { el, button, setLine } from '../dom.js';
import * as R from '../rules.js';

const ING = ['ingredients'], STEPS = ['steps', 'method', 'directions', 'instructions'], MADE = ['made'];

function read(doc, walk) {
  const raw = doc.fact('servings', 'serves', 'yield');
  const n = raw == null ? NaN : parseFloat(String(raw));
  const servings = isFinite(n) && n > 0 ? n : null;
  const ingredients = walk.itemsIn(walk.section(ING)).filter((it) => it.top && !it.task).map((it) => {
    const qs = R.quantities(it.text);
    if (qs.length > 1) walk.warn(it.line, 'R1-two-amounts');
    return { line: it.line, text: it.text, group: it.group, amounts: qs.length, lead: qs[0] && qs[0].start === 0 ? it.text.slice(0, qs[0].unitEnd || qs[0].end) : null };
  });
  const stepItems = walk.itemsIn(walk.section(STEPS)).filter((it) => it.top && it.ordered);
  if (new Set(stepItems.map((s) => s.list)).size > 1) walk.warn(stepItems.find((s) => s.list !== stepItems[0].list).line, 'R2-split');
  const steps = stepItems.map((it, i) => {
    if (it.paragraphs > 1) walk.warn(it.line, 'R2-paragraphs');
    const t = /^(\*\*|__)(.+?)\1/.exec(it.text);
    return { n: i + 1, line: it.line, title: t ? t[2].replace(/[.:]\s*$/, '') : null, text: it.text, durations: R.durations(it.text).map(({ text, seconds, extra }) => ({ text, seconds, extra })), temperatures: R.temperatures(it.text).map(({ text, degrees, scale }) => ({ text, degrees, scale })) };
  });
  const madeKeys = MADE;
  const made = doc.log.filter((l) => madeKeys.includes(l.section)).map((l) => l.date).sort();
  return { servings, ingredients, steps, made, timed: steps.reduce((a, s) => a + Math.max(0, ...s.durations.map((d) => d.seconds)), 0) };
}

/* Wrap matches found in a node's own text (outside nested lists) in spans; positions are in the joined text. */
/* Wrap each hit in the element make() returns. A hit may cross inline formatting ("**2** cups"): its range is moved
   into the element (into el._slot when given) and a copy is kept as el._orig, so "as written" can be put back. Hits
   are taken last to first, so the text before each one keeps its offsets. */
function decorate(root, find, make) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = []; let n, full = '';
  while ((n = walker.nextNode())) { if (n.parentNode.closest('ul ul, ol ol, ul ol, ol ul, code, button, .rn-qty')) continue; nodes.push({ node: n, at: full.length }); full += n.nodeValue; }
  const locate = (pos, end) => {
    for (const it of nodes) { const len = it.node.nodeValue.length; if (pos >= it.at && (pos < it.at + len || (end && pos === it.at + len))) return [it.node, pos - it.at]; }
    return null;
  };
  for (const h of find(full).sort((a, b) => b.start - a.start)) {
    const a = locate(h.start, false), b = locate(h.end, true);
    if (!a || !b) continue;
    const range = document.createRange();
    range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]);
    const raw = range.toString();
    if (raw !== full.slice(h.start, h.end)) continue; // something between moved: leave it as written
    const node = make(h, raw), frag = range.extractContents();
    node._orig = frag.cloneNode(true);
    (node._slot || node).appendChild(frag);
    range.insertNode(node);
  }
  // a range that cut through **bold** leaves the emptied half behind
  root.querySelectorAll('strong, em, s').forEach((x) => { if (!x.textContent && !x.closest('.rn-qty, .rn-temp, .rn-time')) x.remove(); });
  return full;
}

function draw(v) {
  const d = v.doc, r = d.recipe, st = v.state;
  const base = r.servings;
  const ingSec = v.section(ING), stepSec = v.section(STEPS), madeSec = v.section(MADE);
  const qtys = [], temps = [];

  /* the hero: how big a job it is, honestly; when it was made; start cooking */
  const stats = el('p', 'rn-recipe-stats');
  const parts = [r.steps.length ? r.steps.length + (r.steps.length === 1 ? ' step' : ' steps') : null, r.ingredients.length ? r.ingredients.length + ' ingredients' : null, r.timed ? 'timers add up to ' + R.span(r.timed) : null].filter(Boolean);
  stats.textContent = parts.join(' · ');
  if (parts.length) v.hero.appendChild(stats);
  const acts = el('div', 'rn-hero-acts');
  if (r.steps.length) acts.appendChild(button('rn-btn', 'Start cooking', () => cook(0)));
  const past = r.made.filter((d) => d <= v.today()); // a planned date in Made is not "made" yet
  const last = past[past.length - 1];
  const times = past.length;
  acts.appendChild(el('span', 'rn-made', times ? 'Made ' + (times === 1 ? 'once' : times === 2 ? 'twice' : times + ' times') + ' · last on ' + R.shortDate(last) : 'Not made yet'));
  const madeToday = r.made.includes(v.today());
  const madeBtn = () => { const b = button('rn-btn rn-btn-quiet', madeToday ? 'Made today ✓' : 'Made today', () => { b.disabled = true; v.appendLog(['Made']); }); b.disabled = !v.canSave() || madeToday; b.setAttribute('data-writes', ''); if (!v.canSave()) b.title = 'Read only here'; return b; };
  if (v.canSave()) acts.appendChild(madeBtn());
  v.hero.appendChild(acts);
  if (times) v.hero.appendChild(v.strip(past, v.today()));

  /* R1: check-offs, a quantity set apart, servings and units */
  if (ingSec) {
    const lis = r.ingredients.map((ing) => ({ ing, li: v.at('li', ing.line) })).filter((x) => x.li);
    let hasUnits = false;
    for (const { ing, li } of lis) {
      li.classList.add('rn-ing');
      const label = el('label', 'rn-ing-row'), cb = el('input'), body = el('span', 'rn-ing-text');
      cb.type = 'checkbox'; cb.checked = st.got.has(ing.text);
      while (li.firstChild) body.appendChild(li.firstChild);
      // quantities found on the text as the reader sees it, outside parentheses
      // a quantity's span holds its unit too, so a conversion can rewrite both
      decorate(body, (full) => R.quantities(full).map((q) => ({ ...q, end: q.unitEnd || q.end, qtyEnd: q.end })), (q, raw) => {
        const s = el('span', 'rn-qty' + (q.start === 0 ? ' is-lead' : ''));
        s._q = q; s._raw = raw; qtys.push(s); if (q.unit) hasUnits = true; return s;
      });
      cb.setAttribute('aria-label', 'Have it: ' + body.textContent.slice(0, 60));
      cb.addEventListener('change', () => { if (cb.checked) st.got.add(ing.text); else st.got.delete(ing.text); li.classList.toggle('is-got', cb.checked); count(); });
      li.classList.toggle('is-got', cb.checked);
      label.appendChild(cb); label.appendChild(el('span', 'rn-box')); label.appendChild(body);
      li.appendChild(label);
      li.parentElement.classList.add('rn-ingredients');
    }
    const head = ingSec.querySelector('.rn-section-head');
    const counter = el('span', 'rn-section-count');
    function count() { const got = lis.filter((x) => st.got.has(x.ing.text)).length; counter.textContent = got ? got + ' of ' + lis.length + ' ready' : lis.length + ' things'; }
    count();
    if (head) head.appendChild(counter);
    const controls = el('div', 'rn-controls');
    controls.appendChild(scaler());
    if (hasUnits || r.steps.some((s) => s.temperatures.length)) controls.appendChild(unitSwitch());
    if (head) head.after(controls);
    const clear = button('rn-link-btn', 'Clear ticks', () => { st.got.clear(); v.redraw(); });
    const foot = el('p', 'rn-hint-row'); foot.appendChild(el('span', 'rn-hint', 'Ticks stay on this screen; the note is unchanged.')); foot.appendChild(clear);
    ingSec.appendChild(foot);
  }
  function scaler() {
    const g = el('div', 'rn-seg'); g.setAttribute('role', 'group');
    if (base) {
      g.setAttribute('aria-label', 'Servings');
      const out = el('output', 'rn-serves');
      const set = (n) => { st.scale = Math.max(1, n) / base; v.refresh(); };
      g.appendChild(button('rn-seg-btn', '−', () => set(Math.round(base * st.scale) - 1), 'Fewer servings'));
      g.appendChild(out);
      g.appendChild(button('rn-seg-btn', '+', () => set(Math.round(base * st.scale) + 1), 'More servings'));
      v.onRefresh(() => { out.textContent = 'Serves ' + R.fraction(base * st.scale).replace(/^0$/, '1'); });
    } else {
      g.setAttribute('aria-label', 'Scale the recipe');
      [[0.5, '×½'], [1, '×1'], [2, '×2']].forEach(([k, t]) => {
        const b = button('rn-seg-btn', t, () => { st.scale = k; v.refresh(); }, k === 1 ? 'As written' : k === 2 ? 'Double it' : 'Half of it');
        v.onRefresh(() => b.setAttribute('aria-pressed', String(st.scale === k)));
        g.appendChild(b);
      });
    }
    return g;
  }
  function unitSwitch() {
    const g = el('div', 'rn-seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Units');
    [['us', 'US'], ['metric', 'Metric']].forEach(([u, t]) => {
      const b = button('rn-seg-btn', t, () => { st.units = u; v.refresh(); }, u === 'us' ? 'Cups, pounds and °F' : 'Grams, millilitres and °C');
      v.onRefresh(() => b.setAttribute('aria-pressed', String(st.units === u)));
      g.appendChild(b);
    });
    return g;
  }
  v.onRefresh(() => {
    for (const s of qtys) {
      const q = s._q, shown = R.showQuantity(q, st.scale, st.units);
      if (!shown) { s.replaceChildren(s._orig.cloneNode(true)); s.classList.remove('is-changed'); continue; }
      const unitPart = s._raw.slice(q.qtyEnd - q.start);
      s.textContent = shown.unit ? shown.amount + ' ' + shown.unit : shown.amount + unitPart;
      s.classList.add('is-changed');
    }
    for (let i = temps.length - 1; i >= 0; i--) if (!v.root.contains(temps[i])) temps.splice(i, 1); // cook mode's steps come and go
    for (const t of temps) {
      // as written until the reader picks a system; then heat follows it; a tap flips one reading
      const flip = st.units ? (t._t.scale === 'F') === (st.units === 'metric') : false;
      const show = t._flipped ? !flip : flip;
      if (show) t.textContent = R.otherTemperature(t._t); else t.replaceChildren(t._orig.cloneNode(true));
      t.classList.toggle('is-changed', show);
    }
    if (stepNote) { stepNote.hidden = st.scale === 1; stepNote.textContent = 'Amounts in the steps are for the original' + (base ? ' ' + base : ' recipe') + '.'; }
  });

  /* R2, R3: steps with times as quiet chips, heat that taps over, and a cook mode */
  let stepNote = null;
  function decorateStep(node, step) {
    let k = 0;
    decorate(node, (full) => [...R.durations(full).map((x) => ({ ...x, kind: 'd' })), ...R.temperatures(full).map((x) => ({ ...x, kind: 't' }))].sort((a, b) => a.start - b.start).filter((h, i, all) => !all.slice(0, i).some((o) => h.start < o.end)), (h, raw) => {
      if (h.kind === 't') {
        const b = button('rn-temp', null, null, 'Show in ' + (h.scale === 'F' ? '°C' : '°F'));
        b._t = h; b._raw = raw; b._flipped = false;
        b.addEventListener('click', () => { b._flipped = !b._flipped; v.refresh(); });
        temps.push(b); return b;
      }
      const key = 's' + step.n + ':' + (k++);
      const b = button('rn-time', null, () => v.timers.start(key, 'Step ' + step.n, h.seconds, h.extra), 'Start a ' + R.span(h.seconds) + ' timer for step ' + step.n);
      b.setAttribute('data-timer', key);
      b.appendChild(el('span', 'rn-time-mark'));
      b._slot = b.appendChild(el('span', 'rn-time-text'));
      b.appendChild(el('span', 'rn-time-live'));
      return b;
    });
  }
  const timerButtons = () => (v.root ? v.root.querySelectorAll('button.rn-time[data-timer]') : []);
  const syncTimers = () => timerButtons().forEach((b) => {
    const t = v.timers.find(b.getAttribute('data-timer'));
    b.classList.toggle('is-running', !!t && t.state === 'running'); b.classList.toggle('is-paused', !!t && t.state === 'paused'); b.classList.toggle('is-done', !!t && t.state === 'done');
    b.querySelector('.rn-time-live').textContent = t ? v.timers.show(t) : '';
  });
  v.cleanup(v.timers.onChange(syncTimers));
  v.onRefresh(syncTimers);
  if (stepSec) {
    stepNote = el('p', 'rn-hint rn-steps-note'); stepNote.hidden = true;
    const head = stepSec.querySelector('.rn-section-head');
    if (head) head.after(stepNote);
    for (const step of r.steps) {
      const li = v.at('li', step.line); if (!li) continue;
      li.classList.add('rn-step'); li.parentElement.classList.add('rn-steps');
      decorateStep(li, step);
    }
    if (r.steps.length) stepSec.appendChild(button('rn-btn rn-btn-quiet rn-cook-open', 'Cook mode: one step at a time', () => cook(0)));
  }
  if (madeSec && !madeSec.querySelector('li') && !times) madeSec.appendChild(el('p', 'rn-hint', 'Not made yet.'));

  /* cook mode: one step per screen, large type; the screen kept awake only where the host says it can */
  function cook(start) {
    let i = start, lock = null, lockedBy = null;
    const box = el('div', 'rn-cook'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Cook mode');
    const bar = el('div', 'rn-cook-bar');
    bar.appendChild(el('span', 'rn-cook-title', d.title));
    const wake = el('span', 'rn-cook-wake', 'Screen may dim');
    bar.appendChild(wake);
    const close = button('rn-btn rn-btn-quiet', 'Close', () => end());
    bar.appendChild(close);
    const prog = el('div', 'rn-cook-progress');
    const stage = el('div', 'rn-cook-stage');
    const nav = el('div', 'rn-cook-nav');
    const prev = button('rn-btn rn-btn-quiet', 'Back', () => go(i - 1));
    const next = button('rn-btn rn-cook-next', 'Next', () => (i >= r.steps.length ? end() : go(i + 1)));
    nav.appendChild(prev); nav.appendChild(next);
    box.appendChild(bar); box.appendChild(prog); box.appendChild(stage); box.appendChild(nav);
    r.steps.forEach((s, k) => { const b = button('rn-cook-seg', null, () => go(k), 'Step ' + s.n); prog.appendChild(b); });
    function go(k) {
      i = Math.max(0, Math.min(r.steps.length, k)); st.step = i;
      [...prog.children].forEach((b, k2) => { b.classList.toggle('is-done', k2 < i); b.classList.toggle('is-now', k2 === i); });
      stage.textContent = '';
      const card = el('div', 'rn-cook-card');
      if (i < r.steps.length) {
        const s = r.steps[i];
        card.appendChild(el('p', 'rn-cook-num', 'Step ' + s.n + ' of ' + r.steps.length));
        const text = el('div', 'rn-cook-text');
        const li = v.at('li', s.line);
        // the step as the page shows it, its chips made afresh so they start the same timers
        const src = d.internal.items.find((it) => it.line === s.line);
        const p = el('p'); const inl = src && d.tokens[src.token + 1] && d.tokens[src.token + 2];
        if (inl && inl.type === 'inline') { v._inline(inl.children, p); decorateStep(p, s); } else if (li) p.textContent = li.textContent;
        text.appendChild(p);
        card.appendChild(text);
        next.textContent = i === r.steps.length - 1 ? 'Finish' : 'Next';
      } else {
        card.classList.add('rn-cook-done');
        card.appendChild(el('p', 'rn-cook-text', 'Done. Enjoy it.'));
        const a = el('div', 'rn-cook-acts');
        if (v.canSave() && !madeToday) { const add = a.appendChild(button('rn-btn', 'Add today to Made', () => { add.disabled = true; end(); v.appendLog(['Made']); })); add.setAttribute('data-writes', ''); add.disabled = v.saving; }
        a.appendChild(button('rn-btn rn-btn-quiet', 'Close', () => end()));
        card.appendChild(a);
        next.textContent = 'Close';
      }
      prev.disabled = i === 0;
      stage.appendChild(card);
      syncTimers(); v.refresh();
    }
    const keys = (e) => { if (e.key === 'ArrowRight') go(i + 1); else if (e.key === 'ArrowLeft') go(i - 1); else if (e.key === 'Escape') end(); };
    document.addEventListener('keydown', keys);
    let ended = false;
    function end() {
      if (ended) return; ended = true;
      document.removeEventListener('keydown', keys);
      if (lockedBy === 'host') { try { v.host.keepAwake(false); } catch (e) { /* host */ } }
      if (lock) { try { lock.release(); } catch (e) { /* gone */ } }
      box.remove(); document.documentElement.classList.remove('rn-cooking');
    }
    (async () => {
      let ok = false;
      try { if (v.host.keepAwake) { ok = !!(await v.host.keepAwake(true)); if (ok) lockedBy = 'host'; } } catch (e) { ok = false; }
      if (!ok) { try { if (navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); ok = !!lock; } } catch (e) { ok = false; } }
      if (ended) { // closed while the lock was on its way
        if (lockedBy === 'host') { try { v.host.keepAwake(false); } catch (e) { /* host */ } }
        if (lock) { try { lock.release(); } catch (e) { /* gone */ } }
        return;
      }
      wake.textContent = ok ? 'Screen stays on' : 'Screen may dim';
    })();
    v.root.insertBefore(box, v.timers.tray);
    document.documentElement.classList.add('rn-cooking');
    v.cleanup(end); // a redraw (a save, an update) closes cook mode cleanly
    go(start);
    next.focus();
  }
  v.refresh();
}

export default {
  tag: 'recipe',
  sections: { ingredients: ING, steps: STEPS, made: MADE },
  facts: ['servings', 'serves', 'yield', 'time', 'prep time', 'cook time', 'source'],
  logs: MADE,
  fact(key, value) {
    if (key === 'servings' || key === 'serves' || key === 'yield') return { label: 'Serves', text: String(value) };
    if (key === 'time') return { label: 'Time', text: String(value) };
    return undefined;
  },
  read, draw,
};
