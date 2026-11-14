// Types are registered layers. A type adds names and one or two reading rules; it never adds a mark (PATTERNS).
//   {tag, sections: {role: [names…]}, facts: [keys shown first], read(doc, walk) (pure), draw(view) (DOM)}
export const types = new Map();

export function registerType(def) {
  if (!def || typeof def.tag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.tag)) throw new TypeError('a type needs a lower-case tag');
  types.set(def.tag, Object.freeze({ sections: {}, facts: [], ...def }));
  return def.tag;
}

/** The note's type: what the host names, else the first of its tags that is a registered type. */
export function typeOf(tags, named) {
  if (named) return types.has(String(named).toLowerCase()) ? String(named).toLowerCase() : null;
  for (const t of tags) if (types.has(t)) return t;
  return null;
}
