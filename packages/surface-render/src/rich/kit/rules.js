// The reading rules of PATTERNS v0.3, as pure functions over one line of text. No DOM, no network.
// The regexes for R1, R3 and M2 are the study's own (study/checks/check-examples.js), so the kit and the checks agree
// line for line; test/node/contract.test.mjs runs every case from that file against these functions.

/* ── Numbers: read whole or not at all (v0.3 change 9) ── */
const UF = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
export const NUM = String.raw`(?:\d+ \d+\/\d+|\d+\/\d+|\d+ ?[½¼¾⅓⅔⅛]|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛])`;
export const RNG = String.raw`\s?(?:-|–|to)\s?`;
const QTY_SRC = String.raw`(?<![\w/.–-])(${NUM})(?:(${RNG})(${NUM}))?(?![\w/])`;

/** The value of one written quantity: "4 1/2" → 4.5, "1½" → 1.5, "½" → 0.5, "1.5" → 1.5. */
export function value(s) {
  const u = /^(\d+)? ?([½¼¾⅓⅔⅛])$/.exec(s);
  if (u) return +(u[1] || 0) + UF[u[2]];
  return s.split(' ').reduce((a, p) => a + (p.includes('/') ? p.split('/')[0] / p.split('/')[1] : +p), 0);
}

/** A kitchen fraction: 1/8, 1/4, 1/3, 1/2, 2/3, 3/4, never 0.6667 and never 0 (the floor is 1/8). */
export function fraction(x) {
  if (x === 0) return '0';
  const w = Math.floor(x + 1e-9), r = x - w;
  const F = [[0, ''], [1 / 8, '1/8'], [1 / 4, '1/4'], [1 / 3, '1/3'], [1 / 2, '1/2'], [2 / 3, '2/3'], [3 / 4, '3/4'], [1, '']];
  let b = F[0];
  for (const f of F) if (Math.abs(f[0] - r) < Math.abs(b[0] - r)) b = f;
  const W = b[0] === 1 ? w + 1 : w;
  return [W || '', b[1]].filter(Boolean).join(' ') || '1/8';
}

/** Rule 4: run fn over the parts of a line outside parentheses; text inside ( … ) is passed through untouched.
 *  An unmatched ")" opens nothing. */
export function outside(line, fn) {
  let d = 0, out = '', buf = '';
  for (const ch of line) {
    if (ch === '(') { if (d === 0) { out += fn(buf); buf = ''; } d++; out += ch; }
    else if (ch === ')' && d > 0) { d--; out += ch; }
    else if (d > 0) out += ch;
    else buf += ch;
  }
  return out + fn(buf);
}

/** The spans of a line that are outside parentheses: [{start, end}] in UTF-16 offsets. */
export function outsideSpans(line) {
  const spans = []; let d = 0, start = 0, i = 0;
  for (const ch of line) {
    if (ch === '(') { if (d === 0 && i > start) spans.push({ start, end: i }); d++; }
    else if (ch === ')' && d > 0) { d--; if (d === 0) start = i + 1; }
    i += ch.length;
  }
  if (d === 0 && i > start) spans.push({ start, end: i });
  return spans;
}

/* ── R1: quantities in ingredient lines ── */
// Units: a closed list (PATTERNS R1), with their written forms. Volume in ml, weight in g, length in cm.
const UNIT_TABLE = [
  ['tsp', 'volume', 4.92892, ['teaspoons', 'teaspoon', 'tsp']],
  ['tbsp', 'volume', 14.7868, ['tablespoons', 'tablespoon', 'tbsp']],
  ['cup', 'volume', 236.588, ['cups', 'cup']],
  ['pint', 'volume', 473.176, ['pints', 'pint']],
  ['quart', 'volume', 946.353, ['quarts', 'quart', 'qt']],
  ['gallon', 'volume', 3785.41, ['gallons', 'gallon', 'gal']],
  ['fl oz', 'volume', 29.5735, ['fl oz', 'fl. oz', 'fluid ounces', 'fluid ounce']],
  ['oz', 'weight', 28.3495, ['ounces', 'ounce', 'oz']],
  ['lb', 'weight', 453.592, ['pounds', 'pound', 'lbs', 'lb']],
  ['g', 'weight', 1, ['grams', 'gram', 'g']],
  ['kg', 'weight', 1000, ['kilograms', 'kilogram', 'kg']],
  ['ml', 'volume', 1, ['millilitres', 'milliliters', 'millilitre', 'milliliter', 'ml']],
  ['l', 'volume', 1000, ['litres', 'liters', 'litre', 'liter', 'l']],
  ['inch', 'length', 2.54, ['inches', 'inch', 'in']],
  ['cm', 'length', 1, ['cm']],
];
export const UNITS = {};
const UNIT_WORD = {};
for (const [id, dim, base, words] of UNIT_TABLE) { UNITS[id] = { id, dim, base, metric: ['g', 'kg', 'ml', 'l', 'cm'].includes(id) }; for (const w of words) UNIT_WORD[w] = id; }
const UNIT_RE = new RegExp('^([ -]?)(' + Object.keys(UNIT_WORD).sort((a, b) => b.length - a.length).map((w) => w.replace(/[.]/g, '\\.')).join('|') + ')(?![\\w])', 'i');

