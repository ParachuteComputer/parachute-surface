import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("returns empty data when no fence opens the document", () => {
    const out = parseFrontmatter("just a body\nno frontmatter");
    expect(out.data).toEqual({});
    expect(out.content).toBe("just a body\nno frontmatter");
  });

  it("treats an unclosed fence as content (lossless fallback)", () => {
    const raw = "---\nid: 123\nstill open...";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({});
    expect(out.content).toBe(raw);
  });

  it("parses simple key/value scalars", () => {
    const out = parseFrontmatter("---\nid: abc\ntitle: Hello\n---\nbody here");
    expect(out.data).toEqual({ id: "abc", title: "Hello" });
    expect(out.content).toBe("body here");
  });

  it("parses inline tag arrays", () => {
    const out = parseFrontmatter("---\ntags: [work, idea, follow-up]\n---\n");
    expect(out.data).toEqual({ tags: ["work", "idea", "follow-up"] });
  });

  it("parses block-form tag arrays", () => {
    const raw = "---\ntags:\n  - work\n  - idea\n  - follow-up\n---\nbody";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({ tags: ["work", "idea", "follow-up"] });
    expect(out.content).toBe("body");
  });

  it("parses zero-indent block-form tag arrays (Obsidian Properties panel shape)", () => {
    // Obsidian's Properties panel emits block arrays at zero indent, e.g.
    //   tags:
    //   - work
    //   - idea
    // Previously the parser gated block-array detection on `peek.indent > 0`
    // and silently dropped these into an empty-string value, which
    // `mergeTags` then dissolved with no error surfaced. Reviewer-caught
    // on #47.
    const raw = "---\ntags:\n- work\n- idea\n---\nbody";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({ tags: ["work", "idea"] });
    expect(out.content).toBe("body");
  });

  it("respects quoted strings (commas + special chars)", () => {
    const raw = "---\ntitle: \"Hello, world\"\nnote: 'don''t panic'\n---\nx";
    const out = parseFrontmatter(raw);
    expect(out.data.title).toBe("Hello, world");
    expect(out.data.note).toBe("don't panic");
  });

  it("respects quoted strings inside inline arrays", () => {
    const out = parseFrontmatter('---\ntags: [a, "b, c", d]\n---\n');
    expect(out.data.tags).toEqual(["a", "b, c", "d"]);
  });

  it("preserves type for booleans, null, numbers", () => {
    const raw = "---\npinned: true\narchived: false\nrank: 7\nratio: 0.5\nempty: null\n---\nx";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({
      pinned: true,
      archived: false,
      rank: 7,
      ratio: 0.5,
      empty: null,
    });
  });

  it("keeps ISO date strings as strings (round-trip cleanly to vault)", () => {
    const out = parseFrontmatter("---\ncreated_at: 2024-05-01T10:00:00Z\n---\nx");
    expect(out.data.created_at).toBe("2024-05-01T10:00:00Z");
  });

  it("handles CRLF line endings (Windows-authored Obsidian zips)", () => {
    // The canonical line-scan (alignment contract §1.1) splits on /\r?\n/
    // and rejoins the body with `\n`, so a CRLF body normalizes to LF.
    // This matches the vault CLI's body join exactly — required for zero
    // parse-tier drift between the two importers.
    const out = parseFrontmatter("---\r\nid: w1\r\ntags: [a]\r\n---\r\nbody\r\nline2");
    expect(out.data).toEqual({ id: "w1", tags: ["a"] });
    expect(out.content).toBe("body\nline2");
  });

  it("skips comments and blank lines inside the frontmatter block", () => {
    const raw = "---\n# top comment\nid: c1\n\n  # indented comment\ntitle: ok\n---\nbody";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({ id: "c1", title: "ok" });
  });

  it("does not eat content past the close fence", () => {
    const raw = "---\nid: x\n---\nfirst line\n---\nstill body";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({ id: "x" });
    // The second `---` is a markdown horizontal rule — it must survive.
    expect(out.content).toBe("first line\n---\nstill body");
  });

  it("returns content trimmed of one leading newline only", () => {
    // Vault writes a single newline after the close fence; preserve any
    // user-authored blank line after that as part of the body.
    const out = parseFrontmatter("---\nid: a\n---\n\nbody with leading blank");
    expect(out.content).toBe("\nbody with leading blank");
  });
});

/**
 * Obsidian alignment contract — frontmatter-tier canonical fixtures (§3).
 * Same inputs + expected values the vault CLI parser asserts, proving
 * convergence on the fence-scan + YAML-subset layer.
 */
describe("alignment contract fixtures — frontmatter tier", () => {
  it("FX-FENCE-BOM — strips a leading UTF-8 BOM before matching the open fence", () => {
    const out = parseFrontmatter("﻿---\nid: bom1\ntags: [a]\n---\nhello");
    expect(out.data).toEqual({ id: "bom1", tags: ["a"] });
    expect(out.content).toBe("hello");
  });

  it("FX-FENCE-FOURDASH — `----` body line is not the close fence", () => {
    const out = parseFrontmatter("---\nid: x9\n---\nbefore\n----\nafter");
    expect(out.data).toEqual({ id: "x9" });
    expect(out.content).toBe("before\n----\nafter");
  });

  it("FX-FENCE-FOURDASH-OPEN — `----` after open with no real close → unclosed", () => {
    const raw = "---\nid: y\n----\nbody text";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({});
    expect(out.content).toBe(raw);
  });

  it("FX-FENCE-UNCLOSED — open, never closed → whole file is content", () => {
    const raw = "---\nid: z\nbody no close";
    const out = parseFrontmatter(raw);
    expect(out.data).toEqual({});
    expect(out.content).toBe(raw);
  });

  it("FX-INLINE-ARRAY — quote-aware split keeps the quoted comma as one item", () => {
    const out = parseFrontmatter('---\nkeywords: ["a, b", c]\n---\nx');
    expect(out.data).toEqual({ keywords: ["a, b", "c"] });
    expect(out.content).toBe("x");
  });

  it("FX-CRLF — CRLF frontmatter parses and the body keeps its endings", () => {
    const out = parseFrontmatter("---\r\nid: cr1\r\ntags: [a]\r\n---\r\nbody");
    expect(out.data).toEqual({ id: "cr1", tags: ["a"] });
    expect(out.content).toBe("body");
  });

  it("FX-DOTTED-KEY — dotted frontmatter key accepted, not confused with created_at", () => {
    const out = parseFrontmatter("---\ncreated.at: 2024\nid: dk1\n---\nx");
    expect(out.data).toEqual({ "created.at": 2024, id: "dk1" });
    expect(out.content).toBe("x");
  });

  it("FX-COMMENT-LINE — `#`-comment inside the block is skipped", () => {
    const out = parseFrontmatter("---\n# a yaml comment\nid: cm1\n---\nbody");
    expect(out.data).toEqual({ id: "cm1" });
    expect(out.content).toBe("body");
  });
});
