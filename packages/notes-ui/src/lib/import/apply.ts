/**
 * The import APPLY orchestrator — turns a `ParsedImport` into vault writes,
 * carrying attachments + non-markdown files across instead of dropping them.
 *
 * Sequencing (driven by the upload→link dependency graph):
 *
 *   1. UPLOAD storage-eligible attachments (image/pdf/audio/video). Upload
 *      needs no note id, so it goes first and yields each file's vault
 *      storage path.
 *   2. BUILD a resolver index from {filename, sourcePath} → storage path.
 *   3. REWRITE every note's content, turning `![[a.png]]` / `[[a.png]]` /
 *      `![](rel)` / `[](rel)` references that resolve to an uploaded
 *      attachment into served markdown `![filename](/api/storage/<path>)`
 *      (images) / `[filename](/api/storage/<path>)` (others). Renders via
 *      the existing `VaultImage` path — no renderer change. The rewrite also
 *      reports which attachment `sourcePath`s each note referenced, for
 *      precise linking.
 *   4. CREATE notes (rewritten content) via the existing `runImport` core,
 *      whose per-note outcomes give us the new note ids.
 *   5. LINK each uploaded attachment to the note(s) that referenced it (so
 *      it shows in the note's attachment list, identical to a paste).
 *   6. TEXT-shaped files (txt/json/csv/yaml/svg/…), which the vault storage
 *      allowlist won't accept, are imported as their own NOTES (content
 *      preserved verbatim, fenced for code-ish types) — "attach as files."
 *   7. LOOSE storage-eligible files referenced by nothing are linked from a
 *      single "Imported files" index note so they're reachable + reported.
 *   8. UNSUPPORTED binaries (allowlist refusal) are reported skipped — never
 *      silently dropped.
 *
 * Every file lands in the report (`attachmentOutcomes`) with an outcome +
 * reason; the import UI surfaces the full tally. That kills the silent drop.
 */

import type { VaultClient } from "@/lib/vault/client";
import { isUploadableKind } from "./attachments";
import { readBlobAsText } from "./read-file";
import { type AttachmentIndex, buildAttachmentIndex, rewriteReferences } from "./rewrite";
import { type NoteImportReport, runImport } from "./runner";
import type {
  AttachmentOutcome,
  CollectedAttachment,
  ImportProgress,
  ImportReport,
  ParsedImport,
  ParsedNote,
} from "./types";

export interface ApplyImportOptions {
  client: VaultClient;
  parsed: ParsedImport;
  concurrency?: number;
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
}

/** Title/path used for the index note that gathers loose attachments. */
const IMPORTED_FILES_PATH = "Imported files";
/**
 * How many numbered suffixes to try when the index-note path collides with
 * one left by an earlier import ("Imported files 2", "Imported files 3", …).
 */
const MAX_INDEX_NOTE_ATTEMPTS = 20;

interface UploadedRecord {
  attachment: CollectedAttachment;
  storagePath: string;
  mimeType: string;
  isImage: boolean;
}

/**
 * Run the full attachment-aware import. Never throws — like `runImport`,
 * partial success beats all-or-nothing; failures become report rows.
 */
