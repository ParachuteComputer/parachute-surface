/**
 * The reconciliation boundary, THROUGH THE BYTES (doc-schema discipline:
 * `f(x) === f(parse(emit(x)))`, never `f(x) === f(x)`):
 *
 *   markdown ─seed→ Y.Doc ─serialize→ markdown
 *
 * Pins:
 *   - canonical markdown survives md → Y.Doc → md BYTE-IDENTICAL;
 *   - any markdown reaches a byte-stable fixpoint by the second pass
 *     (canonicalization happens once, then stability);
 *   - the Y.Doc leg is equivalent to the pure codec leg (the CRDT
 *     carrier adds no drift);
 *   - re-seeding the SAME doc (external-edit-wins path) replaces content
 *     without duplication, differentially (unchanged spans keep CRDT
 *     identity);
 *   - serialize → seed round-trips CRDT-built content into stable bytes.
 */

import { describe, expect, test } from "bun:test";
import { docToMarkdown, markdownToDoc } from "@openparachute/doc-schema";
import * as Y from "yjs";
import { DOC_FRAGMENT, seedDocFromMarkdown, serializeDocToMarkdown } from "../codec.ts";

/** One full pass across the CRDT carrier. */
function throughYDoc(markdown: string): string {
  const doc = new Y.Doc();
  seedDocFromMarkdown(doc, markdown);
  return serializeDocToMarkdown(doc);
}

const CANONICAL_FIXTURES: Array<{ name: string; md: string }> = [
  { name: "plain paragraph", md: "Hello, world." },
  {
    name: "headings + structure",
    md: "# Title\n\nSome *italic* and **bold** and `code`.\n\n## Section\n\n> A quote\n\n---\n\nDone.",
  },
  {
    name: "lists incl. tasks",
    md: "- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done",
  },
  {
    name: "code fence with language",
    md: '```ts\nconst x: string = "verbatim  spacing";\n```',
  },
  {
    name: "links, images, strike",
    md: "A [link](https://example.com) and ![alt](https://example.com/i.png) and ~~gone~~.",
  },
  {
    name: "wikilinks stay verbatim next to escapes",
    md: "See [[Target Note]] and [[other|alias]] while array\\[0\\] stays escaped.",
  },
  { name: "unicode", md: "Emoji 🎉 and accents — café, naïve." },
];

describe("md → Y.Doc → md (the seed/serialize boundary)", () => {
  for (const { name, md } of CANONICAL_FIXTURES) {
    test(`canonical input is byte-stable: ${name}`, () => {
      // Pin that the fixture IS canonical (guards the fixture itself).
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
      // The CRDT carrier preserves the same bytes.
      expect(throughYDoc(md)).toBe(md);
    });

    test(`Y.Doc leg ≡ pure codec leg: ${name}`, () => {
      expect(throughYDoc(md)).toBe(docToMarkdown(markdownToDoc(md)));
    });
  }

  test("non-canonical input converges to a byte-stable fixpoint", () => {
    const messy = "Title\n=====\n\n* star bullet\n+ plus bullet\n\n_underscore emphasis_\n";
    // The Y.Doc carrier tracks the pure codec byte-for-byte at EVERY pass…
    const once = throughYDoc(messy);
    expect(once).toBe(docToMarkdown(markdownToDoc(messy)));
    const twice = throughYDoc(once);
    expect(twice).toBe(docToMarkdown(markdownToDoc(once)));
    // …and the second pass IS the fixpoint: pass three is byte-identical.
    expect(throughYDoc(twice)).toBe(twice);
  });

  test("empty markdown round-trips to a stable form", () => {
    const once = throughYDoc("");
    expect(throughYDoc(once)).toBe(once);
  });
});

describe("re-seed (external-edit-wins) semantics", () => {
  test("re-seeding the SAME doc replaces content — never duplicates", () => {
    const doc = new Y.Doc();
    seedDocFromMarkdown(doc, "# One\n\nfirst body");
    seedDocFromMarkdown(doc, "# Two\n\nsecond body");
    const out = serializeDocToMarkdown(doc);
    expect(out).toBe("# Two\n\nsecond body");
    expect(out).not.toContain("first body");
    // Triple-check through the bytes: a fresh parse agrees.
    expect(throughYDoc(out)).toBe(out);
  });

  test("differential re-seed keeps CRDT identity of unchanged blocks", () => {
    const doc = new Y.Doc();
    seedDocFromMarkdown(doc, "# Stable\n\nkeep me\n\nchange me");
    const fragment = doc.getXmlFragment(DOC_FRAGMENT);
    const keepNode = fragment.get(1); // the "keep me" paragraph
    seedDocFromMarkdown(doc, "# Stable\n\nkeep me\n\nchanged!");
    // The unchanged paragraph is the SAME Y type instance — connected
    // clients' cursors inside it survive the re-seed.
    expect(fragment.get(1)).toBe(keepNode);
    expect(serializeDocToMarkdown(doc)).toBe("# Stable\n\nkeep me\n\nchanged!");
  });

  test("seed runs inside an enclosing transaction without splitting it", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });
    const ORIGIN = Symbol("test-origin");
    doc.transact(() => {
      seedDocFromMarkdown(doc, "# In one transaction");
    }, ORIGIN);
    // Exactly one update, carrying the OUTER origin — the reconciler's
    // atomic-swap guarantee depends on this.
    expect(origins).toEqual([ORIGIN]);
  });
});

describe("CRDT-built content serializes through the shared schema", () => {
  test("a paragraph appended Yjs-side lands as canonical markdown", () => {
    const doc = new Y.Doc();
    seedDocFromMarkdown(doc, "# Doc");
    const fragment = doc.getXmlFragment(DOC_FRAGMENT);
    doc.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("typed by a client")]);
      fragment.insert(fragment.length, [paragraph]);
    });
    const out = serializeDocToMarkdown(doc);
    expect(out).toBe("# Doc\n\ntyped by a client");
    // Bytes again: parse(emit) is stable.
    expect(throughYDoc(out)).toBe(out);
  });
});
