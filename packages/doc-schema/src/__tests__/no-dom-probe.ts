/**
 * Subprocess probe for isomorphism.test.ts — NOT a test file.
 *
 * Booby-traps the DOM globals BEFORE importing the codec entry, then
 * exercises the full markdown ⇄ doc surface. Any touch of document/window/
 * HTMLElement/customElements at import time or during codec work throws and
 * the process exits non-zero. Run directly: `bun src/__tests__/no-dom-probe.ts`.
 */
const TRAPPED = ["document", "window", "HTMLElement", "Element", "customElements"] as const;

for (const name of TRAPPED) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`DOM global "${name}" was touched — the codec graph must be DOM-free`);
    },
  });
}

const {
  markdownToDoc,
  markdownToDocJSON,
  docFromJSON,
  docToMarkdown,
  createTextQuoteSelector,
  resolveTextQuoteSelector,
  schema,
} = await import("../index");

const md =
  "# Probe\n\n- [x] task with [[wiki]] and [link](https://example.com)\n\n```ts\ncode\n```";
const doc = markdownToDoc(md);
const out = docToMarkdown(doc);
if (out !== md) throw new Error(`round trip drifted:\n${out}`);
const json = markdownToDocJSON(md);
if (!docFromJSON(json).eq(doc)) throw new Error("JSON rehydration drifted");
const sel = createTextQuoteSelector(doc, 3, 8);
if (!sel || resolveTextQuoteSelector(doc, sel) === null) throw new Error("anchors failed");
if (!schema.nodes.taskItem) throw new Error("schema missing taskItem");

console.log("NO-DOM-PROBE-OK");
