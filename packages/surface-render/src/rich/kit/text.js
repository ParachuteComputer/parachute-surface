// Lines and the paste-fallback front matter. Pure.

/** Split text the way markdown-it does (\r\n, \r or \n), keeping each line's own ending so an edit can put it back. */
export function splitLines(text) {
  const parts = String(text).split(/(\r\n|\r|\n)/), lines = [], ends = [];
  for (let i = 0; i < parts.length; i += 2) { lines.push(parts[i]); ends.push(parts[i + 1] || ''); }
  return { lines, ends };
}
export function joinLines(lines, ends) { return lines.map((l, i) => l + (ends[i] || '')).join(''); }

/** The usual line ending of a text. */
export function eolOf(text) { const m = /\r\n|\r|\n/.exec(String(text)); return m ? m[0] : '\n'; }

/**
 * A YAML block at the top of the content (PATTERNS G1: read only for keys the metadata lacks; never written).
 * A small subset: `key: value`, `key: [a, b]`, `key:` followed by `  - item` lines, quoted strings.
 * → {data, end} where `end` is the number of lines the block takes (0 if there is none).
 */
export function frontMatter(lines) {
  if (lines[0] !== '---') return { data: {}, end: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---' || lines[i] === '...') { end = i; break; }
  if (end < 0) return { data: {}, end: 0 };
  const data = {}; let last = null;
  for (let j = 1; j < end; j++) {
    const line = lines[j]; let m;
    if (line.length <= 4000 && (m = /^([A-Za-z_][\w-]*(?: [\w-]+)*) *: *(.*)$/.exec(line))) {
      last = m[1].trim();
      data[last] = m[2].trim() === '' ? [] : yamlValue(m[2]);
    } else if ((m = /^\s+-\s+(.*)$/.exec(line)) && last) {
      if (!Array.isArray(data[last])) data[last] = data[last] === '' ? [] : [data[last]];
      data[last].push(yamlValue(m[1]));
    }
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k]) && !data[k].length) data[k] = '';
  return { data, end: end + 1 };
}
function yamlValue(v) {
  v = v.trim();
  if (!/^(['"]).*\1$/.test(v)) v = v.replace(/\s+#.*$/, '');
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter((s) => s !== '');
  const u = unquote(v);
  if (u !== v) return u;
  if (/^-?\d+(\.\d+)?$/.test(v)) return +v;
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
function unquote(s) { const m = /^(['"])(.*)\1$/.exec(s); return m ? m[2] : s; }

/** The five entities a <summary> may carry, decoded; everything else stays as written. */
export function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }[e]));
}
