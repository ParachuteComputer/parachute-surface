// mount(el, doc, host) → handle. Draws one note: Level 1 (G1–G7) for every note, then the typed view when its type is
// registered. No network, ever: no fetch, no remote image, font or icon; an image loads only as a blob: or data: URL the
// host hands back for one of the note's own attachments. Reader state is either content (a one-line edit handed to
// host.save as a patch) or a sitting (this object's memory, gone with the view).
import { el, button, setLine, safeHref, safeImageUrl, reducedMotion } from './dom.js';
import { parse } from './parse.js';
import { types } from './registry.js';
import { tableCharts, strip } from './charts.js';
import { createTimers } from './timers.js';
import { toggleTask, appendLog } from './edit.js';
import * as R from './rules.js';

const BLOCK = { p: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, ul: 1, ol: 1, li: 1, blockquote: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1 };
const INLINE = { strong: 1, em: 1, s: 1 };
const CALLOUT_LABEL = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
const WIKI = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** The same note? By id when both have one, else by path; null when neither side says (a note given as plain text). */
function sameNote(a, b) {
  if (a.id && b.id) return a.id === b.id;
  if (a.path && b.path) return a.path === b.path;
  return !a.id && !b.id && !a.path && !b.path ? null : false;
}
function isDoc(x) { return x && x.kind === 'rich-note' && Array.isArray(x.sections); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'; }
function factText(v) { return Array.isArray(v) ? v.join(', ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v); }
/** The note as the reader would see the file: the facts the vault keeps beside it as front matter, then the content. */
export function plainText(doc) {
  const own = doc.facts.filter((f) => f.from === 'metadata');
  if (!own.length && !(doc.tags.length && !doc.yamlLines)) return doc.content;
  const lines = ['---'];
  if (doc.tags.length && !doc.yamlLines) lines.push('tags: [' + doc.tags.join(', ') + ']');
  for (const f of own) lines.push(f.key + ': ' + (Array.isArray(f.value) ? '[' + f.value.join(', ') + ']' : factText(f.value)));
  lines.push('---');
  return lines.join('\n') + '\n' + doc.content;
}

export function mount(target, input, host) {
  host = host || {};
  if (!target || typeof target.appendChild !== 'function') throw new TypeError('mount needs an element');
  let doc = isDoc(input) ? input : parse(input, { type: host.view });
  let source = isDoc(input) ? null : (typeof input === 'string' ? { content: input } : input);
  const state = { scale: 1, units: host.units === 'metric' || host.units === 'us' ? host.units : null, got: new Set(), step: 0, transpose: 0, plain: false, open: new Map(), charts: new Map(), status: '' };
  const calm = () => !!(typeof host.calm === 'function' ? host.calm() : host.calm) || reducedMotion();
  const timers = createTimers(host, calm);
  const sealed = (() => { try { return window.origin === 'null' || location.protocol === 'about:'; } catch (e) { return true; } })();
  let root = null, destroyed = false, cleanups = [];
  const images = new Map(); // an attachment is asked for once per view, not once per redraw
  const today = () => (host.today ? String(host.today) : R.todayIso(host.now ? host.now() : undefined));

  function noteOf(d) {
    const metadata = {}; d.facts.forEach((f) => { if (f.from === 'metadata') metadata[f.key] = f.value; });
    return { ...(source || {}), content: d.content, metadata: source && source.metadata ? source.metadata : metadata, tags: source && source.tags ? source.tags : d.tags, path: d.path, id: d.id, updatedAt: d.revision };
  }

  /* ── inline: text stays text ── */
  function inline(children, parent) {
    const stack = [parent];
    const top = () => stack[stack.length - 1];
    const kids = [];
    for (const c of children || []) { const prev = kids[kids.length - 1]; if (c.type === 'text' && prev && prev.type === 'text') prev.content += c.content; else kids.push(c.type === 'text' ? { type: 'text', content: c.content } : c); }
    for (const t of kids) {
      if (t.type === 'text') text(top(), t.content);
      else if (t.type === 'softbreak' || t.type === 'hardbreak') top().appendChild(el('br'));
      else if (t.type === 'code_inline') top().appendChild(el('code', null, t.content));
      else if (t.nesting === 1 && INLINE[t.tag]) { const n = el(t.tag); top().appendChild(n); stack.push(n); }
      else if (t.type === 'link_open') {
        const href = safeHref(t.attrGet('href'));
        let a;
        if (href && sealed && !host.openLink) { a = el('span', 'rn-link-off'); a.title = href; }
        else if (href) { a = el('a', 'rn-link'); a.setAttribute('href', href); a.setAttribute('rel', 'noopener noreferrer nofollow'); a.setAttribute('referrerpolicy', 'no-referrer'); if (!sealed && !host.openLink && /^https:/i.test(href)) a.setAttribute('target', '_blank'); }
        else a = el('span', 'rn-link-off');
        top().appendChild(a); stack.push(a);
      }
      else if (t.nesting === -1 && stack.length > 1) stack.pop();
      else if (t.type === 'image') top().appendChild(image(t));
      else if (t.type === 'html_inline') top().appendChild(document.createTextNode(t.content));
      else if (t.type === 'text_special' || t.type === 'entity') top().appendChild(document.createTextNode(t.content));
    }
  }
  function text(parent, s) {
    let at = 0, m; WIKI.lastIndex = 0;
    while ((m = WIKI.exec(s))) {
      if (m.index > at) parent.appendChild(document.createTextNode(s.slice(at, m.index)));
      const ref = m[1].trim(), label = (m[2] || m[1]).trim();
      const w = el('span', 'rn-wikilink', label);
      if (host.openNote) {
        w.setAttribute('role', 'link'); w.tabIndex = 0;
        const go = (e) => { e.preventDefault(); host.openNote(ref); };
        w.addEventListener('click', go);
        w.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
      }
      parent.appendChild(w);
      at = m.index + m[0].length;
    }
    if (at < s.length) parent.appendChild(document.createTextNode(s.slice(at)));
  }
  function image(t) {
    const src = String(t.attrGet('src') || ''), alt = t.content || '';
    // The host gets the raw src, as a markdown host does. The kit's own check reads it at every level of decoding, so
    // a scheme, `//` or `..` is refused however many times it was encoded.
    const plainPath = (p) => !/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^\/\//.test(p) && !/[\\\u0000-\u001f]/.test(p) && !/(^|\/)\.\.?(\/|[?#]|$)/.test(p);
    let attachment = !!src;
    for (let p = src, k = 0; attachment && k < 8; k++) {
      attachment = plainPath(p);
      let next; try { next = decodeURIComponent(p); } catch (e) { break; } // a lone % (a name like "100%.png") ends it
      if (next === p) break;
      p = next;
      if (k === 7) attachment = false; // still decoding after eight levels: refused
    }
    if (attachment && host.image) {
      const img = el('img', 'rn-img'); img.alt = alt;
      const holder = el('span', 'rn-img-wait', 'Image: ' + (alt || 'attachment'));
      if (!images.has(src)) { const p = Promise.resolve().then(() => host.image(src)).catch((e) => { if (images.get(src) === p) images.delete(src); throw e; }); images.set(src, p); } // a failure (or an unsafe answer) is asked again next time
      // refused by the host, or handed back as anything but a blob:/data:image URL → the "(not loaded)" label
      const refused = () => { holder.className = 'rn-img-off'; holder.textContent = 'Image: ' + (alt || 'untitled') + ' (not loaded)'; };
      const p = images.get(src);
      p.then((u) => { const ok = safeImageUrl(u); if (!ok) { if (images.get(src) === p) images.delete(src); refused(); } else if (holder.isConnected) { img.src = ok; holder.replaceWith(img); } }, refused);
      return holder;
    }
    // PATTERNS privacy rule 2: a remote image tells its server the note was opened, so it is never loaded
    const href = sealed && !host.openLink ? null : safeHref(src);
    const a = el(href ? 'a' : 'span', 'rn-img-off', 'Image: ' + (alt || 'untitled') + ' (not loaded)');
    if (href) { a.classList.add('rn-link'); a.setAttribute('href', href); a.setAttribute('rel', 'noopener noreferrer nofollow'); a.setAttribute('referrerpolicy', 'no-referrer'); if (!sealed && !host.openLink) a.setAttribute('target', '_blank'); }
    return a;
  }

  /* ── blocks ── */
  function flow(def, skip) {
    const tokens = doc.tokens, out = el('div', 'rn-flow'), stack = [out];
    const top = () => stack[stack.length - 1];
    const closeDetails = () => { for (let k = stack.length - 1; k > 0; k--) if (stack[k].tagName === 'DETAILS') { stack.length = k; return true; } return false; };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i], line = t.map ? t.map[0] + 1 : null;
      if (skip.has(i)) { let d = t.nesting; while (d > 0 && ++i < tokens.length) d += tokens[i].nesting; continue; }
      if (t.type === 'heading_open' && t.tag === 'h2' && t.level === 0) while (closeDetails());
      if (t.type === 'inline') { inline(t.children, top()); continue; }
      if (t.type === 'paragraph_open' && t.hidden) { stack.push(top()); continue; }
      if (t.type === 'paragraph_close' && t.hidden) { stack.pop(); continue; }
      if (t.nesting === 1 && BLOCK[t.tag]) {
        const n = setLine(el(t.tag), line);
        if (t.tag === 'ol' && t.attrGet('start')) n.setAttribute('start', String(parseInt(t.attrGet('start'), 10) || 1));
        const al = /^text-align:(left|center|right)$/.exec(t.attrGet('style') || '');
        if (al) n.style.textAlign = al[1];
        if (t.tag === 'table') { const w = setLine(el('div', 'rn-table'), line); w.appendChild(n); top().appendChild(w); } else top().appendChild(n);
        stack.push(n); continue;
      }
      if (t.nesting === -1 && BLOCK[t.tag]) { if (stack.length > 1) stack.pop(); continue; }
      if (t.type === 'fence') {
        const name = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
        let node = null;
        if (def && def.fences && Object.prototype.hasOwnProperty.call(def.fences, name) && typeof def.fences[name] === 'function') { try { node = def.fences[name](t.content, view, line); } catch (e) { node = null; } }
        if (node && !(node instanceof Node)) node = null;
        if (!node) { node = setLine(el('pre', 'rn-code'), line); node.appendChild(el('code', null, t.content)); }
        top().appendChild(node); continue;
      }
      if (t.type === 'code_block') { const pre = setLine(el('pre', 'rn-code'), line); pre.appendChild(el('code', null, t.content)); top().appendChild(pre); continue; }
      if (t.type === 'hr') { top().appendChild(el('hr')); continue; }
      if (t.type === 'html_block') {
        const parts = t.meta && t.meta.rnDetails;
        if (!parts) { top().appendChild(setLine(el('p', 'rn-raw', t.content.replace(/\n+$/, '')), line)); continue; }
        for (const p of parts) {
          if (p.open) {
            const d = setLine(el('details', 'rn-details'), line);
            const key = line + ':' + stack.length;
            d.open = state.open.has(key) ? state.open.get(key) : p.startsOpen;
            d.addEventListener('toggle', () => state.open.set(key, d.open));
            top().appendChild(d); stack.push(d);
          } else if (p.summary != null) {
            const host2 = top();
            if (host2.tagName === 'DETAILS' && !host2.querySelector(':scope > summary')) {
              const s = el('summary', 'rn-summary'); s.appendChild(el('span', 'rn-summary-mark')); s.appendChild(el('span', 'rn-summary-text', p.summary));
              host2.insertBefore(s, host2.firstChild);
            } else host2.appendChild(setLine(el('p', 'rn-raw', '<summary>' + p.summary + '</summary>'), line));
          } else if (!closeDetails()) top().appendChild(setLine(el('p', 'rn-raw', '</details>'), line));
        }
        continue;
      }
    }
    // a <details> with no <summary> still needs a row to tap
    out.querySelectorAll('details.rn-details').forEach((d) => { if (!d.querySelector(':scope > summary')) { const s = el('summary', 'rn-summary'); s.appendChild(el('span', 'rn-summary-mark')); s.appendChild(el('span', 'rn-summary-text', 'Details')); d.insertBefore(s, d.firstChild); } });
    return out;
  }

  function byLine(scope, sel, line) { return scope.querySelector(sel + '[data-line="' + Number(line) + '"]'); }
  function firstText(node) {
    const host2 = node.firstElementChild && node.firstElementChild.tagName === 'P' && node.firstChild === node.firstElementChild ? node.firstElementChild : node;
    return host2.firstChild && host2.firstChild.nodeType === 3 ? host2.firstChild : null;
  }

  /* G5 */
  function callouts(scope) {
    for (const c of doc.callouts) {
      const bq = byLine(scope, 'blockquote', c.line); if (!bq) continue;
      const p = bq.firstElementChild, tn = p && p.firstChild;
      if (tn && tn.nodeType === 3) { tn.nodeValue = tn.nodeValue.replace(/^\[![A-Za-z]+\][ \t]*/, ''); if (!tn.nodeValue) { const br = tn.nextSibling; tn.remove(); if (br && br.tagName === 'BR') br.remove(); } }
      if (p && !p.textContent.trim() && !p.querySelector('img,code')) p.remove();
      const box = setLine(el('aside', 'rn-callout'), c.line); box.setAttribute('data-kind', c.kind);
      const head = el('div', 'rn-callout-title'); head.appendChild(el('span', 'rn-callout-mark')); head.appendChild(el('span', null, CALLOUT_LABEL[c.kind]));
      const body = el('div', 'rn-callout-body');
      while (bq.firstChild) body.appendChild(bq.firstChild);
      box.appendChild(head); box.appendChild(body);
      bq.replaceWith(box);
    }
  }

  /* G3 */
  function tasks(scope) {
    for (const tk of doc.tasks) {
      const li = byLine(scope, 'li', tk.line); if (!li) continue;
      const tn = firstText(li); if (!tn || !/^\[( |x|X)\][ \t]+/.test(tn.nodeValue)) continue;
      const canWrite = !!toggleTask(doc.content, tk.line, !tk.done);
      tn.nodeValue = tn.nodeValue.replace(/^\[( |x|X)\][ \t]+/, '');
      li.classList.add('rn-task'); li.classList.toggle('is-done', tk.done); li.parentElement.classList.add('rn-tasks');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = tk.done;
      if (!host.save || !canWrite) { cb.disabled = true; cb.title = 'Read only here'; }
      const body = el('div', 'rn-task-body');
      while (li.firstChild) body.appendChild(li.firstChild);
      cb.setAttribute('aria-label', (tk.done ? 'Done: ' : 'To do: ') + body.textContent.trim().slice(0, 60));
      cb.addEventListener('change', () => {
        li.classList.toggle('is-done', cb.checked);
        const want = cb.checked;
        commit(() => toggleTask(doc.content, tk.line, want), 'task');
      });
      const box = el('label', 'rn-task-check'); box.appendChild(cb); box.appendChild(el('span', 'rn-box'));
      li.appendChild(box); li.appendChild(body);
      chips(body, tk);
      if (tk.owners.length) li.setAttribute('data-owner', tk.owners.join(' '));
    }
  }
  function chips(body, tk) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), nodes = [];
    let n; while ((n = walker.nextNode())) { const inner = n.parentNode.closest('ul, ol'); if (!inner || !body.contains(inner)) nodes.push(n); }
    for (const node of nodes) {
      const s = node.nodeValue, re = /(^|[\s,(])@([A-Za-z][\w.-]*)|\bdue (\d{4}-\d\d-\d\d)\b/g;
      let m, at = 0; const frag = document.createDocumentFragment(); let hit = false;
      while ((m = re.exec(s))) {
        hit = true;
        const start = m[2] ? m.index + m[1].length : m.index;
        frag.appendChild(document.createTextNode(s.slice(at, start)));
        if (m[2]) { const name = m[2].replace(/[.-]+$/, ''); frag.appendChild(el('span', 'rn-owner', name)); at = start + 1 + name.length; continue; }
        const d = m[3], days = R.isoDate(d) ? R.daysBetween(d, today()) : null, late = !tk.done && days > 0 ? days : 0;
        // a done task keeps its date; only an open one is "due today" or late
        const chip = el('span', 'rn-due' + (late > 0 ? ' is-late' : ''), days === null ? m[0] : late > 0 ? late + (late === 1 ? ' day late' : ' days late') : !tk.done && days === 0 ? 'due today' : 'due ' + R.dayName(d));
        if (R.isoDate(d)) chip.title = 'Due ' + R.dayName(d, true);
        frag.appendChild(chip); at = m.index + m[0].length;
      }
      if (!hit) continue;
      frag.appendChild(document.createTextNode(s.slice(at)));
      node.replaceWith(frag);
    }
    // "send it — @wen, due …" → "send it" and the chips
    const all = []; const w2 = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let t; while ((t = w2.nextNode())) all.push(t);
    const isChip = (x) => x && x.nodeType === 1 && /\brn-(owner|due)\b/.test(x.className);
    for (const x of all) {
      if (isChip(x.nextSibling)) x.nodeValue = x.nodeValue.replace(/\s*[—–-]\s*$|,\s*$/, ' ');
      if (isChip(x.previousSibling) && /^[\s,]*$/.test(x.nodeValue)) x.nodeValue = isChip(x.nextSibling) ? ' ' : '';
    }
  }

  /* G4 */
  function logs(scope, def) {
    const lists = new Map();
    for (const lg of doc.log) {
      const li = byLine(scope, 'li', lg.line); if (!li) continue;
      const tn = firstText(li); if (!tn) continue;
      const m = /^(\d{4}-\d\d-\d\d)(?::?[ \t]*)/.exec(tn.nodeValue); if (!m) continue;
      tn.nodeValue = tn.nodeValue.slice(m[0].length);
      const chip = el('time', 'rn-log-date', R.shortDate(lg.date, lg.date.slice(0, 4) !== today().slice(0, 4)));
      chip.setAttribute('datetime', lg.date);
      tn.parentNode.insertBefore(chip, tn);
      li.classList.add('rn-log'); li.setAttribute('data-date', lg.date);
      const list = li.parentElement;
      if (!lists.has(list)) lists.set(list, []);
      lists.get(list).push(li);
    }
    for (const [list, lis] of lists) {
      if (lis.length !== list.children.length) continue;
      list.classList.add('rn-logs');
      // a timeline, newest first
      [...lis].sort((a, b) => (a.getAttribute('data-date') < b.getAttribute('data-date') ? 1 : -1)).forEach((li) => list.appendChild(li));
      // G4: one button adds today's line (a type that owns this log draws its own)
      const lg = doc.log.find((x) => x.line === +lis[0].getAttribute('data-line'));
      const sec = lg && doc.sections.find((x) => x.key === lg.section && !x.intro);
      if (host.save && sec && !(def && def.logs && def.logs.includes(sec.key))) {
        const done = doc.log.some((x) => x.section === sec.key && x.date === today());
        const b = button('rn-link-btn rn-add-today', done ? 'Today is in' : 'Add today', () => { b.disabled = true; commit(() => appendLog(doc.content, [sec.name], today()), 'log'); });
        b.disabled = done; b.setAttribute('data-writes', '');
        list.after(b);
      }
    }
  }

  /* G7 */
  function tables(scope) {
    const seen = new Map();
    for (const tb of doc.tables) {
      // the key counts every table with these headers in the section, chartable or not, so it stays put when a
      // line is added above it or a cell is fixed
      const sig = tb.section + '|' + tb.head.join('|'), nth = (seen.get(sig) || 0); seen.set(sig, nth + 1);
      const tableKey = sig + '|' + nth;
      const wrap = byLine(scope, 'div.rn-table', tb.line); if (!wrap || !tb.chart) continue;
      const table = wrap.querySelector('table');
      const sw = button('rn-chip rn-chart-switch', 'Chart', null);
      let charts = null;
      const set = (on) => {
        sw.setAttribute('aria-pressed', String(on)); sw.textContent = on ? 'Table' : 'Chart';
        sw.setAttribute('aria-label', on ? 'Show the table' : 'Show this table as a chart');
        if (on && !charts) { charts = tableCharts(tb); wrap.appendChild(charts); }
        if (charts) charts.hidden = !on;
        table.hidden = on;
        state.charts.set(tableKey, on);
      };
      sw.addEventListener('click', () => set(sw.getAttribute('aria-pressed') !== 'true'));
      wrap.insertBefore(sw, wrap.firstChild);
      set(state.charts.has(tableKey) ? state.charts.get(tableKey) : !!(state.chartsFirst && state.chartsFirst.has(tb.section)));
    }
  }

  function sections(f) {
    const out = el('div', 'rn-sections');
    let cur = el('section', 'rn-section'); cur.setAttribute('data-section', 'intro');
    for (const n of [...f.childNodes]) {
      if (n.tagName === 'H2') {
        if (cur.childNodes.length) out.appendChild(cur);
        cur = el('section', 'rn-section'); cur.setAttribute('data-section', slug(n.textContent));
        cur.setAttribute('data-line', n.getAttribute('data-line'));
        const head = el('div', 'rn-section-head'); head.appendChild(n); cur.appendChild(head);
      } else cur.appendChild(n);
    }
    if (cur.childNodes.length) out.appendChild(cur);
    return out;
  }

  function hero(def) {
    const h = el('div', 'rn-hero'); // a div, not a <header>: a host's rule on header must not reach it
    const top = el('div', 'rn-hero-top');
    const kicker = el('p', 'rn-kicker'); kicker.hidden = true;
    top.appendChild(kicker);
    if (host.plainText !== false) {
      const sw = button('rn-chip rn-plain-switch', state.plain ? 'Rendered' : 'Plain text', () => { state.plain = !state.plain; draw(); }, state.plain ? 'Show the rendered note' : 'Show the note as plain text');
      sw.setAttribute('aria-pressed', String(state.plain));
      top.appendChild(sw);
    }
    h.appendChild(top);
    const title = el('h1', 'rn-title');
    const ti = doc.internal.title;
    if (ti.token != null) { setLine(title, ti.line); inline(doc.tokens[ti.token + 1].children, title); } else title.textContent = doc.title || 'Untitled';
    h.appendChild(title);
    if (doc.internal.lead) { const p = setLine(el('p', 'rn-lead'), doc.internal.lead.line); inline(doc.tokens[doc.internal.lead.token + 1].children, p); h.appendChild(p); }
    const shown = doc.tags.filter((t) => t !== doc.type);
    if (shown.length) { const ul = el('ul', 'rn-tags'); shown.forEach((t) => ul.appendChild(el('li', null, t))); h.appendChild(ul); }
    const dl = el('dl', 'rn-facts');
    const order = (def && def.facts) || [];
    const facts = [...doc.facts].sort((a, b) => { const i = order.indexOf(a.key.toLowerCase()), j = order.indexOf(b.key.toLowerCase()); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
    for (const f of facts) {
      let shownFact = { label: f.key.charAt(0).toUpperCase() + f.key.slice(1), text: factText(f.value) };
      if (def && def.fact) { const r = def.fact(f.key.toLowerCase(), f.value, doc); if (r === null) continue; if (r) shownFact = r; }
      const row = el('div', 'rn-fact'); row.setAttribute('data-key', f.key.toLowerCase());
      row.appendChild(el('dt', null, shownFact.label)); row.appendChild(el('dd', null, shownFact.text));
      dl.appendChild(row);
    }
    if (dl.childNodes.length) h.appendChild(dl);
    return { h, kicker };
  }

  /* ── content writes: one line, through the host, with the revision the reader saw ── */
  const status = el('p', 'rn-status'); status.setAttribute('role', 'status');
  function say(s) { state.status = s || ''; status.textContent = state.status; }
  /* One write at a time. While a save is out, every control that writes is disabled ([data-writes], task boxes), so
     each edit is built from the note as the last save left it, at the revision that save returned. */
  let saving = false;
  function disableWrites() { if (root) root.querySelectorAll('.rn-task input, [data-writes]').forEach((x) => { x.disabled = true; }); }
  async function commit(build, why) {
    if (destroyed) return false;
    if (saving) { say('One moment: the last change is still saving.'); draw(); return false; }
    const result = build();
    if (!result || !host.save) { draw(); return false; }
    const was = doc;
    const patch = { ...result.patch, why, revision: was.revision, id: was.id, path: was.path };
    saving = true;
    disableWrites();
    say('Saving…');
    try {
      const r = await host.save(result.content, patch);
      if (destroyed) return true;
      // the host may have handed over a note meanwhile (update()): a newer one wins; one no newer than the edit's doesn't
      const applies = doc === was || (sameNote(doc, was) !== false && !!doc.revision && doc.revision === was.revision && doc.content === was.content);
      if (applies) {
        const next = noteOf(doc); next.content = result.content; next.updatedAt = (r && (r.updatedAt || r.updated_at)) || doc.revision;
        source = next; doc = parse(next, { type: host.view || doc.type });
      }
      say(applies ? 'Saved.' : 'Saved. The note on screen was reloaded while it saved.');
      return true;
    } catch (e) {
      if (destroyed) return false;
      const code = e && (e.status || e.code || (e.response && e.response.status));
      say(code === 409 || /conflict|stale/i.test(String(e && e.message)) ? 'Not saved: this note changed somewhere else. Open it again to see the latest.' : 'Not saved. Try again in a moment.');
      return false;
    } finally {
      saving = false;
      if (!destroyed) draw();
    }
  }

  /* ── the view a type draws on ── */
  const refreshers = [];
  const view = {
    get doc() { return doc; }, host, state, timers, rules: R, el, button, today, calm,
    get root() { return root; },
    canSave: () => !!host.save,
    section: (names) => { const s = doc.sections.find((x) => !x.intro && [].concat(names).includes(x.key)); return s && root ? root.querySelector('section.rn-section[data-line="' + s.line + '"]') : null; },
    at: (sel, line) => (root ? byLine(root, sel, line) : null),
    onRefresh: (f) => refreshers.push(f),
    refresh: () => refreshers.forEach((f) => { try { f(); } catch (e) { /* one view part */ } }),
    appendLog: (names, textArg) => commit(() => appendLog(doc.content, names, today(), textArg), 'log'),
    get saving() { return saving; },
    say,
    redraw: () => draw(),
    cleanup: (f) => cleanups.push(f),
    _inline: (children, parent) => inline(children, parent),
    strip,
  };

  function draw() {
    if (destroyed) return;
    cleanups.forEach((f) => { try { f(); } catch (e) { /* gone */ } }); cleanups = []; refreshers.length = 0;
    const def = doc.type ? types.get(doc.type) : null;
    root = el('article', 'rn');
    if (doc.type) root.setAttribute('data-type', doc.type);
    const skip = new Set();
    if (doc.internal.title.token != null) skip.add(doc.internal.title.token);
    if (doc.internal.lead) skip.add(doc.internal.lead.token);
    state.chartsFirst = def && def.chartsFirst ? new Set(def.chartsFirst) : null;
    const f = flow(def, skip);
    callouts(f); tasks(f); logs(f, def); tables(f);
    const body = sections(f);
    const { h, kicker } = hero(def);
    view.hero = h; view.kicker = kicker; view.body = body;
    root.appendChild(h);
    root.appendChild(status);
    if (state.plain) {
      const pre = el('pre', 'rn-plain', plainText(doc)); pre.setAttribute('aria-label', 'The note as plain text');
      root.appendChild(pre);
    } else {
      root.appendChild(body);
      if (def && def.draw) { try { def.draw(view); } catch (e) { root.setAttribute('data-view-error', '1'); } }
      kicker.hidden = !kicker.textContent;
    }
    root.appendChild(timers.tray);
    root.addEventListener('click', onClick);
    root.addEventListener('auxclick', (e) => { if ((host.openLink || sealed) && e.target.closest && e.target.closest('a[href]')) e.preventDefault(); });
    target.replaceChildren(root);
    if (saving) disableWrites();
  }
  function onClick(e) {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !root.contains(a)) return;
    const href = a.getAttribute('href');
    if (host.openLink) { e.preventDefault(); host.openLink(href); return; }
    if (sealed) e.preventDefault(); // a sealed frame must never navigate: the host would stop the app
  }

  draw();
  return {
    get root() { return root; },
    get doc() { return doc; },
    get state() { return { scale: state.scale, units: state.units, step: state.step, transpose: state.transpose, plain: state.plain, got: [...state.got] }; },
    timers,
    /** a fresh note (after a save elsewhere, or a reload): the sitting is kept */
    update(next) { source = isDoc(next) ? null : (typeof next === 'string' ? { content: next } : next); const prev = doc; doc = isDoc(next) ? next : parse(next, { type: host.view }); if (sameNote(prev, doc) !== true) images.clear(); draw(); }, // another note asks for its attachments afresh
    redraw: draw,
    destroy() { destroyed = true; timers.stopAll(); cleanups.forEach((f) => { try { f(); } catch (e) { /* gone */ } }); target.replaceChildren(); },
    _view: view,
  };
}
