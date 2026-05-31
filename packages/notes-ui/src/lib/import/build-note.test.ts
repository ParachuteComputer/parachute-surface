import { describe, expect, it } from "vitest";
import { buildParsedNote, normalizePath } from "./build-note";

describe("buildParsedNote", () => {
  it("falls back to sourcePath (minus extension) when frontmatter has no path", () => {
    const note = buildParsedNote({ sourcePath: "Projects/Foo.md", raw: "body" });
    expect(note.path).toBe("Projects/Foo");
    expect(note.content).toBe("body");
    expect(note.tags).toEqual([]);
  });

  it("respects an explicit frontmatter path (overrides filename)", () => {
    const note = buildParsedNote({
      sourcePath: "old/location.md",
      raw: "---\npath: new/spot\n---\nbody",
    });
    expect(note.path).toBe("new/spot");
  });

  it("normalizes Windows separators to forward slashes", () => {
    const note = buildParsedNote({
      sourcePath: "Projects\\Foo\\Bar.md",
      raw: "body",
    });
    expect(note.path).toBe("Projects/Foo/Bar");
  });

  it("strips .markdown as well as .md", () => {
    const note = buildParsedNote({ sourcePath: "Note.markdown", raw: "x" });
    expect(note.path).toBe("Note");
  });

  it("hoists id + createdAt from frontmatter into first-class fields", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      raw: "---\nid: abc-123\ncreated_at: 2024-05-01T10:00:00Z\n---\nbody",
    });
    expect(note.id).toBe("abc-123");
    expect(note.createdAt).toBe("2024-05-01T10:00:00Z");
    // The hoisted keys must NOT survive in metadata.
    expect(note.metadata).not.toHaveProperty("id");
    expect(note.metadata).not.toHaveProperty("created_at");
  });

  it("accepts createdAt as an alternative spelling", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      raw: "---\ncreatedAt: 2024-05-01\n---\nbody",
    });
    expect(note.createdAt).toBe("2024-05-01");
  });

  it("merges frontmatter array tags + inline hashtags, deduped and lowercased", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      raw: "---\ntags: [Work, idea]\n---\nbody with #Work and a new #journal tag",
    });
    expect(note.tags.sort()).toEqual(["idea", "journal", "work"]);
  });

  it("strips leading '#' from frontmatter tag values (Obsidian quirk)", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      raw: "---\ntags:\n  - '#work'\n  - '#idea'\n---\nbody",
    });
    expect(note.tags.sort()).toEqual(["idea", "work"]);
  });

  it("accepts string-form tags (comma- or space-separated)", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      raw: "---\ntags: work, idea, follow-up\n---\nbody",
    });
    expect(note.tags.sort()).toEqual(["follow-up", "idea", "work"]);
  });

  it("rejects malformed tag values (preserves vault's tag regex)", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      // `bad tag` has a space, `inv@lid` has a special char — both dropped.
      // `valid_tag/sub` survives (slash is allowed for hierarchy).
      raw: "---\ntags: [valid_tag/sub, 'bad tag', 'inv@lid', ok]\n---\nbody",
    });
    expect(note.tags.sort()).toEqual(["ok", "valid_tag/sub"]);
  });

  it("preserves wikilinks in the body untouched", () => {
    const raw = "---\nid: x\n---\nSee [[Other Note]] and [[Folder/Nested]] for details.";
    const note = buildParsedNote({ sourcePath: "x.md", raw });
    expect(note.content).toContain("[[Other Note]]");
    expect(note.content).toContain("[[Folder/Nested]]");
  });

  it("stuffs non-hoisted frontmatter keys into metadata verbatim", () => {
    const note = buildParsedNote({
      sourcePath: "x.md",
      raw: "---\nid: x\nsummary: A short note\npinned: true\nrank: 7\n---\nbody",
    });
    expect(note.metadata).toEqual({ summary: "A short note", pinned: true, rank: 7 });
  });
});

describe("normalizePath", () => {
  it("collapses double slashes", () => {
    expect(normalizePath("a//b///c")).toBe("a/b/c");
  });
  it("trims leading and trailing slashes", () => {
    expect(normalizePath("/foo/bar/")).toBe("foo/bar");
  });
  it("preserves case and unicode", () => {
    expect(normalizePath("Notes/日記/Today")).toBe("Notes/日記/Today");
  });
});

/**
 * Obsidian alignment contract — shared canonical fixtures (§3).
 *
 * These assert the EXACT expected values from
 * `/tmp/obsidian-alignment-contract.md`. The parallel vault CLI parser
 * asserts the same expected values against the same inputs, so passing
 * both suites proves the two importers converge on the parse tier.
 * Abstract `body` column → web `content`; `metadata` column → web
 * `metadata`. "—" in the contract = field absent/omitted.
 */
