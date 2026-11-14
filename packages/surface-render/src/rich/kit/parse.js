// parse(note) → doc. Pure: no DOM, no network, no storage. Runs in a browser, a sealed frame or Node.
//   note = {content, metadata?, tags?, path?, id?, updatedAt?} or a string
//   doc  = {type, title, facts, tags, sections, tasks, log, tables, callouts, details, warnings, …and the type's own model}
// Line numbers are 1-based lines of the note's content, YAML block included. Warnings name a line and a rule, never the
// line's text (PATTERNS, privacy rule 5).
import { md } from './md.js';
import { splitLines, frontMatter, decodeEntities } from './text.js';
import { task, logLine, cellNumber, isoDate } from './rules.js';
import { types, typeOf } from './registry.js';

export const RULE_TEXT = {
  'G1-yaml': 'facts written as a YAML block in the content: they belong in the note\'s metadata',
  'G1-fact-line': 'a "Key: value" line under the title is read as text: facts belong in the note\'s metadata',
  'G3-due': 'a due date that is not a real date (write due YYYY-MM-DD)',
  'G5-callout': 'a callout word outside the five (NOTE, TIP, IMPORTANT, WARNING, CAUTION): shown as a quote',
  'G5-nested': 'a callout inside a list or a quote: callouts are top level only',
  'G6-html': 'HTML other than <details> and <summary>: shown as text',
  'G6-nested': '<details> inside a list or a quote: shown as text (top level only)',
  'R1-two-amounts': 'an ingredient line with more than one amount: one ingredient per line reads better',
  'R2-paragraphs': 'a step with more than one paragraph: one paragraph per step',
  'R2-split': 'the steps are split into more than one list',
  'M2-no-counts': 'a Vote: line with no counts (N for, N against, N abstain)',
};
const CALLOUTS = ['note', 'tip', 'important', 'warning', 'caution'];
const FACT_LINE = /^(tags|source|servings|serves|yield|time|date|type|category|categories):\s+\S/i;

export function normName(s) { return String(s).trim().replace(/[:.]+$/, '').replace(/\s+/g, ' ').toLowerCase(); }
function normTag(t) { return String(t).trim().replace(/^#/, '').toLowerCase(); }

/** <details>, <summary>…</summary> and </details>, with only whitespace between; anything else → null. */
export function detailsParts(src) {
  const re = /\s*(?:<details(\s+open)?\s*>|<(\/)details\s*>|<summary\s*>([^<]*)<\/summary\s*>)\s*/iy;
  const parts = []; let m; re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[3] != null) parts.push({ summary: decodeEntities(m[3].trim()) });
    else if (m[2]) parts.push({ close: true });
    else parts.push({ open: true, startsOpen: !!m[1] });
  }
  return re.lastIndex === src.length || /^\s*$/.test(src.slice(re.lastIndex)) ? (parts.length ? parts : null) : null;
}

