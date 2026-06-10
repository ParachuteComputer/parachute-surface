/**
 * Round-trip invariants — through the BYTES, both directions.
 *
 * `f(x) === f(x)` proves nothing. The pinned invariants are:
 *  - md → doc → md: `emit(parse(md))` is byte-stable for canonical input,
 *    and reaches a byte-stable fixpoint by the SECOND pass for any input
 *    (`emit(parse(emit(parse(md)))) === emit(parse(md))`).
 *  - doc → md → doc: `parse(emit(doc))` is structurally equal to `doc`
 *    (ProseMirror `Node.eq`).
 */
import { describe, expect, test } from "bun:test";
import { docToMarkdown, markdownToDoc } from "../index";

/** Already in the codec's canonical form: emit(parse(md)) === md, byte-equal. */
const CANONICAL_FIXTURES: Record<string, string> = {
  "heading levels": "# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6",
  paragraphs: "First paragraph.\n\nSecond paragraph.",
  "bullet list (tight)": "- alpha\n- beta\n- gamma",
  "nested bullet list": "- parent\n  - child\n  - sibling\n- aunt",
  "ordered list": "1. first\n2. second\n3. third",
  "ordered list with start": "3. third\n4. fourth",
  "task list": "- [ ] open\n- [x] done",
  "nested task list": "- [ ] parent\n  - [x] child",
  "task list under bullet list": "- plain\n  - [ ] task below",
  "loose list item with two paragraphs": "- first block\n\n  second block",
  "fenced code with language": "```ts\nconst x: number = 1;\n```",
  "fenced code without language": "```\nplain text code\n```",
  "code with backticks inside": "````\nuses ``` inside\n````",
  blockquote: "> quoted line",
  "nested blockquote": "> outer\n>\n> > inner",
  "horizontal rule": "above\n\n---\n\nbelow",
  "inline marks": "Some **bold** and *italic* and ~~struck~~ and `code` text.",
  link: "A [link](https://example.com) here.",
  "link with title": 'A [link](https://example.com "the title") here.',
  autolink: "Go to <https://example.com> now.",
  image: "![alt text](https://example.com/img.png)",
  "image with title": '![alt](https://example.com/i.png "caption")',
  "hard break": "line one\\\nline two",
  "escaped literal brackets": "array\\[0\\] and \\[not a link\\]",
  "mixed task markers stay literal": "- \\[ \\] looks like a task\n- but this item is not",
  unicode: "Emoji 🎈 and accents — café, naïve.",
};

/** Not canonical — these settle to a fixpoint on pass 2 (pass1 !== input). */
const NON_CANONICAL_FIXTURES: Record<string, string> = {
  "setext heading": "Title\n=====\n\nbody",
  "star bullets": "* one\n* two",
  "plus bullets": "+ one\n+ two",
  "loose list collapses tight": "- one\n\n- two",
  "indented code becomes fenced": "    indented code\n",
  "underscore emphasis": "_italic_ and __bold__",
  "soft break joins": "line one\nline two",
  "paren ordered list": "1) first\n2) second",
  "asterisk hr": "***",
};

describe("md → doc → md (canonical byte stability)", () => {
  for (const [name, md] of Object.entries(CANONICAL_FIXTURES)) {
    test(name, () => {
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    });
  }
});

describe("md → doc → md (fixpoint by second pass)", () => {
  for (const [name, md] of Object.entries({ ...CANONICAL_FIXTURES, ...NON_CANONICAL_FIXTURES })) {
    test(name, () => {
      const pass1 = docToMarkdown(markdownToDoc(md));
      const pass2 = docToMarkdown(markdownToDoc(pass1));
      expect(pass2).toBe(pass1);
    });
  }
});

describe("doc → md → doc (structural equality)", () => {
  for (const [name, md] of Object.entries({ ...CANONICAL_FIXTURES, ...NON_CANONICAL_FIXTURES })) {
    test(name, () => {
      const doc = markdownToDoc(md);
      const reparsed = markdownToDoc(docToMarkdown(doc));
      expect(reparsed.eq(doc)).toBe(true);
    });
  }
});

describe("edges", () => {
  test("empty input → empty doc → empty output", () => {
    const doc = markdownToDoc("");
    expect(doc.childCount).toBe(1); // schema requires block+ → one empty paragraph
    expect(docToMarkdown(doc)).toBe("");
  });

  test("trailing newline is not significant", () => {
    expect(markdownToDoc("# Hi\n").eq(markdownToDoc("# Hi"))).toBe(true);
  });
});
