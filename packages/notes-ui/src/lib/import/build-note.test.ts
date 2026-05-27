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
