import { describe, expect, it } from "vitest";
import { type ResolvedAttachment, buildAttachmentIndex, rewriteReferences } from "./rewrite";

function img(sourcePath: string, storagePath: string, filename: string): ResolvedAttachment {
  return { sourcePath, storagePath, isImage: true, filename };
}
function file(sourcePath: string, storagePath: string, filename: string): ResolvedAttachment {
  return { sourcePath, storagePath, isImage: false, filename };
}

describe("rewriteReferences", () => {
  it("rewrites an Obsidian embed `![[image.png]]` to a served image", () => {
    const index = buildAttachmentIndex([img("assets/image.png", "2026/uuid.png", "image.png")]);
    const out = rewriteReferences("before\n![[image.png]]\nafter", index);
    expect(out.content).toBe("before\n![image.png](/api/storage/2026/uuid.png)\nafter");
    expect(out.rewritten).toBe(1);
    expect([...out.referenced]).toEqual(["assets/image.png"]);
  });

  it("rewrites a bare wikilink `[[doc.pdf]]` to a served (non-image) link", () => {
    const index = buildAttachmentIndex([file("docs/doc.pdf", "2026/uuid.pdf", "doc.pdf")]);
    const out = rewriteReferences("see [[doc.pdf]] for details", index);
    expect(out.content).toBe("see [doc.pdf](/api/storage/2026/uuid.pdf) for details");
    expect(out.rewritten).toBe(1);
  });

  it("rewrites a standard markdown image `![alt](relative)`", () => {
    const index = buildAttachmentIndex([img("pics/cat.jpg", "2026/uuid.jpg", "cat.jpg")]);
    const out = rewriteReferences("![my cat](pics/cat.jpg)", index);
    // Author's alt text is preserved.
    expect(out.content).toBe("![my cat](/api/storage/2026/uuid.jpg)");
    expect(out.rewritten).toBe(1);
  });

  it("rewrites a standard markdown link `[text](relative)` for a non-image file", () => {
    const index = buildAttachmentIndex([file("data/report.pdf", "2026/uuid.pdf", "report.pdf")]);
    const out = rewriteReferences("[the report](data/report.pdf)", index);
    expect(out.content).toBe("[the report](/api/storage/2026/uuid.pdf)");
  });

  it("handles `%20`-encoded spaces in markdown image targets", () => {
    const index = buildAttachmentIndex([img("my photo.png", "2026/uuid.png", "my photo.png")]);
    const out = rewriteReferences("![](my%20photo.png)", index);
    expect(out.content).toBe("![my photo.png](/api/storage/2026/uuid.png)");
    expect(out.rewritten).toBe(1);
  });

  it("strips an Obsidian alias/size suffix `![[image.png|300]]`", () => {
    const index = buildAttachmentIndex([img("image.png", "2026/uuid.png", "image.png")]);
    const out = rewriteReferences("![[image.png|300]]", index);
    expect(out.content).toBe("![image.png](/api/storage/2026/uuid.png)");
  });

  it("resolves a subpath embed `![[sub/a.png]]` to the matching nested file", () => {
    const index = buildAttachmentIndex([
      img("top/a.png", "2026/top.png", "a.png"),
      img("nested/sub/a.png", "2026/sub.png", "a.png"),
    ]);
    const out = rewriteReferences("![[sub/a.png]]", index);
    // Suffix match prefers the nested file over the basename-only top one.
    expect(out.content).toBe("![a.png](/api/storage/2026/sub.png)");
  });

  it("leaves a note wikilink (no extension) untouched", () => {
    const index = buildAttachmentIndex([img("image.png", "2026/uuid.png", "image.png")]);
    const out = rewriteReferences("link to [[Some Note]] here", index);
    expect(out.content).toBe("link to [[Some Note]] here");
    expect(out.rewritten).toBe(0);
  });

  it("leaves an external image URL untouched", () => {
    const index = buildAttachmentIndex([img("image.png", "2026/uuid.png", "image.png")]);
    const out = rewriteReferences("![](https://example.com/image.png)", index);
    expect(out.content).toBe("![](https://example.com/image.png)");
    expect(out.rewritten).toBe(0);
  });

  it("leaves a reference with no matching attachment untouched", () => {
    const index = buildAttachmentIndex([img("image.png", "2026/uuid.png", "image.png")]);
    const out = rewriteReferences("![[missing.png]] and [other](nope.pdf)", index);
    expect(out.content).toBe("![[missing.png]] and [other](nope.pdf)");
    expect(out.rewritten).toBe(0);
  });

  it("rewrites multiple references in one note and tracks each source path", () => {
    const index = buildAttachmentIndex([
      img("a.png", "2026/a.png", "a.png"),
      file("b.pdf", "2026/b.pdf", "b.pdf"),
    ]);
    const out = rewriteReferences("![[a.png]] then [b](b.pdf)", index);
    expect(out.content).toBe("![a.png](/api/storage/2026/a.png) then [b](/api/storage/2026/b.pdf)");
    expect(out.rewritten).toBe(2);
    expect([...out.referenced].sort()).toEqual(["a.png", "b.pdf"]);
  });

  it("matches the basename case-insensitively (Obsidian behavior)", () => {
    // The collected file is `Image.PNG` but the note references `image.png`.
    // Obsidian resolves these to the same file regardless of case; the label
    // in the rewritten markdown uses the reference as the author wrote it.
    const index = buildAttachmentIndex([img("Image.PNG", "2026/uuid.png", "Image.PNG")]);
    const out = rewriteReferences("![[image.png]]", index);
    expect(out.content).toBe("![image.png](/api/storage/2026/uuid.png)");
    expect(out.rewritten).toBe(1);
  });
});