/** Every quantity in a line, outside parentheses, with the unit written after it (if any).
 *  → [{start, end, text, a, sep, b, lo, hi, unit, unitText, unitStart, unitEnd}] */
export function quantities(line) {
  const out = [];
  for (const span of outsideSpans(line)) {
    const part = line.slice(span.start, span.end), re = new RegExp(QTY_SRC, 'g');
    let m;
    while ((m = re.exec(part))) {
      const start = span.start + m.index, end = start + m[0].length;
      const q = { start, end, text: m[0], a: m[1], sep: m[2] || null, b: m[3] || null, lo: value(m[1]), hi: m[3] ? value(m[3]) : null, unit: null, unitText: null };
      const u = UNIT_RE.exec(line.slice(end, span.end));
      // "in" is a unit only straight after a number written as a size ("3 in", "3-in"), never the word "in" in a sentence
      if (u && !(UNIT_WORD[u[2].toLowerCase()] === 'inch' && u[2].toLowerCase() === 'in' && /^ in [a-z]/i.test(line.slice(end, end + 5)))) {
        q.unit = UNIT_WORD[u[2].toLowerCase()]; q.unitText = u[2]; q.unitStart = end + u[1].length; q.unitEnd = end + u[0].length;
      }
      out.push(q);
    }
  }
  return out;
}

/** R1 scaling, exactly as the study writes it: every quantity outside parentheses times k. */
export function scaleLine(line, k) {
  const re = new RegExp(QTY_SRC, 'g');
  return outside(line, (s) => s.replace(re, (m, a, sep, b) => fraction(value(a) * k) + (b ? sep + fraction(value(b) * k) : '')));
}

/* Units: conversion stays inside a dimension. Spoons are kept as written in both systems. */
function metricOut(v, dim) {
  if (dim === 'weight') return v >= 1000 ? { v: round1(v / 1000), u: 'kg' } : { v: roundStep(v), u: 'g' };
  if (dim === 'volume') return v >= 1000 ? { v: round1(v / 1000), u: 'l' } : { v: roundStep(v), u: 'ml' };
  return { v: v < 10 ? round1(v) : Math.round(v), u: 'cm' };
}
function usOut(v, dim) {
  if (dim === 'weight') return v >= 453.592 ? { v: v / 453.592, u: 'lb' } : { v: v / 28.3495, u: 'oz' };
  if (dim === 'volume') {
    if (v >= 3785.41) return { v: v / 3785.41, u: 'gallon' };
    if (v >= 946.353 * 1.5) return { v: v / 946.353, u: 'quart' };
    if (v >= 236.588 / 4 - 1) return { v: v / 236.588, u: 'cup' };
    return v >= 14 ? { v: v / 14.7868, u: 'tbsp' } : { v: v / 4.92892, u: 'tsp' };
  }
  return { v: v / 2.54, u: 'inch' };
}
function round1(v) { return Math.round(v * 10) / 10; }
function roundStep(v) { const s = v < 20 ? 1 : v < 100 ? 5 : v < 500 ? 10 : 25; return Math.max(1, Math.round(v / s) * s); }
function num(v) { return String(v).replace(/\.0$/, ''); }

/** One quantity, scaled by k and shown in a system ('us' | 'metric'); null when it reads exactly as written. */
export function showQuantity(q, k, system) {
  const def = q.unit ? UNITS[q.unit] : null;
  const convert = !!system && def && !(def.id === 'tsp' || def.id === 'tbsp') && ((system === 'metric' && !def.metric) || (system === 'us' && def.metric));
  if (k === 1 && !convert) return null;
  if (!convert) return { amount: fraction(q.lo * k) + (q.hi != null ? q.sep + fraction(q.hi * k) : ''), unit: null };
  const conv = (x) => (system === 'metric' ? metricOut(x * k * def.base, def.dim) : usOut(x * k * def.base, def.dim));
  const lo = conv(q.lo), hi = q.hi != null ? conv(q.hi) : null;
  const fmt = (o) => (system === 'metric' ? num(o.v) : fraction(o.v));
  const unit = (hi || lo).u;
  if (hi && hi.u !== lo.u) { const lo2 = system === 'metric' ? metricOut(q.lo * k * def.base, def.dim) : lo; return { amount: fmt(lo2) + ' ' + lo2.u + q.sep + fmt(hi), unit }; }
  return { amount: fmt(lo) + (hi ? (fmt(hi) === fmt(lo) ? '' : q.sep + fmt(hi)) : ''), unit };
}

