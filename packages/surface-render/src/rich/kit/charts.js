// Small pictures drawn from what a note already says. One ink, labels on the marks, no legends; series told apart by
// line style as well as tone, so every chart holds in greyscale. Numbers only ever reach an attribute as numbers.
import { el, svg } from './dom.js';
import { cellNumber, isoDate, shortDate, daysBetween } from './rules.js';

const W = 320, H = 132, PAD = { l: 8, r: 8, t: 18, b: 22 };
const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100));
const DASH = ['', '6 4', '2 3', '10 3 2 3'];

/** G7: one small chart per number column of a table. Dates in column one draw lines over time; labels draw bars. */
export function tableCharts(table) {
  const wrap = el('div', 'rn-charts');
  let series = table.numeric.filter((c) => c > 0);
  const labelsFromRows = !series.length; // only column one is numbers: bars labelled by row
  if (labelsFromRows) series = [0];
  series.forEach((c, si) => {
    const pts = table.rows.map((r, i) => ({ label: labelsFromRows ? String(i + 1) : r[0], date: table.dates ? r[0] : null, v: cellNumber(r[c]) }));
    wrap.appendChild(table.dates && !labelsFromRows ? lineChart(table.head[c], pts, si) : barChart(table.head[c], pts));
  });
  return wrap;
}

function frame(title, summary) {
  const fig = el('figure', 'rn-chart');
  const cap = el('figcaption');
  cap.appendChild(el('span', 'rn-chart-title', title));
  if (summary) cap.appendChild(el('span', 'rn-chart-sum', summary));
  fig.appendChild(cap);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rn-chart-svg', role: 'img' });
  fig.appendChild(s);
  return { fig, s };
}

