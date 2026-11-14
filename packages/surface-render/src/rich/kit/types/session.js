// Session note (tag `session`): no reading rules of its own (PATTERNS). The view sets the client's words as pull quotes,
// says who owes what, shows the plan's progress and puts the check-ins chart first. What matters most is what the
// renderer never does, for every note: no network, nothing stored, no note text outside the page.
import { el } from '../dom.js';
import * as R from '../rules.js';

const WORDS = ['in their words'], OWED = ['owed'], PLAN = ['plan'], CHECK = ['check-ins', 'check ins', 'checkins'];

function read(doc) {
  const owed = doc.tasks.filter((t) => OWED.includes(t.section));
  const plan = doc.tasks.filter((t) => PLAN.includes(t.section));
  return {
    owed: owed.map((t) => ({ line: t.line, done: t.done, owners: t.owners, due: t.due })),
    plan: { steps: plan.length, done: plan.filter((t) => t.done).length },
  };
}

function draw(v) {
  const d = v.doc, s = d.session;
  if (d.fact('date')) v.kicker.textContent = R.dayName(String(d.fact('date')), true);
  // their words, set apart
  const words = v.section(WORDS);
  if (words) words.querySelectorAll(':scope > blockquote').forEach((q) => q.classList.add('rn-pull'));
  // who owes what
  const owed = v.section(OWED);
  if (owed && s.owed.length) {
    const by = new Map();
    for (const t of s.owed) { const who = t.owners[0] || 'someone'; if (!by.has(who)) by.set(who, { open: 0, done: 0, late: 0 }); const b = by.get(who); if (t.done) b.done++; else { b.open++; if (t.due && R.daysBetween(t.due, v.today()) > 0) b.late++; } }
    const line = el('p', 'rn-summary-line');
    line.textContent = [...by].map(([who, b]) => (who === 'me' ? 'You owe ' : '@' + who + ' owes ') + b.open + (b.late ? ' (' + b.late + ' late)' : '')).join(' · ');
    owed.querySelector('.rn-section-head').after(line);
  }
  // the plan's progress
  const plan = v.section(PLAN);
  if (plan && s.plan.steps) {
    const bar = el('div', 'rn-progress'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', s.plan.done + ' of ' + s.plan.steps + ' done');
    for (let i = 0; i < s.plan.steps; i++) bar.appendChild(el('i', i < s.plan.done ? 'is-done' : null));
    bar.appendChild(el('span', 'rn-progress-words', s.plan.done + ' of ' + s.plan.steps + ' done'));
    plan.querySelector('.rn-section-head').after(bar);
  }
}

export default {
  tag: 'session',
  sections: { words: WORDS, owed: OWED, plan: PLAN, checkins: CHECK },
  facts: ['client', 'session', 'date', 'next'],
  chartsFirst: CHECK,
  fact(key, value) {
    if (key === 'date') return null; // it leads the page
    if (key === 'next' && R.isoDate(String(value))) return { label: 'Next session', text: R.dayName(String(value)) };
    return undefined;
  },
  read, draw,
};
