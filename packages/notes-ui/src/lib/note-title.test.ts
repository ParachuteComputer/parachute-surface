import { describe, expect, it } from "vitest";
import { leadingH1, noteTitle, pathLeaf, stripLeadingH1 } from "./note-title";

describe("noteTitle", () => {
  it("prefers a leading H1 in the content", () => {
    expect(noteTitle({ id: "a", content: "# Meeting notes\n\nbody" })).toBe("Meeting notes");
  });

  it("uses the first prose line when the H1 is buried (consistent with the body strip)", () => {
    // Strict-first-line: a `# …` that isn't the leading line is NOT the title,
    // so NoteView never titles a note by a heading that still renders in-body.
    expect(noteTitle({ id: "a", content: "intro line\n\n# The heading\n\nmore" })).toBe(
      "intro line",
    );
  });

  it("uses the first non-empty line when there is no H1", () => {
    expect(noteTitle({ id: "a", content: "Hello world\n\nmore text" })).toBe("Hello world");
  });

  it("strips leading markdown heading hashes on the first-line fallback", () => {
    expect(noteTitle({ id: "a", content: "### Deep" })).toBe("Deep");
  });

  it("skips leading blank lines", () => {
    expect(noteTitle({ id: "a", content: "\n\n\nfirst real line" })).toBe("first real line");
  });

  it("truncates a very long first line with an ellipsis", () => {
    const long = "x".repeat(200);
    const title = noteTitle({ id: "a", content: long });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to the last path segment without .md", () => {
    expect(noteTitle({ id: "abc", path: "Canon/Aaron.md" })).toBe("Aaron");
    expect(noteTitle({ id: "abc", path: "notes/journal/day.md" })).toBe("day");
  });

  it("strips .md case-insensitively", () => {
    expect(noteTitle({ id: "abc", path: "Foo.MD" })).toBe("Foo");
  });

  it("falls back to id when there is nothing else", () => {
    expect(noteTitle({ id: "abc" })).toBe("abc");
  });

  it("prefers content over path when both exist", () => {
    expect(noteTitle({ id: "x", path: "Some/Path.md", content: "Content wins" })).toBe(
      "Content wins",
    );
  });
});

describe("leadingH1", () => {
  it("returns the H1 text when it's the leading line", () => {
    expect(leadingH1("# Title\n\nbody")).toBe("Title");
    expect(leadingH1("\n\n# Title\nbody")).toBe("Title");
  });

  it("returns null when the first non-blank line is prose (a buried H1 is not a title)", () => {
    expect(leadingH1("prose\n# Later")).toBeNull();
  });

  it("returns null when the leading line opens a fenced code block", () => {
    // A `# comment` inside a code fence must not become the title.
    expect(leadingH1("```\n# comment\n```")).toBeNull();
  });

  it("ignores h2+ headings", () => {
    expect(leadingH1("## Not a title")).toBeNull();
    expect(leadingH1("### Deep")).toBeNull();
  });

  it("returns null for empty or missing content", () => {
    expect(leadingH1("")).toBeNull();
    expect(leadingH1(undefined)).toBeNull();
    expect(leadingH1(null)).toBeNull();
  });
});

describe("stripLeadingH1", () => {
  it("removes a leading H1 and the blank lines around it", () => {
    expect(stripLeadingH1("# Title\n\nHello.")).toBe("Hello.");
  });

  it("removes a leading H1 preceded by blank lines", () => {
    expect(stripLeadingH1("\n\n# Title\nbody")).toBe("body");
  });

  it("leaves content without a leading H1 untouched", () => {
    expect(stripLeadingH1("Just prose.\n# Later heading")).toBe("Just prose.\n# Later heading");
    expect(stripLeadingH1("## Subheading first")).toBe("## Subheading first");
  });
});

describe("pathLeaf", () => {
  it("returns the last segment without .md", () => {
    expect(pathLeaf("a/b/c.md")).toBe("c");
    expect(pathLeaf("bare")).toBe("bare");
  });
});
