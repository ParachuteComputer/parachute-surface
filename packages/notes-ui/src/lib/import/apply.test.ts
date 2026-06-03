import type { VaultClient } from "@/lib/vault/client";
import { describe, expect, it, vi } from "vitest";
import { applyImport } from "./apply";
import type { CollectedAttachment, ParsedImport, ParsedNote } from "./types";

/**
 * A fake VaultClient that records upload + create + link calls and hands out
 * deterministic storage paths / note ids. Mirrors the three wire calls the
 * apply path drives: `uploadStorageFile`, `createNote`, `linkAttachment`.
 */
function makeClient() {
  let uploadN = 0;
  let noteN = 0;
  const uploads: Array<{ name: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const links: Array<{ noteId: string; path: string; mimeType: string }> = [];

  const client = {
    uploadStorageFile: vi.fn(async (file: File) => {
      uploads.push({ name: file.name });
      const i = uploadN++;
      const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
      const mimeType =
        ext === ".png" ? "image/png" : ext === ".pdf" ? "application/pdf" : "audio/mp4";
      return { path: `2026/upload-${i}${ext}`, size: 10, mimeType };
    }),
    createNote: vi.fn(async (payload: Record<string, unknown>) => {
      created.push(payload);
      return { id: `note-${noteN++}` };
    }),
    linkAttachment: vi.fn(async (noteId: string, body: { path: string; mimeType: string }) => {
      links.push({ noteId, path: body.path, mimeType: body.mimeType });
      return { id: `att-${links.length}` };
    }),
  } as unknown as VaultClient;

  return { client, uploads, created, links };
}

function note(overrides: Partial<ParsedNote>): ParsedNote {
  return { sourcePath: "n.md", path: "n", content: "", tags: [], metadata: {}, ...overrides };
}

function attachment(
  sourcePath: string,
  kind: CollectedAttachment["kind"],
  bytes = "data",
): CollectedAttachment {
  const filename = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : "";
  return { sourcePath, filename, ext, kind, blob: new Blob([bytes]) };
}

function parsed(overrides: Partial<ParsedImport>): ParsedImport {
  return {
    format: "obsidian-zip",
    notes: [],
    errors: [],
    tags: [],
    attachments: [],
    ...overrides,
  };
}

describe("applyImport", () => {
  it("uploads a referenced image, rewrites the embed to served markdown, links it", async () => {
    const { client, created, links } = makeClient();
    const report = await applyImport({
      client,
      parsed: parsed({
        notes: [note({ sourcePath: "Note.md", path: "Note", content: "see ![[photo.png]]" })],
        attachments: [attachment("assets/photo.png", "image")],
      }),
    });

    // The note body was rewritten to served markdown (image embed).
    expect(created[0]?.content).toBe("see ![photo.png](/api/storage/2026/upload-0.png)");
    // The attachment was linked to the created note.
    expect(links).toEqual([{ noteId: "note-0", path: "2026/upload-0.png", mimeType: "image/png" }]);
    expect(report.created).toBe(1);
    expect(report.attachmentsUploaded).toBe(1);
    expect(report.attachmentsSkipped).toBe(0);
  });

  it("rewrites a relative markdown image and a wikilink pdf in the same note", async () => {
    const { client, created } = makeClient();
    await applyImport({
      client,
      parsed: parsed({
        notes: [
          note({
            sourcePath: "N.md",
            path: "N",
            content: "![alt](img/a.png) and [[report.pdf]]",
          }),
        ],
        attachments: [attachment("img/a.png", "image"), attachment("docs/report.pdf", "pdf")],
      }),
    });
    const body = created[0]?.content as string;
    expect(body).toContain("![alt](/api/storage/2026/upload-0.png)");
    expect(body).toContain("[report.pdf](/api/storage/2026/upload-1.pdf)");
  });

  it("imports a txt file as a note (content preserved, not uploaded)", async () => {
    const { client, created, uploads } = makeClient();
    const report = await applyImport({
      client,
      parsed: parsed({
        attachments: [attachment("notes.txt", "text", "hello world")],
      }),
    });
    // No upload — txt isn't a storage type.
    expect(uploads.length).toBe(0);
    // Created as a note with the text body verbatim.
    const txtNote = created.find((c) => String(c.content).includes("hello world"));
    expect(txtNote).toBeTruthy();
    expect(report.attachmentsUploaded).toBe(1); // counted as "brought across"
  });

  it("fences json/csv/yaml content when importing as a note", async () => {
    const { client, created } = makeClient();
    await applyImport({
      client,
      parsed: parsed({
        attachments: [attachment("data.json", "text", '{"a":1}')],
      }),
    });
    const jsonNote = created.find((c) => String(c.content).includes('{"a":1}'));
    expect(jsonNote?.content).toBe('```json\n{"a":1}\n```\n');
  });

  it("reports unsupported binaries as skipped (never silently dropped)", async () => {
    const { client, uploads } = makeClient();
    const report = await applyImport({
      client,
      parsed: parsed({
        attachments: [attachment("archive.zip", "unsupported")],
      }),
    });
    expect(uploads.length).toBe(0);
    expect(report.attachmentsSkipped).toBe(1);
    const row = report.attachmentOutcomes.find((o) => o.sourcePath === "archive.zip");
    expect(row?.status).toBe("skipped");
    if (row?.status === "skipped") expect(row.reason).toMatch(/not a vault storage type/i);
  });

  it("gathers loose (unreferenced) attachments into an 'Imported files' note", async () => {
    const { client, created, links } = makeClient();
    const report = await applyImport({
      client,
      parsed: parsed({
        notes: [note({ sourcePath: "N.md", path: "N", content: "no embeds here" })],
        attachments: [attachment("loose/orphan.png", "image")],
      }),
    });
    // An index note was created gathering the loose file.
    const indexNote = created.find((c) => String(c.content).includes("Imported files"));
    expect(indexNote).toBeTruthy();
    expect(String(indexNote?.content)).toContain("/api/storage/2026/upload-0.png");
    // It was linked to that index note.
    expect(links.some((l) => l.path === "2026/upload-0.png")).toBe(true);
    expect(report.attachmentsUploaded).toBe(1);
  });

  it("records an upload failure as an errored attachment without aborting notes", async () => {
    const { client, created } = makeClient();
    (client.uploadStorageFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("storage 500"),
    );
    const report = await applyImport({
      client,
      parsed: parsed({
        notes: [note({ sourcePath: "N.md", path: "N", content: "![[x.png]]" })],
        attachments: [attachment("x.png", "image")],
      }),
    });
    // Note still created (with the unresolved embed left intact).
    expect(report.created).toBe(1);
    expect(created[0]?.content).toBe("![[x.png]]");
    expect(report.attachmentsErrored).toBe(1);
  });

  it("produces a complete report: notes + attachments + skips all accounted for", async () => {
    const { client } = makeClient();
    const report = await applyImport({
      client,
      parsed: parsed({
        notes: [note({ sourcePath: "A.md", path: "A", content: "![[pic.png]]" })],
        attachments: [
          attachment("pic.png", "image"), // uploaded + referenced
          attachment("loose.pdf", "pdf"), // uploaded + loose
          attachment("notes.txt", "text"), // → note
          attachment("weird.bin", "unsupported"), // skipped
        ],
      }),
    });
    // pic + loose + txt all "brought across" (uploaded count); weird skipped.
    expect(report.attachmentsUploaded).toBe(3);
    expect(report.attachmentsSkipped).toBe(1);
    expect(report.attachmentsErrored).toBe(0);
    // Every attachment appears in the report — none vanished.
    const reported = new Set(report.attachmentOutcomes.map((o) => o.sourcePath));
    expect(reported).toEqual(new Set(["pic.png", "loose.pdf", "notes.txt", "weird.bin"]));
  });
});