/* ── R3: times and heat, only in a recipe's Steps ── */
const DUR_UNIT = String.raw`(?:seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)`;
const ONE = String.raw`${NUM}(?:${RNG}${NUM})?\s?${DUR_UNIT}\b`;
const DUR_SRC = String.raw`(?<![\w/.–-])${ONE}(?:\s${ONE})*`;
const ONE_RE = new RegExp(String.raw`(${NUM})(?:(${RNG})(${NUM}))?\s?(${DUR_UNIT})\b`, 'g');
const TEMP_SRC = String.raw`(\d+)\s?°\s?([FC])\b|(\d+)([FC])\b`;

function unitSeconds(u) { u = u.toLowerCase(); return u[0] === 'h' ? 3600 : u[0] === 'm' ? 60 : 1; }

/** Durations outside parentheses: [{start, end, text, seconds, extra}] — a range starts at its low end, extra is the rest. */
export function durations(line) {
  const out = [];
  for (const span of outsideSpans(line)) {
    const part = line.slice(span.start, span.end), re = new RegExp(DUR_SRC, 'g');
    let m;
    while ((m = re.exec(part))) {
      let lo = 0, hi = 0, one;
      ONE_RE.lastIndex = 0;
      while ((one = ONE_RE.exec(m[0]))) { const s = unitSeconds(one[4]); lo += value(one[1]) * s; hi += (one[3] ? value(one[3]) : value(one[1])) * s; }
      out.push({ start: span.start + m.index, end: span.start + m.index + m[0].length, text: m[0], seconds: Math.round(lo), extra: Math.round(hi - lo) });
    }
  }
  return out;
}

/** Temperatures outside parentheses: [{start, end, text, degrees, scale: 'F'|'C'}] */
export function temperatures(line) {
  const out = [];
  for (const span of outsideSpans(line)) {
    const part = line.slice(span.start, span.end), re = new RegExp(TEMP_SRC, 'g');
    let m;
    while ((m = re.exec(part))) out.push({ start: span.start + m.index, end: span.start + m.index + m[0].length, text: m[0], degrees: +(m[1] || m[3]), scale: m[2] || m[4] });
  }
  return out;
}
/** 450F → "230°C"; 220 °C → "430°F" (to the nearest 5). */
export function otherTemperature(t) {
  return t.scale === 'F' ? Math.round(((t.degrees - 32) * 5 / 9) / 5) * 5 + '°C' : Math.round((t.degrees * 9 / 5 + 32) / 5) * 5 + '°F';
}