describe("alignment contract fixtures — parse tier (build-note)", () => {
  it("FX-FENCE-BOM — BOM-prefixed file parses frontmatter", () => {
    const note = buildParsedNote({
      sourcePath: "Note.md",
      raw: "﻿---\nid: bom1\ntags: [a]\n---\nhello",
    });
    expect(note.path).toBe("Note");
    expect(note.tags.sort()).toEqual(["a"]);
    expect(note.id).toBe("bom1");
    expect(note.createdAt).toBeUndefined();
    expect(note.content).toBe("hello");
    expect(note.metadata).toEqual({});
  });

  it("FX-FENCE-FOURDASH — `----` body line is not a close fence", () => {
    const note = buildParsedNote({
      sourcePath: "Doc.md",
      raw: "---\nid: x9\n---\nbefore\n----\nafter",
    });
    expect(note.path).toBe("Doc");
    expect(note.tags).toEqual([]);
    expect(note.id).toBe("x9");
    expect(note.content).toBe("before\n----\nafter");
    expect(note.metadata).toEqual({});
  });

  it("FX-FENCE-FOURDASH-OPEN — `----` right after open, no real close → whole file is body", () => {
    const raw = "---\nid: y\n----\nbody text";
    const note = buildParsedNote({ sourcePath: "D2.md", raw });
    expect(note.path).toBe("D2");
    expect(note.tags).toEqual([]);
    expect(note.id).toBeUndefined();
    expect(note.content).toBe(raw);
    expect(note.metadata).toEqual({});
  });

  it("FX-FENCE-UNCLOSED — open, never closed → whole file is body", () => {
    const raw = "---\nid: z\nbody no close";
    const note = buildParsedNote({ sourcePath: "U.md", raw });
    expect(note.path).toBe("U");
    expect(note.tags).toEqual([]);
    expect(note.id).toBeUndefined();
    expect(note.content).toBe(raw);
    expect(note.metadata).toEqual({});
  });

  it("FX-CODE-TAG — #tag inside fenced + inline code is NOT extracted", () => {
    const raw = "#realtag at top\n\n`#inlinenope`\n\n```\n#fencednope\n```\n";
    const note = buildParsedNote({ sourcePath: "C.md", raw });
    expect(note.path).toBe("C");
    expect(note.tags.sort()).toEqual(["realtag"]);
    expect(note.content).toBe(raw);
    expect(note.metadata).toEqual({});
  });

  it("FX-NUMERIC-TAG — #2024 is not a tag; #q3 / #v2 are", () => {
    const note = buildParsedNote({
      sourcePath: "N.md",
      raw: "plan #2024 and #q3 and #v2 done",
    });
    expect(note.path).toBe("N");
    expect(note.tags.sort()).toEqual(["q3", "v2"]);
    expect(note.metadata).toEqual({});
  });

  it("FX-HIER-TAG — hierarchical inline tag keeps the full slash path", () => {
    const note = buildParsedNote({ sourcePath: "H.md", raw: "see #area/subarea here" });
    expect(note.path).toBe("H");
    expect(note.tags.sort()).toEqual(["area/subarea"]);
    expect(note.metadata).toEqual({});
  });

  it("FX-FM-TAGS-VALIDATE — frontmatter tag validation + slug-validate", () => {
    const note = buildParsedNote({
      sourcePath: "T.md",
      raw: '---\ntags: [Foo, "bad tag!", 42, true, ok-1, "#hash"]\n---\nbody',
    });
    expect(note.path).toBe("T");
    expect(note.tags.sort()).toEqual(["42", "foo", "hash", "ok-1", "true"]);
    expect(note.content).toBe("body");
    expect(note.metadata).toEqual({});
  });

  it("FX-INLINE-ARRAY — quoted comma in inline array → 2 items, lands in metadata", () => {
    const note = buildParsedNote({
      sourcePath: "IA.md",
      raw: '---\nkeywords: ["a, b", c]\n---\nx',
    });
    expect(note.path).toBe("IA");
    expect(note.tags).toEqual([]);
    expect(note.content).toBe("x");
    expect(note.metadata).toEqual({ keywords: ["a, b", "c"] });
  });

  it("FX-MARKDOWN-EXT — .markdown source strips to a clean path", () => {
    const note = buildParsedNote({
      sourcePath: "Folder/Note.markdown",
      raw: "---\nid: m1\n---\nbody",
    });
    expect(note.path).toBe("Folder/Note");
    expect(note.tags).toEqual([]);
    expect(note.id).toBe("m1");
    expect(note.content).toBe("body");
    expect(note.metadata).toEqual({});
  });

  it("FX-PATH-OVERRIDE — frontmatter path: wins; path not in metadata", () => {
    const note = buildParsedNote({
      sourcePath: "deep/orig.md",
      raw: "---\npath: Custom/Place\n---\nbody",
    });
    expect(note.path).toBe("Custom/Place");
    expect(note.tags).toEqual([]);
    expect(note.id).toBeUndefined();
    expect(note.content).toBe("body");
    expect(note.metadata).toEqual({});
  });

  it("FX-PATH-NORMALIZE — backslash + collapse + trim, case preserved", () => {
    const note = buildParsedNote({
      sourcePath: "X.md",
      // frontmatter `path: \Win\Path\\x\`
      raw: '---\npath: "\\\\Win\\\\Path\\\\\\\\x\\\\"\n---\nb',
    });
    expect(note.path).toBe("Win/Path/x");
    expect(note.content).toBe("b");
    expect(note.metadata).toEqual({});
  });

  it("FX-CREATED-AT — created_at + updated_at hoisted verbatim, not in metadata", () => {
    const note = buildParsedNote({
      sourcePath: "CA.md",
      raw: "---\nid: t1\ncreated_at: 2024-05-01T10:00:00Z\nupdated_at: 2024-06-01T12:00:00Z\n---\nbody",
    });
    expect(note.path).toBe("CA");
    expect(note.id).toBe("t1");
    expect(note.createdAt).toBe("2024-05-01T10:00:00Z");
    expect(note.updatedAt).toBe("2024-06-01T12:00:00Z");
    expect(note.content).toBe("body");
    expect(note.metadata).toEqual({});
  });

  it("FX-CREATED-AT-CAMEL — camelCase createdAt fallback", () => {
    const note = buildParsedNote({
      sourcePath: "CC.md",
      raw: "---\ncreatedAt: 2024-05-01T10:00:00Z\n---\nx",
    });
    expect(note.path).toBe("CC");
    expect(note.createdAt).toBe("2024-05-01T10:00:00Z");
    expect(note.metadata).toEqual({});
  });

  it("FX-NO-ID — id absent → field omitted", () => {
    const note = buildParsedNote({
      sourcePath: "NI.md",
      raw: "---\ntitle: Hello\n---\nbody",
    });
    expect(note.path).toBe("NI");
    expect(note.id).toBeUndefined();
    expect(note.tags).toEqual([]);
    expect(note.content).toBe("body");
    expect(note.metadata).toEqual({ title: "Hello" });
  });

  it("FX-WIKILINK-PASSTHROUGH — wikilinks untouched, inline #tag still extracted", () => {
    const note = buildParsedNote({
      sourcePath: "WL.md",
      raw: "See [[Other]] and ![[Embed]] and #tag",
    });
    expect(note.content).toContain("[[Other]]");
    expect(note.content).toContain("![[Embed]]");
    expect(note.tags.sort()).toEqual(["tag"]);
    expect(note.metadata).toEqual({});
  });

  it("FX-CRLF — CRLF frontmatter parses, body has no fence", () => {
    const note = buildParsedNote({
      sourcePath: "CR.md",
      raw: "---\r\nid: cr1\r\ntags: [a]\r\n---\r\nbody",
    });
    expect(note.path).toBe("CR");
    expect(note.id).toBe("cr1");
    expect(note.tags.sort()).toEqual(["a"]);
    expect(note.content).toBe("body");
    expect(note.metadata).toEqual({});
  });

  it("FX-NO-FRONTMATTER — plain markdown, inline tag only", () => {
    const raw = "# Title\n\nbody with #tag";
    const note = buildParsedNote({ sourcePath: "P.md", raw });
    expect(note.path).toBe("P");
    expect(note.id).toBeUndefined();
    expect(note.tags.sort()).toEqual(["tag"]);
    expect(note.content).toBe(raw);
    expect(note.metadata).toEqual({});
  });

  it("FX-METADATA-EXCLUSIONS — all seven hoisted keys excluded from metadata", () => {
    const note = buildParsedNote({
      sourcePath: "M.md",
      raw: "---\nid: i\npath: P/Q\ntags: [t]\ncreated_at: 2024\ncreatedAt: 2024\nupdated_at: 2024\nupdatedAt: 2024\nextra: keep\n---\nb",
    });
    expect(note.path).toBe("P/Q");
    expect(note.id).toBe("i");
    expect(note.tags.sort()).toEqual(["t"]);
    expect(note.createdAt).toBe("2024");
    expect(note.updatedAt).toBe("2024");
    expect(note.content).toBe("b");
    expect(note.metadata).toEqual({ extra: "keep" });
  });
});
