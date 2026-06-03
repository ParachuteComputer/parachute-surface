/**
 * Shared types for the browser-side file-import surface (notes-ui#NN).
 *
 * The flow is two-phase:
 *   1. *Parse* — read uploaded files client-side, extract notes + tags +
 *      metadata, build a `ParsedImport` summary the UI shows as a dry-run.
 *   2. *Run* — POST each parsed note to the active vault, track progress,
 *      classify outcomes (created / skipped / errored). Errors don't abort
 *      the batch — partial success beats all-or-nothing for migration
 *      scenarios where the user has a few path collisions buried in 500
 *      notes.
 *
 * Two source formats land in this PR: Obsidian-zip and loose markdown.
 * Future formats (Notion, Roam, …) plug in by producing the same
 * `ParsedImport` shape; the runner is format-agnostic.
 */

export type DetectedFormat = "obsidian-zip" | "loose-markdown" | "unknown";

/**
 * One parsed note from a source file, ready to POST to vault. Mirrors
 * `CreateNotePayload` from app-client plus a `sourcePath` for the
 * dry-run UI's per-row label and the error report.
 */
export interface ParsedNote {
  /**
   * Original path inside the source — `inbox/2024-01-12.md` for an
   * Obsidian zip, the filename for a loose upload. Displayed in the
   * dry-run table; not sent to vault.
   */
  sourcePath: string;
  /**
   * Vault-side path (no `.md`, separators normalized). Falls back to the
   * source filename without extension when frontmatter doesn't provide
   * one. Vault enforces uniqueness — collisions surface as 409.
   */
  path: string;
  /** Body after frontmatter is stripped. */
  content: string;
  /** Frontmatter `id` if present — lets vault upsert by ID. */
  id?: string;
  /** Merged frontmatter `tags` + inline `#hashtag` extraction. */
  tags: string[];
  /** Frontmatter `created_at` / `createdAt` if present (ISO 8601). */
  createdAt?: string;
  /**
   * Frontmatter `updated_at` / `updatedAt` if present (ISO 8601). Hoisted
   * for parse-tier parity with the vault CLI importer; the web runner
   * currently carries-but-drops it (vault's create path doesn't accept a
   * client `updated_at`).
   */
  updatedAt?: string;
  /**
   * Frontmatter bag minus the keys we hoisted (id, path, tags,
   * created_at/createdAt, updated_at/updatedAt). Stamped onto the note's
   * metadata column.
   */
  metadata: Record<string, unknown>;
}

/**
 * One file we couldn't parse — surfaced in the dry-run summary so the
 * user knows what got skipped before they hit Confirm.
 */
export interface ParseError {
  sourcePath: string;
  reason: string;
}

/**
 * A non-markdown file pulled out of the source archive, carried alongside
 * the parsed notes so the apply path can upload it to vault storage and
 * rewrite the embeds that reference it.
 *
 * `kind` drives the served-markdown the rewrite emits (image embed vs.
 * plain link) AND whether the file is uploadable at all:
 *   - `image` / `pdf` / `audio` / `video` → vault-storage-allowlisted;
 *     uploaded via the attachment chain.
 *   - `text` → NOT a storage type (json/csv/yaml/txt/svg); the apply path
 *     turns these into notes (text wrapped, no interpretation) so their
 *     content is preserved and searchable.
 *   - `unsupported` → a binary the vault storage allowlist refuses (e.g.
 *     `.zip`-in-zip, `.docx`); surfaced in the report as skipped-with-
 *     reason rather than silently dropped.
 */
export type AttachmentKind = "image" | "pdf" | "audio" | "video" | "text" | "unsupported";

export interface CollectedAttachment {
  /** Path inside the archive, after common-root strip (matches note paths). */
  sourcePath: string;
  /** Basename of `sourcePath` — the name Obsidian embeds resolve against. */
  filename: string;
  /** Lowercased extension without the dot (`png`, `pdf`, `json`, …). */
  ext: string;
  /** Classification — see `AttachmentKind`. */
  kind: AttachmentKind;
  /** The file bytes, as a Blob (JSZip `.async("blob")`). */
  blob: Blob;
}

export interface ParsedImport {
  format: DetectedFormat;
  notes: ParsedNote[];
  errors: ParseError[];
  /** Unique tag set across every parsed note — surfaces in the summary. */
  tags: string[];
  /**
   * Non-markdown files collected from the archive (Obsidian only; loose
   * markdown drops carry none). The apply path uploads the storage-eligible
   * ones, rewrites referencing embeds, brings text-shaped ones in as notes,
   * and reports the rest. Empty for loose-markdown imports.
   */
  attachments: CollectedAttachment[];
}

/**
 * Per-note outcome from the runner. `skipped` covers the "already exists"
 * case (409); `errored` is everything else after the one-shot retry.
 */
export type ImportOutcome =
  | { status: "created"; sourcePath: string; noteId: string }
  | { status: "skipped"; sourcePath: string; reason: string }
  | { status: "errored"; sourcePath: string; reason: string };

export interface ImportProgress {
  /** Notes the runner has finished (any outcome). */
  done: number;
  /** Total notes the runner will attempt. */
  total: number;
}

/**
 * Per-attachment outcome from the apply path. `uploaded` = blob landed in
 * vault storage AND at least one referencing embed was rewritten to served
 * markdown (or, for a loose file, linked from the "Imported files" note).
 * `skipped` = the vault refused it (not in the storage allowlist) or it was
 * a text-shaped file folded into a note instead. `errored` = the upload or
 * link call failed.
 */
export type AttachmentOutcome =
  | { status: "uploaded"; sourcePath: string; storagePath: string; references: number }
  | { status: "skipped"; sourcePath: string; reason: string }
  | { status: "errored"; sourcePath: string; reason: string };

export interface ImportReport {
  created: number;
  skipped: number;
  errored: number;
  outcomes: ImportOutcome[];
  /** Attachments uploaded + linked (storage-eligible files). */
  attachmentsUploaded: number;
  /** Attachments not brought across as files (allowlist refusal, etc.). */
  attachmentsSkipped: number;
  /** Attachments that failed upload/link. */
  attachmentsErrored: number;
  /** Per-attachment detail rows for the report UI. */
  attachmentOutcomes: AttachmentOutcome[];
}
