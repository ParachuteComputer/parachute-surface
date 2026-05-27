import { describe, expect, it } from "vitest";
import { parseLooseMarkdown } from "./loose";

function makeFile(name: string, body: string, relativePath?: string): File {
  const f = new File([body], name, { type: "text/markdown" });
  if (relativePath) {
    // webkitRelativePath is a read-only File property the directory-picker
    // populates. Override it with a defineProperty so our fixtures can
    // exercise the in-folder-layout code path.
    Object.defineProperty(f, "webkitRelativePath", {
      value: relativePath,
      writable: false,
    });
  }
  return f;
}

describe("parseLooseMarkdown", () => {
  it("uses the filename (without extension) as the path when no frontmatter", async () => {
    const result = await parseLooseMarkdown([makeFile("Hello World.md", "body")]);
    expect(result.format).toBe("loose-markdown");
    expect(result.notes[0]?.path).toBe("Hello World");
    expect(result.notes[0]?.content).toBe("body");
  });

  it("uses webkitRelativePath when a folder was picked", async () => {
    const result = await parseLooseMarkdown([makeFile("Note.md", "body", "MyFolder/Note.md")]);
    expect(result.notes[0]?.path).toBe("MyFolder/Note");
  });

  it("parses frontmatter into tags + id + metadata across files", async () => {
    const result = await parseLooseMarkdown([
      makeFile("a.md", "---\nid: id-a\ntags: [work]\n---\nbody"),
      makeFile("b.md", "---\ntags: [idea]\n---\nbody #urgent"),
    ]);
    expect(result.notes[0]?.id).toBe("id-a");
    expect(result.notes[0]?.tags).toEqual(["work"]);
    expect(result.notes[1]?.tags.sort()).toEqual(["idea", "urgent"]);
    expect(result.tags.sort()).toEqual(["idea", "urgent", "work"]);
  });

  it("skips non-markdown files but surfaces them in errors", async () => {
    const result = await parseLooseMarkdown([
      makeFile("ok.md", "body"),
      new File(["not markdown"], "image.png", { type: "image/png" }),
    ]);
    expect(result.notes).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourcePath).toBe("image.png");
  });

  it("returns an empty import when no files were provided", async () => {
    const result = await parseLooseMarkdown([]);
    expect(result.notes).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
