/**
 * The wikilink serializer rule (design doc open question, resolved here):
 * prosemirror-markdown escapes `[`/`]` by default, which would corrupt
 * `[[wikilinks]]` into `\[\[wikilinks\]\]`. The codec's text serializer
 * protects `[[...]]` spans verbatim while ordinary bracket text keeps its
 * escaping (so it never becomes a link on re-parse).
 */
import { describe, expect, test } from "bun:test";
import { docToMarkdown, markdownToDoc, wikilinkPattern } from "../index";

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

describe("wikilinks survive docToMarkdown verbatim", () => {
  test("bare wikilink", () => {
    expect(roundTrip("[[Some Note]]")).toBe("[[Some Note]]");
  });

  test("wikilink with alias pipe", () => {
    expect(roundTrip("See [[Some Note|the note]] today.")).toBe(
      "See [[Some Note|the note]] today.",
    );
  });

  test("wikilink with path and heading anchor", () => {
    expect(roundTrip("[[Folder/Note#Section]]")).toBe("[[Folder/Note#Section]]");
  });

  test("multiple wikilinks in one paragraph", () => {
    expect(roundTrip("[[One]] then [[Two]] then [[Three]]")).toBe(
      "[[One]] then [[Two]] then [[Three]]",
    );
  });

  test("wikilink inside heading", () => {
    expect(roundTrip("# About [[Some Note]]")).toBe("# About [[Some Note]]");
  });

  test("wikilink inside list item and task item", () => {
    expect(roundTrip("- read [[Some Note]]\n\n1. then [[Other]]")).toBe(
      "- read [[Some Note]]\n\n1. then [[Other]]",
    );
    expect(roundTrip("- [ ] review [[Draft]]")).toBe("- [ ] review [[Draft]]");
  });

  test("wikilink wrapped in marks", () => {
    expect(roundTrip("**[[Bolded Note]]**")).toBe("**[[Bolded Note]]**");
  });
});

describe("wikilinks adjacent to ordinary links", () => {
  test("wikilink before a markdown link", () => {
    const md = "[[Wiki Note]] and [real link](https://example.com)";
    expect(roundTrip(md)).toBe(md);
  });

  test("markdown link before a wikilink", () => {
    const md = "[real link](https://example.com) and [[Wiki Note]]";
    expect(roundTrip(md)).toBe(md);
  });

  test("immediately adjacent, no space", () => {
    const md = "[[Wiki]][also](https://example.com)";
    expect(roundTrip(md)).toBe(md);
  });
});

describe("literal brackets still escape (no link conjuring on re-parse)", () => {
  test("array indexing escapes and stays text", () => {
    const out = roundTrip("array[0]");
    expect(out).toBe("array\\[0\\]");
    // and the escaped form is byte-stable + still plain text
    expect(roundTrip(out)).toBe(out);
    expect(markdownToDoc(out).child(0).textContent).toBe("array[0]");
  });

  test("bracketed phrase that is not a link", () => {
    const out = roundTrip("[not a link]");
    expect(out).toBe("\\[not a link\\]");
    expect(markdownToDoc(out).child(0).textContent).toBe("[not a link]");
  });

  test("unbalanced double-open brackets are NOT a wikilink", () => {
    const out = roundTrip("a [[dangling");
    expect(out).toBe("a \\[\\[dangling");
    expect(markdownToDoc(out).child(0).textContent).toBe("a [[dangling");
  });

  test("empty double brackets are NOT a wikilink", () => {
    const out = roundTrip("[[]]");
    expect(out).toBe("\\[\\[\\]\\]");
  });

  test("literal brackets NEXT TO a wikilink keep their escaping", () => {
    const out = roundTrip("x[1] then [[Note]] then [y]");
    expect(out).toBe("x\\[1\\] then [[Note]] then \\[y\\]");
    expect(roundTrip(out)).toBe(out);
  });
});

describe("wikilinks through the full loop", () => {
  test("doc → md → doc structural equality with mixed brackets", () => {
    const doc = markdownToDoc("[[A|alias]] beside [b](https://c.d) and e[5]");
    expect(markdownToDoc(docToMarkdown(doc)).eq(doc)).toBe(true);
  });
});

describe("wikilinkPattern factory", () => {
  test("matches the serializer's wikilink syntax", () => {
    const re = wikilinkPattern();
    expect(re.test("[[Some Note]]")).toBe(true);
    expect(wikilinkPattern().test("[[A|alias]]")).toBe(true);
    expect(wikilinkPattern().test("[[]]")).toBe(false); // empty — not a wikilink
    expect(wikilinkPattern().test("[[dangling")).toBe(false);
  });

  test("returns a FRESH global RegExp per call — no shared lastIndex state", () => {
    const a = wikilinkPattern();
    const b = wikilinkPattern();
    expect(a).not.toBe(b);
    expect(a.global).toBe(true);
    // A stateful .test() on one instance must not affect the other — and
    // must never affect the serializer (which holds its own instance).
    a.test("[[One]] [[Two]]");
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(b.lastIndex).toBe(0);
    // The serializer stays correct even after downstream .test()/.exec() use.
    expect(roundTrip("[[One]] then [[Two]]")).toBe("[[One]] then [[Two]]");
  });
});
