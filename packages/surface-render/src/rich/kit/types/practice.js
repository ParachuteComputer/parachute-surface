// Practice chart (tag `chant`): P1 the ```chordpro block (chords over syllables, a transpose control), P2 the minutes
// in the Practice log summed by week. Goals are G3; the log itself is G4.
import { el, button, setLine } from '../dom.js';
import * as R from '../rules.js';
import { weeks } from '../charts.js';

const LOG = ['practice log', 'practice'], GOALS = ['goals'];

function read(doc, walk) {
  const charts = walk.tokens.filter((t) => t.type === 'fence' && (t.info || '').trim().split(/\s+/)[0].toLowerCase() === 'chordpro')
    .map((t) => { const c = R.chordpro(t.content); return { line: t.map[0] + 1, key: c.meta.key || null, tempo: c.meta.tempo || null, parts: c.lines.filter((l) => l.kind === 'comment').map((l) => l.text) }; });
  const log = doc.log.filter((l) => LOG.includes(l.section)).map((l) => { const d = R.durations(l.text)[0]; return { date: l.date, minutes: d ? Math.round(d.seconds / 60) : null }; });
  return { charts, log, minutes: log.reduce((a, l) => a + (l.minutes || 0), 0), days: new Set(log.map((l) => l.date)).size };
}

/** P1: a ChordPro body drawn as chords over their syllables. Transposing is a sitting. */
function chordpro(content, v, line) {
  const c = R.chordpro(content);
  const fig = setLine(el('figure', 'rn-chordpro'), line);
  const head = el('figcaption', 'rn-chordpro-head');
  const key = el('span', 'rn-chordpro-key');
  head.appendChild(key);
  if (c.meta.tempo) head.appendChild(el('span', 'rn-chordpro-tempo', c.meta.tempo + ' bpm'));
  const tr = el('span', 'rn-seg'); tr.setAttribute('role', 'group'); tr.setAttribute('aria-label', 'Transpose');
  const down = button('rn-seg-btn', '♭', () => { v.state.transpose--; paint(); }, 'Down a semitone');
  const shown = el('output', 'rn-serves');
  const up = button('rn-seg-btn', '♯', () => { v.state.transpose++; paint(); }, 'Up a semitone');
  tr.appendChild(down); tr.appendChild(shown); tr.appendChild(up);
  head.appendChild(tr);
  fig.appendChild(head);
  const body = el('div', 'rn-chordpro-body');
  fig.appendChild(body);
  function paint() {
    const n = v.state.transpose;
    key.textContent = c.meta.key ? 'Key ' + R.transpose(c.meta.key, n) : 'Chords';
    shown.textContent = n ? (n > 0 ? '+' : '−') + Math.abs(n) : '0';
    body.textContent = '';
    for (const l of c.lines) {
      if (l.kind === 'comment') body.appendChild(el('p', 'rn-chordpro-part', l.text));
      else if (l.kind === 'blank') body.appendChild(el('div', 'rn-chordpro-gap'));
      else if (l.kind === 'directive') body.appendChild(el('p', 'rn-chordpro-dir', l.text));
      else {
        const row = el('p', 'rn-chordpro-line');
        for (const p of l.parts) {
          const seg = el('span', 'rn-cp-seg');
          seg.appendChild(el('span', 'rn-cp-chord', p.chord ? R.transpose(p.chord, n) : ' '));
          seg.appendChild(el('span', 'rn-cp-text', p.text || ' '));
          row.appendChild(seg);
        }
        body.appendChild(row);
      }
    }
  }
  paint();
  return fig;
}

function draw(v) {
  const p = v.doc.chant;
  if (p.days) {
    const last = p.log.map((l) => l.date).sort().pop();
    v.hero.appendChild(el('p', 'rn-summary-line', 'Practised ' + p.days + (p.days === 1 ? ' day' : ' days') + (p.minutes ? ' · ' + p.minutes + ' min in all' : '') + ' · last on ' + R.shortDate(last)));
  }
  const sec = v.section(LOG);
  if (!sec) return;
  const chart = weeks(p.log);
  if (chart) sec.appendChild(chart);
  if (v.canSave()) {
    const form = el('div', 'rn-log-today');
    const input = el('input', 'rn-minutes'); input.type = 'number'; input.min = '1'; input.max = '600'; input.inputMode = 'numeric'; input.setAttribute('aria-label', 'Minutes practised today');
    const b = button('rn-btn rn-btn-quiet', 'Log today', () => { const n = parseInt(input.value, 10); b.disabled = true; v.appendLog(['Practice log', 'Practice'], isFinite(n) && n > 0 ? n + ' min' : ''); });
    b.setAttribute('data-writes', '');
    form.appendChild(el('span', 'rn-hint', 'Today:')); form.appendChild(input); form.appendChild(el('span', 'rn-hint', 'min')); form.appendChild(b);
    sec.appendChild(form);
  }
}

export default {
  tag: 'chant',
  sections: { log: LOG, goals: GOALS },
  facts: ['source', 'verified'],
  logs: LOG,
  fences: { chordpro },
  fact(key, value) { if (key === 'verified' && R.isoDate(String(value))) return { label: 'Checked against a recording', text: R.shortDate(String(value), true) }; return undefined; },
  read, draw,
};