function lineChart(title, pts, si) {
  const ok = pts.filter((p) => p.v != null && isoDate(p.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = ok[0], last = ok[ok.length - 1];
  const { fig, s } = frame(title, first && last && ok.length > 1 ? fmt(first.v) + ' → ' + fmt(last.v) : null);
  s.setAttribute('aria-label', title + ': ' + ok.map((p) => shortDate(p.date) + ' ' + fmt(p.v)).join(', '));
  const t0 = isoDate(first.date).getTime(), t1 = isoDate(last.date).getTime(), span = Math.max(1, t1 - t0);
  let lo = Math.min(...ok.map((p) => p.v)), hi = Math.max(...ok.map((p) => p.v));
  if (lo === hi) { lo -= 1; hi += 1; }
  const padV = (hi - lo) * 0.15; lo -= padV; hi += padV;
  const x = (p) => PAD.l + 14 + ((isoDate(p.date).getTime() - t0) / span) * (W - PAD.l - PAD.r - 28);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  s.appendChild(svg('line', { x1: PAD.l, x2: W - PAD.r, y1: H - PAD.b, y2: H - PAD.b, class: 'rn-axis' }));
  s.appendChild(svg('polyline', { points: ok.map((p) => x(p).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' '), class: 'rn-line', 'stroke-dasharray': DASH[si % DASH.length] || null }));
  ok.forEach((p, i) => {
    s.appendChild(svg('circle', { cx: x(p).toFixed(1), cy: y(p.v).toFixed(1), r: 3.2, class: 'rn-dot' }));
    if (ok.length <= 14) { const t = svg('text', { x: x(p).toFixed(1), y: (y(p.v) - 7).toFixed(1), class: 'rn-val', 'text-anchor': 'middle' }); t.textContent = fmt(p.v); s.appendChild(t); }
    if (i === 0 || i === ok.length - 1) { const d = svg('text', { x: x(p).toFixed(1), y: H - 6, class: 'rn-lab', 'text-anchor': i === 0 ? 'start' : 'end' }); d.textContent = shortDate(p.date); s.appendChild(d); }
  });
  return fig;
}

function barChart(title, pts) {
  const ok = pts.filter((p) => p.v != null);
  const total = ok.reduce((a, p) => a + p.v, 0);
  const { fig, s } = frame(title, ok.length > 1 ? 'total ' + fmt(total) : null);
  s.setAttribute('aria-label', title + ': ' + ok.map((p) => p.label + ' ' + fmt(p.v)).join(', '));
  const max = Math.max(0, ...ok.map((p) => p.v)), min = Math.min(0, ...ok.map((p) => p.v));
  const n = pts.length, slot = (W - PAD.l - PAD.r) / Math.max(1, n), bw = Math.min(46, slot * 0.62);
  const y = (v) => PAD.t + (1 - (v - min) / ((max - min) || 1)) * (H - PAD.t - PAD.b);
  pts.forEach((p, i) => {
    const cx = PAD.l + slot * (i + 0.5);
    if (p.v != null) {
      const top = y(Math.max(p.v, 0)), bot = y(Math.min(p.v, 0));
      s.appendChild(svg('rect', { x: (cx - bw / 2).toFixed(1), y: top.toFixed(1), width: bw.toFixed(1), height: Math.max(1, bot - top).toFixed(1), class: 'rn-bar' }));
      const t = svg('text', { x: cx.toFixed(1), y: (top - 4).toFixed(1), class: 'rn-val', 'text-anchor': 'middle' }); t.textContent = fmt(p.v); s.appendChild(t);
    }
    const lab = svg('text', { x: cx.toFixed(1), y: H - 6, class: 'rn-lab', 'text-anchor': 'middle' });
    lab.textContent = String(p.label).length > 12 ? String(p.label).slice(0, 11) + '…' : String(p.label);
    s.appendChild(lab);
  });
  s.appendChild(svg('line', { x1: PAD.l, x2: W - PAD.r, y1: y(0).toFixed(1), y2: y(0).toFixed(1), class: 'rn-axis' }));
  return fig;
}

/** M2: a tally of a vote. One square per vote (for: filled, against: open, abstain: dotted), the counts in words. */
export function tally(v) {
  const box = el('div', 'rn-tally');
  const words = [v.for != null ? v.for + ' for' : null, v.against != null ? v.against + ' against' : null, v.abstain != null ? v.abstain + ' abstain' : null].filter(Boolean).join(' · ');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', words);
  const n = (v.for || 0) + (v.against || 0) + (v.abstain || 0);
  if (n > 0 && n <= 60) {
    const sq = el('span', 'rn-tally-squares');
    [['for', v.for], ['against', v.against], ['abstain', v.abstain]].forEach(([k, c]) => { for (let i = 0; i < (c || 0); i++) sq.appendChild(el('i', 'rn-sq is-' + k)); });
    box.appendChild(sq);
  }
  box.appendChild(el('span', 'rn-tally-words', words));
  return box;
}

/** G4: the days something was done, as dots on a line from the first to today. */
export function strip(dates, today) {
  const ds = [...new Set(dates.filter((d) => isoDate(d)))].sort();
  const fig = el('div', 'rn-strip');
  if (!ds.length) return fig;
  const end = today && today > ds[ds.length - 1] ? today : ds[ds.length - 1];
  const total = Math.max(1, daysBetween(ds[0], end));
  const s = svg('svg', { viewBox: '0 0 300 30', class: 'rn-strip-svg', role: 'img', 'aria-label': ds.length + (ds.length === 1 ? ' day' : ' days') + ', ' + shortDate(ds[0], true) + ' to ' + shortDate(end, true) });
  s.appendChild(svg('line', { x1: 6, x2: 294, y1: 12, y2: 12, class: 'rn-axis' }));
  ds.forEach((d) => s.appendChild(svg('circle', { cx: (6 + (daysBetween(ds[0], d) / total) * 288).toFixed(1), cy: 12, r: 4, class: 'rn-dot' })));
  const a = svg('text', { x: 6, y: 28, class: 'rn-lab', 'text-anchor': 'start' }); a.textContent = shortDate(ds[0]);
  const b = svg('text', { x: 294, y: 28, class: 'rn-lab', 'text-anchor': 'end' }); b.textContent = end === today ? 'today' : shortDate(end);
  s.appendChild(a); if (ds.length > 1 || end !== ds[0]) s.appendChild(b);
  fig.appendChild(s);
  return fig;
}

/** P2: minutes per week (weeks start on Monday), as labelled bars. */
export function weeks(entries) {
  const byWeek = new Map();
  for (const e of entries) {
    const d = isoDate(e.date); if (!d || !e.minutes) continue;
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
    byWeek.set(monday, (byWeek.get(monday) || 0) + e.minutes);
  }
  const keys = [...byWeek.keys()].sort();
  if (!keys.length) return null;
  const pts = keys.map((k) => ({ label: 'wk of ' + shortDate(k), v: byWeek.get(k) }));
  const fig = barChart('Minutes a week', pts);
  fig.classList.add('rn-weeks');
  return fig;
}
