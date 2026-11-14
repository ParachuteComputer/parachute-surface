// Timers are a sitting: memory only, gone when the view closes. Computed from the clock, not counted, so a timer that
// was in the background is right when it comes back. A timer never shows note text: "Step 6", "Timer done".
// Calm screens (host.calm, or a slow or reduced-motion display) redraw each minute, and each 10 s in the last minute.
import { el, button } from './dom.js';
import { clock, span } from './rules.js';

export function createTimers(host, calm) {
  const list = []; let tick = null, audio = null, seq = 0;
  const tray = el('div', 'rn-tray');
  tray.setAttribute('role', 'region'); tray.setAttribute('aria-label', 'Timers'); tray.hidden = true;
  const listeners = new Set();
  const now = () => (host && typeof host.now === 'function' ? host.now() : Date.now());
  const left = (t) => (t.state === 'running' ? (t.endAt - now()) / 1000 : t.left);

  function chime() {
    try {
      if (!audio) return;
      const t0 = audio.currentTime;
      [660, 880].forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + i * 0.35);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + i * 0.35 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.35 + 0.9);
        o.connect(g).connect(audio.destination); o.start(t0 + i * 0.35); o.stop(t0 + i * 0.35 + 1);
      });
    } catch (e) { /* no sound here; the tray still says Done */ }
    try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) { /* none */ }
  }
  function cadence() {
    if (!calm()) return 1000;
    const soonest = Math.min(...list.filter((t) => t.state === 'running').map(left));
    return soonest <= 60 ? 10000 : 60000;
  }
  function schedule() {
    clearTimeout(tick); tick = null;
    if (!list.some((t) => t.state === 'running')) return;
    const soonest = Math.min(...list.filter((t) => t.state === 'running').map(left));
    tick = setTimeout(loop, Math.max(50, Math.min(cadence(), soonest * 1000 + 30)));
  }
  function loop() {
    for (const t of list) if (t.state === 'running' && left(t) <= 0) { t.state = 'done'; t.left = 0; chime(); }
    draw(); schedule();
  }
  function show(t) {
    const s = left(t);
    if (t.state === 'done') return 'Done';
    if (calm() && t.state === 'running') return s > 60 ? Math.ceil(s / 60) + ' min' : clock(Math.ceil(s / 10) * 10);
    return clock(s);
  }
  function draw() {
    tray.textContent = '';
    tray.hidden = !list.length;
    for (const t of list) {
      const row = el('div', 'rn-tray-row is-' + t.state);
      row.appendChild(el('span', 'rn-tray-mark'));
      row.appendChild(el('span', 'rn-tray-label', t.state === 'done' ? 'Timer done · ' + t.label : t.label));
      row.appendChild(el('span', 'rn-tray-time', show(t)));
      if (t.state !== 'done') row.appendChild(button('rn-tray-btn', t.state === 'running' ? 'Pause' : 'Go on', () => toggle(t.id)));
      else if (t.extra) row.appendChild(button('rn-tray-btn', '+' + span(t.extra), () => more(t.id), 'Add ' + span(t.extra) + ', the rest of the range'));
      row.appendChild(button('rn-tray-btn', t.state === 'done' ? 'Clear' : 'Stop', () => cancel(t.id)));
      tray.appendChild(row);
    }
    listeners.forEach((f) => { try { f(); } catch (e) { /* a view's own redraw */ } });
  }
  function find(key) { return list.find((t) => t.key === key) || null; }
  function start(key, label, seconds, extra) {
    try { if (!audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); } if (audio && audio.state === 'suspended') audio.resume(); } catch (e) { audio = null; }
    let t = find(key);
    if (t && t.state !== 'done') { toggle(t.id); return t; }
    if (t) list.splice(list.indexOf(t), 1);
    t = { id: ++seq, key, label, total: seconds, extra: extra || 0, endAt: now() + seconds * 1000, left: seconds, state: 'running' };
    list.push(t); draw(); schedule();
    return t;
  }
  function toggle(id) {
    for (const t of list) if (t.id === id) {
      if (t.state === 'running') { t.left = left(t); t.state = 'paused'; }
      else if (t.state === 'paused') { t.endAt = now() + t.left * 1000; t.state = 'running'; }
    }
    draw(); schedule();
  }
  function more(id) { for (const t of list) if (t.id === id && t.state === 'done') { t.endAt = now() + t.extra * 1000; t.state = 'running'; t.extra = 0; } draw(); schedule(); }
  function cancel(id) { const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); draw(); schedule(); }
  function stopAll() { list.length = 0; clearTimeout(tick); tick = null; try { if (audio) audio.close(); } catch (e) { /* closed */ } audio = null; draw(); }
  return { tray, start, toggle, cancel, find, more, stopAll, left, show, onChange: (f) => { listeners.add(f); return () => listeners.delete(f); }, list: () => list.slice(), redraw: loop };
}
