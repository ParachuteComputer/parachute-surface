// Content edits: one line, nothing else touched. The kit never re-serialises a note, so what it doesn't understand
// survives. Each returns {content, patch} (patch says which one line changed) or null when the edit doesn't apply.
import { splitLines, joinLines, eolOf } from './text.js';
import { parse, normName } from './parse.js';

const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/;

/** G3: check or uncheck the task on this 1-based line. `done` sets it; omitted, it toggles. */
export function toggleTask(content, line, done) {
  const { lines, ends } = splitLines(content);
  const i = line - 1, m = lines[i] != null && TASK_LINE.exec(lines[i]);
  if (!m) return null;
  const next = done == null ? m[2] === ' ' : !!done;
  const before = lines[i];
  lines[i] = m[1] + (next ? '[x]' : '[ ]') + before.slice(m[0].length);
  if (lines[i] === before) return null;
  return { content: joinLines(lines, ends), patch: { op: 'replace', line, before, after: lines[i] } };
}

/** G4: add "- YYYY-MM-DD[: text]" as the last line of the log list in the named section (any letter case), or start
 *  the section at the end of the note. `names` is one name or a list of aliases; the first is used for a new section. */
export function appendLog(content, names, date, text) {
  if (!/^\d{4}-\d\d-\d\d$/.test(String(date))) throw new TypeError('appendLog needs an ISO date');
  names = [].concat(names);
  const keys = names.map(normName);
  const doc = parse({ content });
  const { lines, ends } = splitLines(content);
  const eol = eolOf(content);
  const entry = (marker) => marker + ' ' + date + (text ? ': ' + String(text).replace(/[\r\n]+/g, ' ').trim() : '');
  const sec = doc.internal.sections.find((s) => !s.intro && keys.includes(s.key));
  let at, newLine;
  if (!sec) {
    let last = lines.length; while (last > 0 && !lines[last - 1].trim()) last--;
    const add = [];
    if (last > 0) add.push('');
    add.push('## ' + names[0], entry('-'));
    lines.splice(last, lines.length - last, ...add);
    ends.splice(last, ends.length - last, ...add.map(() => eol));
    if (last > 0) ends[last - 1] = ends[last - 1] || eol;
    ends[ends.length - 1] = eol;
    return { content: joinLines(lines, ends), patch: { op: 'insert', line: lines.length, after: lines[lines.length - 1] } };
  }
  const logs = doc.internal.items.filter((it) => it.section === sec && it.top && it.log);
  if (logs.length) {
    const lastItem = logs[logs.length - 1];
    at = lastItem.endLine; // 1-based last line of the item, as markdown-it maps it
    while (at > lastItem.line && !lines[at - 1].trim()) at--;
    const mk = /^(\s*)([-*+]|(\d+)([.)]))\s/.exec(lines[lastItem.line - 1]);
    const marker = mk ? mk[1] + (mk[3] ? (+mk[3] + 1) + mk[4] : mk[2]) : '-';
    lines.splice(at, 0, entry(marker));
    ends.splice(at, 0, eol);
    if (!ends[at - 1]) ends[at - 1] = eol;
    newLine = at + 1;
  } else {
    // the section has no log yet: a new list after its last line, set apart by a blank line
    let end = sec.endLine; while (end > sec.line && !lines[end - 1].trim()) end--;
    const add = end > sec.line ? ['', entry('-')] : [entry('-')];
    lines.splice(end, 0, ...add);
    ends.splice(end, 0, ...add.map(() => eol));
    if (!ends[end - 1]) ends[end - 1] = eol;
    newLine = end + add.length;
    if (end + add.length < lines.length && lines[end + add.length].trim()) { lines.splice(end + add.length, 0, ''); ends.splice(end + add.length, 0, eol); }
  }
  return { content: joinLines(lines, ends), patch: { op: 'insert', line: newLine, after: lines[newLine - 1] } };
}