export async function applyImport(opts: ApplyImportOptions): Promise<ImportReport> {
  const { client, parsed, signal } = opts;
  const attachmentOutcomes: AttachmentOutcome[] = [];

  // --- Partition the collected attachments by how we'll handle them. ---
  const uploadable: CollectedAttachment[] = [];
  const textFiles: CollectedAttachment[] = [];
  const unsupported: CollectedAttachment[] = [];
  for (const att of parsed.attachments) {
    if (isUploadableKind(att.kind)) uploadable.push(att);
    else if (att.kind === "text") textFiles.push(att);
    else unsupported.push(att);
  }

  // --- 1) Upload storage-eligible attachments (no note id needed yet). ---
  const uploaded = new Map<string, UploadedRecord>(); // sourcePath → record
  for (const att of uploadable) {
    if (signal?.aborted) {
      attachmentOutcomes.push({
        status: "skipped",
        sourcePath: att.sourcePath,
        reason: "Skipped — import was cancelled.",
      });
      continue;
    }
    try {
      const file = new File([att.blob], att.filename, {
        type: att.blob.type || undefined,
      });
      const result = await client.uploadStorageFile(file, { signal });
      uploaded.set(att.sourcePath, {
        attachment: att,
        storagePath: result.path,
        mimeType: result.mimeType,
        isImage: result.mimeType.startsWith("image/"),
      });
    } catch (err) {
      attachmentOutcomes.push({
        status: "errored",
        sourcePath: att.sourcePath,
        reason: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // --- 2) Build the resolver index over successfully-uploaded files. ---
  const index = buildIndex(uploaded);

  // --- 3) Rewrite note content; remember which attachments each note hit. ---
  // sourcePath → set of attachment sourcePaths it references.
  const noteRefs = new Map<string, Set<string>>();
  const rewrittenNotes: ParsedNote[] = parsed.notes.map((note) => {
    const { content, referenced } = rewriteReferences(note.content, index);
    noteRefs.set(note.sourcePath, referenced);
    return { ...note, content };
  });

  // --- 4) Create notes via the existing runner core. ---
  const noteReport = await runImport({
    client,
    notes: rewrittenNotes,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(signal ? { signal } : {}),
  });

  // sourcePath → created note id.
  const noteIdByPath = new Map<string, string>();
  for (const o of noteReport.outcomes) {
    if (o.status === "created") noteIdByPath.set(o.sourcePath, o.noteId);
  }

  // --- 5) Link uploaded attachments to the notes that referenced them. ---
  // Invert noteRefs → attachment sourcePath → set of note ids.
  const linkTargets = new Map<string, Set<string>>();
  for (const [notePath, refs] of noteRefs) {
    const noteId = noteIdByPath.get(notePath);
    if (!noteId) continue; // note skipped/errored — nothing to link to
    for (const attPath of refs) {
      let set = linkTargets.get(attPath);
      if (!set) {
        set = new Set();
        linkTargets.set(attPath, set);
      }
      set.add(noteId);
    }
  }

  for (const [sourcePath, rec] of uploaded) {
    const targets = linkTargets.get(sourcePath);
    if (!targets || targets.size === 0) continue; // loose — handled in step 7
    let references = 0;
    for (const noteId of targets) {
      if (signal?.aborted) break;
      try {
        await client.linkAttachment(noteId, {
          path: rec.storagePath,
          mimeType: rec.mimeType,
        });
        references++;
      } catch {
        // A failed link doesn't lose the blob — it's uploaded AND the
        // served-markdown rewrite still renders it. Best-effort link only;
        // the report's `references` counts SUCCESSFUL links, so no bump.
      }
    }
    attachmentOutcomes.push({
      status: "uploaded",
      sourcePath,
      storagePath: rec.storagePath,
      references,
    });
  }

  // --- 6) Text-shaped files → notes (content preserved verbatim). ---
  if (textFiles.length > 0 && !signal?.aborted) {
    const textNotes: ParsedNote[] = [];
    for (const att of textFiles) {
      textNotes.push(await textFileToNote(att));
    }
    const textReport = await runImport({
      client,
      notes: textNotes,
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(signal ? { signal } : {}),
    });
    for (let i = 0; i < textFiles.length; i++) {
      const att = textFiles[i] as CollectedAttachment;
      const outcome = textReport.outcomes[i];
      if (outcome?.status === "created") {
        attachmentOutcomes.push({
          status: "uploaded",
          sourcePath: att.sourcePath,
          storagePath: `note:${outcome.noteId}`,
          references: 1,
          asNote: true,
        });
      } else {
        attachmentOutcomes.push({
          status: "skipped",
          sourcePath: att.sourcePath,
          reason:
            outcome?.status === "skipped"
              ? `Imported as note, but ${outcome.reason}`
              : `Could not import as note: ${outcome?.status === "errored" ? outcome.reason : "unknown"}`,
        });
      }
    }
  } else if (textFiles.length > 0) {
    for (const att of textFiles) {
      attachmentOutcomes.push({
        status: "skipped",
        sourcePath: att.sourcePath,
        reason: "Skipped — import was cancelled.",
      });
    }
  }

  // --- 7) Loose storage-eligible files (uploaded, referenced by nothing). ---
  const loose = [...uploaded.entries()]
    .filter(([sp]) => !(linkTargets.get(sp)?.size ?? 0))
    .map(([, rec]) => rec);
  if (loose.length > 0) {
    if (signal?.aborted) {
      for (const rec of loose) {
        attachmentOutcomes.push({
          status: "uploaded",
          sourcePath: rec.attachment.sourcePath,
          storagePath: rec.storagePath,
          references: 0,
        });
      }
    } else {
      await gatherLooseFiles(client, loose, attachmentOutcomes, opts.concurrency, signal);
    }
  }

  // --- 8) Unsupported binaries → reported skipped. ---
  for (const att of unsupported) {
    attachmentOutcomes.push({
      status: "skipped",
      sourcePath: att.sourcePath,
      reason: `.${att.ext || "?"} is not a vault storage type — not imported. (Re-save it in a supported format to bring it across.)`,
    });
  }

  return mergeReport(noteReport, attachmentOutcomes);
}

function buildIndex(uploaded: Map<string, UploadedRecord>): AttachmentIndex {
  return buildAttachmentIndex(
    [...uploaded.values()].map((rec) => ({
      sourcePath: rec.attachment.sourcePath,
      storagePath: rec.storagePath,
      isImage: rec.isImage,
      filename: rec.attachment.filename,
    })),
  );
}

/**
 * Turn a text-shaped file (json/csv/yaml/txt/svg) into a note. Content is
 * preserved verbatim; code-ish types are fenced so they render readably and
 * aren't mangled by markdown. The original extension is folded into the path
 * (`data.json` → `data-json`) so siblings with the same stem but different
 * type stay distinct and a re-import can tell them apart.
 */
async function textFileToNote(att: CollectedAttachment): Promise<ParsedNote> {
  let text = "";
  try {
    text = await readBlobAsText(att.blob);
  } catch {
    text = "";
  }
  const body = shouldFence(att.ext)
    ? `\`\`\`${fenceLang(att.ext)}\n${text}\n\`\`\`\n`
    : `${text}\n`;
  return {
    sourcePath: att.sourcePath,
    path: att.sourcePath.replace(/\.([^/.]+)$/, "-$1"),
    content: body,
    tags: ["imported-file"],
    metadata: { imported_from: att.sourcePath, original_type: att.ext },
  };
}

function shouldFence(ext: string): boolean {
  return ["json", "csv", "tsv", "yaml", "yml", "svg", "log"].includes(ext.toLowerCase());
}

function fenceLang(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "yml") return "yaml";
  if (e === "svg") return "xml";
  if (e === "tsv") return "csv";
  return e;
}

/**
 * Gather loose (unreferenced) uploaded files into a single "Imported files"
 * note that links each one, then link each attachment to that note. The
 * simplest sensible home: one index note keeps the vault tidy (vs. a stub
 * per file) while keeping every loose attachment reachable + reported.
 */
async function gatherLooseFiles(
  client: VaultClient,
  loose: UploadedRecord[],
  outcomes: AttachmentOutcome[],
  concurrency: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const lines = [
    "# Imported files",
    "",
    "Attachments from your import not embedded in any note:",
    "",
  ];
  for (const rec of loose) {
    const url = `/api/storage/${rec.storagePath}`;
    lines.push(
      rec.isImage
        ? `- ![${rec.attachment.filename}](${url})`
        : `- [${rec.attachment.filename}](${url})`,
    );
  }
  // A re-import of the same vault collides on the fixed path (the runner
  // routes the 409 to "skipped"), which used to strand that import's loose
  // files with no note link. Retry with numbered suffixes until a FRESH
  // index note is created; a real error (not a collision) stops the loop.
  let noteId: string | null = null;
  for (let attempt = 1; attempt <= MAX_INDEX_NOTE_ATTEMPTS && !noteId; attempt++) {
    if (signal?.aborted) break; // cancelled mid-retry — report files as unlinked
    const path = attempt === 1 ? IMPORTED_FILES_PATH : `${IMPORTED_FILES_PATH} ${attempt}`;
    const indexNote: ParsedNote = {
      sourcePath: path,
      path,
      content: `${lines.join("\n")}\n`,
      tags: ["imported-file"],
      metadata: {},
    };
    const report = await runImport({
      client,
      notes: [indexNote],
      ...(concurrency !== undefined ? { concurrency } : {}),
    });
    const outcome = report.outcomes[0];
    if (outcome?.status === "created") noteId = outcome.noteId;
    else if (outcome?.status !== "skipped") break; // errored — retrying won't help
  }
  for (const rec of loose) {
    if (noteId) {
      try {
        await client.linkAttachment(noteId, {
          path: rec.storagePath,
          mimeType: rec.mimeType,
        });
      } catch {
        // Already uploaded + linked from the index note's markdown; the
        // attachment row is a nicety. Don't fail the file over it.
      }
    }
    outcomes.push({
      status: "uploaded",
      sourcePath: rec.attachment.sourcePath,
      storagePath: rec.storagePath,
      references: noteId ? 1 : 0,
    });
  }
}

function mergeReport(
  noteReport: NoteImportReport,
  attachmentOutcomes: AttachmentOutcome[],
): ImportReport {
  let attachmentsUploaded = 0;
  let filesImportedAsNotes = 0;
  let attachmentsSkipped = 0;
  let attachmentsErrored = 0;
  for (const o of attachmentOutcomes) {
    // Data files folded into notes are "brought across" but NOT storage
    // attachments — counting them as such made the done-stage tally lie.
    if (o.status === "uploaded") {
      if (o.asNote) filesImportedAsNotes++;
      else attachmentsUploaded++;
    } else if (o.status === "skipped") attachmentsSkipped++;
    else attachmentsErrored++;
  }
  return {
    ...noteReport,
    attachmentsUploaded,
    filesImportedAsNotes,
    attachmentsSkipped,
    attachmentsErrored,
    attachmentOutcomes,
  };
}
