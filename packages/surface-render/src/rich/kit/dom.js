// DOM helpers. Note text only ever enters the page as text: createElement + textContent, no innerHTML anywhere, and no
// attribute name or URL scheme is taken from a note. The only href the kit writes is https:, mailto: or geo:.
export const SVGNS = 'http://www.w3.org/2000/svg';

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
export function svg(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
  return n;
}
export function button(cls, text, onClick, label) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
export function setLine(n, line) { if (line) n.setAttribute('data-line', String(line)); return n; }

/** PATTERNS privacy rule 3: links only as https:, mailto: and geo: (wikilinks are handled apart). Else null. */
export function safeHref(href) {
  const h = String(href == null ? '' : href).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!h || /[\\\s<>"'`]/.test(h)) return null;
  if (/^https:\/\//i.test(h)) {
    let u; try { u = new URL(h); } catch (e) { return null; }
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  }
  if (/^mailto:[^/?#][^\s]*$/i.test(h)) return h;
  if (/^geo:-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?([,;][\w.=;-]*)?$/i.test(h)) return h;
  return null;
}

/** A blob: or data:image/ URL handed back by the host for an attachment; anything else is refused. */
export function safeImageUrl(u) {
  const s = String(u || '');
  return /^blob:/i.test(s) || /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(s) ? s : null;
}

export function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce), (update: slow)').matches; } catch (e) { return false; }
}
