import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseObsidianZip } from "./obsidian";

async function buildZip(files: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "vault.zip", { type: "application/zip" });
}

describe("parseObsidianZip", () => {
  it("extracts every .md file, sorted by path", async () => {
    // A mix of root-level + folder-level files: no common first
    // segment, so stripCommonRoot is a no-op and the structure is
    // preserved verbatim (minus the `.md` extension).
    const zip = await buildZip({
      "Notes/Alpha.md": "alpha body",
      "Notes/Beta.md": "beta body",
      "Top.md": "top body",
    });
    const result = await parseObsidianZip(zip);
    expect(result.format).toBe("obsidian-zip");
    expect(result.notes.map((n) => n.path)).toEqual(["Notes/Alpha", "Notes/Beta", "Top"]);
    expect(result.errors).toEqual([]);
  });

  it("strips a common first folder when every markdown entry shares it", async () => {
    // The simple heuristic: when every markdown file starts with the
    // same first segment, that's almost always an accidental wrapping
    // folder (Obsidian zip-from-above-vault shape). Strip.
    const zip = await buildZip({
      "Notes/Alpha.md": "a",
      "Notes/Beta.md": "b",
    });
    const result = await parseObsidianZip(zip);
    expect(result.notes.map((n) => n.path).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("strips a single common top-level folder (Obsidian vault-folder export shape)", async () => {
    const zip = await buildZip({
      "MyVault/Alpha.md": "a",
      "MyVault/Notes/Beta.md": "b",
    });
    const result = await parseObsidianZip(zip);
    expect(result.notes.map((n) => n.path)).toEqual(["Alpha", "Notes/Beta"]);
  });

  it("does NOT strip when entries don't share a single common root", async () => {
    const zip = await buildZip({
      "Folder1/A.md": "a",
      "Folder2/B.md": "b",
    });
    const result = await parseObsidianZip(zip);
    expect(result.notes.map((n) => n.path).sort()).toEqual(["Folder1/A", "Folder2/B"]);
  });

  it("skips .obsidian/ and .trash/ entries", async () => {
    const zip = await buildZip({
      "MyVault/Notes/Real.md": "real",
      "MyVault/.obsidian/workspace.json": "{}",
      "MyVault/.obsidian/plugins/foo/main.js": "x",
      "MyVault/.trash/Deleted.md": "tombstone",
    });
    const result = await parseObsidianZip(zip);
    expect(result.notes.map((n) => n.path)).toEqual(["Notes/Real"]);
  });

  it("collects non-markdown entries as attachments (not error rows)", async () => {
    const zip = await buildZip({
      "Real.md": "real",
      "image.png": "binary-bytes-but-still-content",
      "data.json": "{}",
    });
    const result = await parseObsidianZip(zip);
    expect(result.notes.map((n) => n.path)).toEqual(["Real"]);
    expect(result.errors).toEqual([]);
    // The image + json are now carried as classified attachments.
    expect(result.attachments.map((a) => a.sourcePath).sort()).toEqual(["data.json", "image.png"]);
    const img = result.attachments.find((a) => a.filename === "image.png");
    const json = result.attachments.find((a) => a.filename === "data.json");
    expect(img?.kind).toBe("image");
    expect(json?.kind).toBe("text");
  });

  it("returns an empty notes list (not an error) for a zip with no markdown, still collects files", async () => {
    const zip = await buildZip({ "image.png": "x", "data.json": "{}" });
    const result = await parseObsidianZip(zip);
    expect(result.notes).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.attachments.length).toBe(2);
  });

  it("does NOT collect excluded-path files (.obsidian icons, .trash) as attachments", async () => {
    const zip = await buildZip({
      "MyVault/Notes/Real.md": "real",
      "MyVault/.obsidian/icons/logo.png": "x",
      "MyVault/.trash/old.png": "y",
      "MyVault/assets/keep.png": "z",
    });
    const result = await parseObsidianZip(zip);
    expect(result.notes.map((n) => n.path)).toEqual(["Notes/Real"]);
    // Only the real asset survives; .obsidian + .trash binaries are excluded.
    expect(result.attachments.map((a) => a.sourcePath)).toEqual(["assets/keep.png"]);
  });

  it("parses frontmatter + tags from each note in the archive", async () => {
    // Both files share `Notes/` → it gets stripped by stripCommonRoot.
    // The note-level assertions look up the result paths post-strip.
    const zip = await buildZip({
      "Notes/A.md": "---\ntags: [project, urgent]\n---\nbody with #inline",
      "Notes/B.md": "---\nid: stable-id\n---\nbody",
    });
    const result = await parseObsidianZip(zip);
    const a = result.notes.find((n) => n.path === "A");
    const b = result.notes.find((n) => n.path === "B");
    expect(a?.tags.sort()).toEqual(["inline", "project", "urgent"]);
    expect(b?.id).toBe("stable-id");
    expect(result.tags.sort()).toEqual(["inline", "project", "urgent"]);
  });

  it("surfaces a parse error when the zip is corrupt", async () => {
    const bad = new File([new Uint8Array([0, 1, 2, 3, 4])], "broken.zip", {
      type: "application/zip",
    });
    const result = await parseObsidianZip(bad);
    expect(result.notes).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.reason).toMatch(/zip/i);
  });
});
