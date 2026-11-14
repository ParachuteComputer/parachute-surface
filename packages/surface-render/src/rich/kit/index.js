// rich-notes-kit: plain markdown notes, rendered alive. Implements PATTERNS.md v0.3.
//   parse(note)            → doc       pure; runs in Node with no DOM (a linter for agents: doc.warnings)
//   mount(el, doc, host)   → handle    one note into one element; no network, ever
//   render(el, note, host) → handle    parse + mount
//   edit.toggleTask / edit.appendLog   one-line content edits → {content, patch}
//   needsRich(doc)         → boolean   does the note use a pattern only the rich view draws?
//   registerType(def)                  a typed view; recipe, minutes, session and chant ship registered
import { parse, RULE_TEXT } from './parse.js';
import { mount, plainText } from './mount.js';
import { toggleTask, appendLog } from './edit.js';
import { registerType, types } from './registry.js';
import * as rules from './rules.js';
import recipe from './types/recipe.js';
import minutes from './types/minutes.js';
import session from './types/session.js';
import practice from './types/practice.js';

[recipe, minutes, session, practice].forEach(registerType);

export const version = '0.4.0';
export const contract = 'PATTERNS v0.3';
export const edit = Object.freeze({ toggleTask, appendLog });
export function render(el, note, host) { return mount(el, parse(note, { type: host && host.view }), host); }
/** A type, tasks (G3), a log (G4), a callout (G5), <details> (G6) or a chartable table (G7). Facts (G1) and sections (G2)
 *  alone don't count: nearly every note has them. A host draws a note richly only when this says so, and every host
 *  draws the same line. */
export function needsRich(doc) {
  if (!(doc && doc.kind === 'rich-note')) doc = parse(doc); // a note or a string works too
  return !!( (doc.type || doc.tasks.length || doc.log.length || doc.callouts.length || doc.details.length || doc.tables.some((t) => t.chart)));
}
export function typeNames() { return [...types.keys()]; }
export { parse, mount, plainText, registerType, rules, RULE_TEXT };