export function parse(note, opts) {
  if (typeof note === 'string') note = { content: note };
  note = note || {};
  const content = String(note.content == null ? '' : note.content);
  const { lines } = splitLines(content);
  const fm = frontMatter(lines);
  // the YAML block's lines are blanked, not removed, so every token's line is the content's own line
  const tokens = md.parse(lines.map((l, i) => (i < fm.end ? '' : l)).join('\n'), {});
  const warnings = [];
  const warn = (line, rule) => { if (!warnings.some((w) => w.line === line && w.rule === rule)) warnings.push({ line, rule, message: RULE_TEXT[rule] || rule }); };
  if (fm.end) warn(1, 'G1-yaml');

  /* facts: metadata first, then the YAML block for keys the metadata lacks (G1) */
  const meta = note.metadata && typeof note.metadata === 'object' && !Array.isArray(note.metadata) ? note.metadata : {};
  const facts = [], seen = new Set();
  for (const [key, value] of Object.entries(meta)) { if (key.toLowerCase() === 'tags') continue; facts.push({ key, value, from: 'metadata' }); seen.add(key.toLowerCase()); }
  for (const [key, value] of Object.entries(fm.data)) { if (key.toLowerCase() === 'tags' || seen.has(key.toLowerCase())) continue; facts.push({ key, value, from: 'content' }); seen.add(key.toLowerCase()); }
  let tagList = Array.isArray(note.tags) && note.tags.length ? note.tags : null;
  if (!tagList && Array.isArray(meta.tags)) tagList = meta.tags;
  if (!tagList && fm.data.tags != null) tagList = Array.isArray(fm.data.tags) ? fm.data.tags : String(fm.data.tags).split(',');
  const tags = [...new Set((tagList || []).map(normTag).filter(Boolean))];
  const type = typeOf(tags, (opts && opts.type) || note.type);

  /* title and lead (G1) */
  let title = null, lead = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0) continue;
    if (t.type === 'heading_open' && t.tag === 'h2') break;
    if (t.type === 'heading_open' && t.tag === 'h1' && !title) {
      title = { text: tokens[i + 1].content, line: t.map[0] + 1, token: i };
      const p = tokens[i + 3];
      if (p && p.type === 'paragraph_open' && p.level === 0) {
        lead = { line: p.map[0] + 1, token: i + 3 };
        tokens[i + 4].content.split('\n').forEach((l, k) => { if (FACT_LINE.test(l)) warn(p.map[0] + 1 + k, 'G1-fact-line'); });
      }
      break;
    }
  }
  if (!title) {
    const leaf = String(note.path || '').replace(/\.[a-z0-9]+$/i, '').split('/').pop();
    title = { text: leaf || '', line: null, token: null };
  }

  /* named sections (G2): ## is the section level */
  const sections = [];
  let cur = { name: '', key: '', line: 1, endLine: lines.length, from: 0, to: tokens.length, intro: true };
  sections.push(cur);
  tokens.forEach((t, i) => {
    if (t.type === 'heading_open' && t.tag === 'h2' && t.level === 0) {
      cur.to = i; cur.endLine = t.map[0];
      cur = { name: tokens[i + 1].content, key: normName(tokens[i + 1].content), line: t.map[0] + 1, endLine: lines.length, from: i, to: tokens.length, intro: false };
      sections.push(cur);
    }
  });
  const sectionAt = (i) => { for (let k = sections.length - 1; k >= 0; k--) if (sections[k].from <= i) return sections[k]; return sections[0]; };

  /* list items, with their first paragraph's text, their sub-group (###) and their list */
  const items = [];
  let group = null, groupSection = null, listNo = 0;
  const listStack = [];
  tokens.forEach((t, i) => {
    if (t.type === 'heading_open' && t.tag === 'h3' && t.level === 0) { group = tokens[i + 1].content; groupSection = sectionAt(i); }
    if (t.type === 'heading_open' && t.tag === 'h2' && t.level === 0) group = null;
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') listStack.push({ no: ++listNo, ordered: t.type === 'ordered_list_open', line: t.map[0] + 1, token: i, level: t.level });
    if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') listStack.pop();
    if (t.type !== 'list_item_open') return;
    let depth = 0, first = null, paragraphs = 0, end = i;
    for (let j = i; j < tokens.length; j++) {
      depth += tokens[j].nesting;
      if (tokens[j].type === 'paragraph_open' && tokens[j].level === t.level + 1) { paragraphs++; if (!first) first = tokens[j + 1]; }
      if (depth === 0) { end = j; break; }
    }
    const list = listStack[listStack.length - 1];
    const sec = sectionAt(i);
    items.push({ line: t.map[0] + 1, endLine: t.map[1], text: first ? first.content : '', token: i, end, level: t.level, list: list.no, ordered: list.ordered, top: list.level === 0, section: sec, group: groupSection === sec ? group : null, paragraphs });
  });

  /* G3 tasks and G4 log lines */
  const tasks = [], log = [];
  for (const it of items) {
    const tk = task(it.text);
    if (tk) {
      tasks.push({ line: it.line, done: tk.done, text: tk.text, owners: tk.owners, due: tk.due, section: it.section.key });
      if (tk.due && !tk.dueValid) warn(it.line, 'G3-due');
      it.task = true;
      continue;
    }
    const lg = logLine(it.text);
    if (lg) { log.push({ line: it.line, date: lg.date, text: lg.text, section: it.section.key, list: it.list }); it.log = true; }
  }

  /* G5 callouts, G6 collapse and the HTML that is shown as text, G7 tables */
  const callouts = [], details = [], tables = [];
  tokens.forEach((t, i) => {
    if (t.type === 'blockquote_open') {
      const p = tokens[i + 1], inl = tokens[i + 2];
      const m = p && p.type === 'paragraph_open' && inl && /^\[!([A-Za-z]+)\][ \t]*$/.exec(inl.content.split('\n')[0]);
      if (m) {
        const kind = m[1].toLowerCase();
        if (!CALLOUTS.includes(kind)) warn(t.map[0] + 1, 'G5-callout');
        else if (t.level !== 0) warn(t.map[0] + 1, 'G5-nested');
        else callouts.push({ line: t.map[0] + 1, kind, token: i });
      }
    }
    if (t.type === 'html_block') {
      const parts = detailsParts(t.content);
      if (parts && t.level === 0) { t.meta = { ...(t.meta || {}), rnDetails: parts }; parts.forEach((p) => { if (p.open) details.push({ line: t.map[0] + 1, open: p.startsOpen, summary: null }); else if (p.summary != null && details.length) details[details.length - 1].summary = p.summary; }); }
      else warn(t.map[0] + 1, parts ? 'G6-nested' : 'G6-html');
    }
    if (t.type === 'inline' && t.children && t.children.some((c) => c.type === 'html_inline')) warn(t.map ? t.map[0] + 1 : 0, 'G6-html');
    if (t.type === 'table_open') {
      const head = [], rows = []; let row = null, inHead = false, k = i + 1;
      for (; k < tokens.length && tokens[k].type !== 'table_close'; k++) {
        const x = tokens[k];
        if (x.type === 'thead_open') inHead = true;
        if (x.type === 'thead_close') inHead = false;
        if (x.type === 'tr_open') row = [];
        if (x.type === 'inline') row.push(x.content.trim());
        if (x.type === 'tr_close') (inHead ? head : rows).push(row);
      }
      const cols = (head[0] || []).length;
      const numeric = [];
      for (let c = 0; c < cols; c++) if (rows.length && rows.every((r) => cellNumber(r[c] == null ? '' : r[c]) !== null)) numeric.push(c);
      const dates = rows.length > 0 && rows.every((r) => !!isoDate(r[0]));
      tables.push({ line: t.map[0] + 1, head: head[0] || [], rows, numeric, dates, chart: numeric.length > 0, token: i, section: sectionAt(i).key });
    }
  });

  const doc = {
    kind: 'rich-note', version: 1,
    id: note.id || null, path: note.path || null, revision: note.updatedAt || note.updated_at || null,
    type, title: title.text, titleLine: title.line, lead: lead ? lead.line : null,
    facts, tags, sections: sections.map(({ name, key, line, endLine, intro }) => ({ name, key, line, endLine, intro })),
    tasks, log, tables, callouts, details, warnings,
  };
  // the parser's own view of the note: kept off the plain model (not enumerable), for mount() and the type readers
  Object.defineProperty(doc, 'content', { value: content });
  Object.defineProperty(doc, 'tokens', { value: tokens });
  Object.defineProperty(doc, 'yamlLines', { value: fm.end });
  Object.defineProperty(doc, 'internal', { value: { title, lead, sections, items } });
  doc.fact = function (...keys) { for (const k of keys) for (const f of facts) if (f.key.toLowerCase() === k) return f.value; return undefined; };
  Object.defineProperty(doc, 'fact', { enumerable: false });

  const def = type && types.get(type);
  if (def && def.read) {
    const walk = {
      tokens, items, warn,
      /** the first section whose name is one of these (any letter case) */
      section: (names) => sections.find((s) => !s.intro && names.includes(s.key)) || null,
      itemsIn: (sec) => (sec ? items.filter((it) => it.section === sec) : []),
    };
    doc[type] = def.read(doc, walk);
  }
  warnings.sort((a, b) => a.line - b.line);
  return doc;
}