/** "15 min", "1 h 30 min" */
export function span(seconds) {
  if (seconds < 60) return Math.round(seconds) + ' s';
  const total = Math.round(seconds / 60), h = Math.floor(total / 60), m = total % 60;
  return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
}
/** "12:05", "1:02:30" */
export function clock(seconds) {
  seconds = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

/* ── M2: votes ── */
/** "Vote: 4 for, 1 against, 0 abstain. Carried." → {for, against, abstain, counted, outcome}; null if not a Vote: line. */
export function vote(l) {
  const m = /^Vote:(.*)$/.exec(String(l).trim());
  if (!m) return null;
  const n = (w) => { const x = new RegExp('(\\d+)\\s+' + w).exec(m[1]); return x ? +x[1] : null; };
  const c = { for: n('for'), against: n('against'), abstain: n('abstain') };
  const has = Object.values(c).some((v) => v !== null);
  const rest = has ? m[1].replace(/\d+\s+(for|against|abstain\w*)[,.]?\s*/g, '').trim() : m[1].trim();
  return { ...c, counted: has, outcome: rest };
}

/* ── G3: task lines ── */
const TASK_BOX = /^\[( |x|X)\][ \t]+/;
/** The text of a list item → {done, text, owners, due} or null if it isn't a task line. */
export function task(itemText) {
  const m = TASK_BOX.exec(itemText);
  if (!m) return null;
  const text = itemText.slice(m[0].length);
  const owners = [];
  const ore = /(^|[\s,(])@([A-Za-z][\w.-]*)/g;
  let o;
  while ((o = ore.exec(text))) owners.push(o[2].replace(/[.-]+$/, ''));
  const d = /\bdue (\d{4}-\d\d-\d\d)\b/.exec(text);
  return { done: m[1] !== ' ', text, owners, due: d ? d[1] : null, dueValid: d ? !!isoDate(d[1]) : null };
}

/* ── G4: log lines ── */
/** "2026-11-13: first time" → {date, text}; null if the item doesn't start with a real ISO date. */
export function logLine(itemText) {
  const m = /^(\d{4}-\d\d-\d\d)(?=$|[:\s])(?::?\s*)([\s\S]*)$/.exec(itemText);
  if (!m || !isoDate(m[1])) return null;
  return { date: m[1], text: m[2].trim() };
}

/* ── Dates ── */
export function isoDate(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Tue 17 Nov" */
export function dayName(iso, withYear) { const d = isoDate(iso); return d ? WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + (withYear ? ' ' + d.getUTCFullYear() : '') : String(iso); }
/** "13 Nov" */
export function shortDate(iso, withYear) { const d = isoDate(iso); return d ? d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + (withYear ? ' ' + d.getUTCFullYear() : '') : String(iso); }
export function daysBetween(a, b) { const x = isoDate(a), y = isoDate(b); return x && y ? Math.round((y - x) / 864e5) : null; }
export function todayIso(now) {
  const d = now ? new Date(now) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ── G7: number tables ── */
/** A cell as a number ($ , % and spaces allowed), else null. */
export function cellNumber(s) {
  const t = String(s).replace(/[$,%\s]/g, '');
  return /^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(t) ? +t : null;
}

/* ── M1: names, split on commas outside parentheses ── */
export function names(s) {
  const out = []; let cur = '', d = 0;
  for (const c of s) { if (c === '(') d++; if (c === ')') d = Math.max(0, d - 1); if (c === ',' && !d) { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/* ── P1: ChordPro (the subset a chant chart uses) ── */
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** Parse a ChordPro body → {meta: {key, tempo, title, …}, lines: [{kind: 'comment'|'lyrics'|'blank'|'directive', text, parts: [{chord, text}]}]} */
export function chordpro(body) {
  const meta = {}, lines = [];
  for (const raw of String(body).split('\n')) {
    let rest = raw;
    // directives may share a line: {key: Am} {tempo: 72} {comment: Call} [Am]Om …
    let d;
    while ((d = /^\s*\{([a-z_]+)(?:\s*:\s*([^}]*))?\}\s*/i.exec(rest))) {
      const k = d[1].toLowerCase(), v = (d[2] || '').trim();
      if (k === 'comment' || k === 'c' || k === 'comment_italic' || k === 'ci') lines.push({ kind: 'comment', text: v });
      else if (k === 'key' || k === 'tempo' || k === 'title' || k === 't' || k === 'subtitle' || k === 'st' || k === 'time' || k === 'capo') meta[{ t: 'title', st: 'subtitle' }[k] || k] = v;
      else lines.push({ kind: 'directive', text: '{' + d[1] + (d[2] != null ? ': ' + v : '') + '}' });
      rest = rest.slice(d[0].length);
    }
    if (!rest.trim()) { if (rest === raw) lines.push({ kind: 'blank' }); continue; }
    const parts = []; const re = /\[([^\]\s]{1,12})\]/g; let at = 0, m, chord = null;
    while ((m = re.exec(rest))) { if (m.index > at || chord !== null) parts.push({ chord, text: rest.slice(at, m.index) }); chord = m[1]; at = m.index + m[0].length; }
    parts.push({ chord, text: rest.slice(at) });
    lines.push({ kind: 'lyrics', text: rest, parts: parts.filter((p, i) => p.chord !== null || p.text || i === 0) });
  }
  return { meta, lines };
}
/** Transpose one chord by n semitones: Am +2 → Bm, F#7 -1 → F7, G/B +2 → A/C#. Unknown text is kept. */
export function transpose(chord, n) {
  if (!n) return chord;
  return chord.replace(/([A-G])([#b]?)/g, (m, root, acc) => {
    let i = SHARPS.indexOf(root + (acc === '#' ? '#' : '')); if (acc === 'b') i = FLATS.indexOf(root + 'b');
    if (i < 0) return m;
    const j = (((i + n) % 12) + 12) % 12;
    return (acc === 'b' ? FLATS : SHARPS)[j];
  });
}
