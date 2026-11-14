// Minutes (tag `minutes`): M1 attendance against the quorum, M2 votes as a tally with the outcome as written.
// Decisions and actions are G3, discussion is G6, the budget is G7: the kit's.
import { el, button } from '../dom.js';
import * as R from '../rules.js';
import { tally } from '../charts.js';

const ATT = ['attendance'], MOT = ['motions'], DEC = ['decisions'], ACT = ['actions'];

function read(doc, walk) {
  const attendance = walk.itemsIn(walk.section(ATT)).filter((it) => it.top).map((it) => {
    const m = /^([^:\n]{1,40}):\s*([\s\S]*)$/.exec(it.text);
    return m ? { line: it.line, label: m[1].trim(), names: R.names(m[2].replace(/\n/g, ' ')) } : null;
  }).filter(Boolean);
  const present = attendance.filter((a) => /^present$/i.test(a.label)).reduce((n, a) => n + a.names.length, 0);
  const q = parseInt(String(doc.fact('quorum') == null ? '' : doc.fact('quorum')), 10);
  const motions = walk.itemsIn(walk.section(MOT)).filter((it) => it.top).map((it) => {
    const lines = it.text.split('\n');
    let v = null;
    lines.forEach((l, k) => { const x = R.vote(l); if (x) { v = { ...x, lineIndex: k }; if (!x.counted) walk.warn(it.line + k, 'M2-no-counts'); } });
    return { line: it.line, lines, vote: v };
  });
  const decisions = walk.itemsIn(walk.section(DEC)).filter((it) => it.top).length;
  const actions = doc.tasks.filter((t) => ACT.includes(t.section));
  return { attendance, present, quorum: isFinite(q) ? q : null, motions, decisions, actions: { count: actions.length, done: actions.filter((a) => a.done).length } };
}

function draw(v) {
  const d = v.doc, m = d.minutes, st = v.state;
  v.kicker.textContent = [d.fact('body'), d.fact('date') ? R.dayName(String(d.fact('date')), true) : null].filter(Boolean).join(' · ');
  const sum = el('p', 'rn-summary-line');
  const bits = [];
  if (m.attendance.length) bits.push(m.present + ' present' + (m.quorum ? (m.present >= m.quorum ? ' · quorum of ' + m.quorum + ' met' : ' · short of the quorum of ' + m.quorum) : ''));
  if (m.decisions) bits.push(m.decisions + (m.decisions === 1 ? ' decision' : ' decisions'));
  if (m.motions.length) bits.push(m.motions.length + (m.motions.length === 1 ? ' motion' : ' motions'));
  if (m.actions.count) bits.push(m.actions.count + (m.actions.count === 1 ? ' action' : ' actions') + ', ' + m.actions.done + ' done');
  sum.textContent = bits.join(' · ');
  if (bits.length) v.hero.appendChild(sum);

  /* M1: names as chips, grouped by their label */
  for (const a of m.attendance) {
    const li = v.at('li', a.line); if (!li) continue;
    const kind = /^present$/i.test(a.label) ? 'in' : /^(regrets|absent|apologies)$/i.test(a.label) ? 'out' : 'other';
    li.textContent = ''; li.classList.add('rn-roll-row');
    li.appendChild(el('span', 'rn-roll-label', a.label));
    const ul = el('ul', 'rn-roll');
    a.names.forEach((n) => { const x = el('li', 'is-' + kind); x.appendChild(el('span', 'rn-roll-mark')); x.appendChild(el('span', null, n)); ul.appendChild(x); });
    li.appendChild(ul);
    li.parentElement.classList.add('rn-roll-list');
  }

  /* M2: a motion card: its lines as written, a tally, the outcome beside it as written */
  for (const mo of m.motions) {
    const li = v.at('li', mo.line); if (!li || !mo.vote || !mo.vote.counted) continue;
    li.classList.add('rn-motion');
    const keep = mo.lines.filter((_, k) => k !== mo.vote.lineIndex);
    const body = el('div', 'rn-motion-text');
    keep.forEach((l, k) => body.appendChild(el('p', k ? 'rn-motion-by' : null, l)));
    const row = el('div', 'rn-motion-vote');
    row.appendChild(tally(mo.vote));
    if (mo.vote.outcome) row.appendChild(el('span', 'rn-outcome', mo.vote.outcome));
    li.textContent = ''; li.appendChild(body); li.appendChild(row);
  }

  /* actions: who has what */
  const act = v.section(ACT);
  const lis = act ? [...act.querySelectorAll('li.rn-task')] : [];
  const owners = [...new Set(lis.map((li) => (li.getAttribute('data-owner') || '').split(' ')[0]).filter(Boolean))];
  if (owners.length > 1) {
    const bar = el('div', 'rn-people'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Show the actions of');
    const pick = (o) => { st.who = o; apply(); };
    const apply = () => {
      bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-who') === (st.who || ''))));
      lis.forEach((li) => { li.hidden = !!st.who && (li.getAttribute('data-owner') || '').split(' ').indexOf(st.who) < 0; });
    };
    ['', ...owners].forEach((o) => {
      const n = o ? lis.filter((li) => (li.getAttribute('data-owner') || '').split(' ').includes(o)).length : lis.length;
      const b = button('rn-chip', (o ? '@' + o : 'Everyone') + ' ' + n, () => pick(o));
      b.setAttribute('data-who', o); bar.appendChild(b);
    });
    act.querySelector('.rn-section-head').after(bar);
    apply();
  }
}

export default {
  tag: 'minutes',
  sections: { attendance: ATT, motions: MOT, decisions: DEC, actions: ACT },
  facts: ['chair', 'scribe', 'next', 'quorum', 'body', 'date'],
  fact(key, value) {
    if (key === 'body' || key === 'date') return null; // they lead the page, in the line above the title
    if (key === 'quorum' && isFinite(parseInt(String(value), 10))) return null; // read against attendance
    if (key === 'next' && R.isoDate(String(value))) return { label: 'Next meeting', text: R.dayName(String(value), true) };
    return undefined;
  },
  read, draw,
};
