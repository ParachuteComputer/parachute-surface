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
   * Frontmatter bag minus the keys we hoisted (id, path, tags,
   * created_at). Stamped onto the note's metadata column.
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

export interface ParsedImport {
  format: DetectedFormat;
  notes: ParsedNote[];
  errors: ParseError[];
  /** Unique tag set across every parsed note — surfaces in the summary. */
  tags: string[];
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

export interface ImportReport {
  created: number;
  skipped: number;
  errored: number;
  outcomes: ImportOutcome[];
}
