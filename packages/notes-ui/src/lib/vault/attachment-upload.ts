/**
 * Shared attachment upload+link primitives.
 *
 * The in-app paste/drop path (`useAttachmentUploader`) and the Obsidian
 * importer (`lib/import`) both need the same three-step dance:
 *
 *   1. `POST /api/storage/upload` (multipart) → `{ path, size, mimeType }`.
 *   2. `POST /api/notes/:id/attachments` with `{ path, mimeType }` to link
 *      the stored blob to a note.
 *   3. Produce the standard markdown that renders via `MarkdownView`'s
 *      `img` override → `VaultImage` (auth-fetches `/api/storage/…`):
 *        - images → `![filename](/api/storage/<path>)`
 *        - everything else → `[filename](/api/storage/<path>)`
 *
 * Both surfaces previously shared (1)+(2) only via the hook; (3) lived as
 * `markdownForUpload`. Lifting the validation + markdown helpers here lets
 * the importer reuse the EXACT same behavior so imported attachments are
 * byte-for-byte identical to natively-pasted ones — same wire calls, same
 * served-markdown shape, same renderer path. No new renderer.
 *
 * Server allowlist note: vault's storage endpoint only accepts a fixed set
 * of extensions (audio + image + pdf + mp4); `.svg`/`.html` are refused
 * server-side as XSS vectors, and text-shaped data (json/csv/yaml/txt) is
 * not an attachment type. `STORAGE_ALLOWED_EXTENSIONS` mirrors that
 * allowlist so callers can pre-flight and route the rest elsewhere (the
 * importer turns text-shaped files into notes; truly-unsupported binaries
 * are reported, not silently dropped).
 */

import type { VaultClient } from "./client";
import { STORAGE_ALLOWED_EXTENSIONS, STORAGE_MAX_BYTES } from "./client";
import type { StorageUploadResult } from "./types";

export function fileExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pre-flight a file against the vault's storage guardrails (size + the
 * extension allowlist). Returns a human-readable reason string when the
 * file is rejected, or `null` when it's accepted. Shared so the editor
 * uploader and the importer surface identical messaging.
 */
export function validateFile(file: File): string | null {
  if (file.size > STORAGE_MAX_BYTES) {
    return `${file.name} is too large (${formatMB(file.size)}). Max: 100 MB.`;
  }
  const ext = fileExt(file.name);
  if (!STORAGE_ALLOWED_EXTENSIONS.has(ext)) {
    return `${file.name}: .${ext || "?"} is not in the vault allowlist.`;
  }
  return null;
}

/**
 * `true` when `ext` (no dot, lowercased) is an extension the vault's
 * storage endpoint will accept — i.e. it can become a real attachment via
 * upload+link. Callers that hold a filename use `fileExt` first.
 */
export function isStorageAllowedExt(ext: string): boolean {
  return STORAGE_ALLOWED_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Standard served-markdown for an uploaded attachment. Images get the
 * `![]()` embed (rendered inline by `VaultImage`); everything else gets a
 * plain `[]()` link. The trailing newline matches the editor-paste path so
 * inserted snippets don't run into following text.
 *
 * `newline` lets the importer opt out of the trailing `\n` when it's
 * rewriting an inline reference inside existing prose (where a hard break
 * would be wrong); the editor path keeps the default.
 */
export function markdownForUpload(
  result: StorageUploadResult,
  filename: string,
  opts: { newline?: boolean } = {},
): string {
  const url = `/api/storage/${result.path}`;
  const nl = opts.newline === false ? "" : "\n";
  if (result.mimeType.startsWith("image/")) {
    return `![${filename}](${url})${nl}`;
  }
  return `[${filename}](${url})${nl}`;
}

/**
 * The core upload→link round-trip, shared by the hook and the importer.
 *
 * Uploads `file` to vault storage, then (when `noteId` is given) links the
 * stored blob to that note. Returns the `StorageUploadResult` so callers
 * can build the served-markdown via `markdownForUpload`. Throws on
 * validation failure or any wire error — callers decide how to surface it
 * (the hook updates its per-entry status; the importer records a report
 * row). Keeping this as a plain async fn (no React) is what lets the
 * importer reuse it outside a component.
 */
export async function uploadAndLink(
  client: VaultClient,
  file: File,
  opts: {
    noteId?: string | null;
    onProgress?: (p: { loaded: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<StorageUploadResult> {
  const validation = validateFile(file);
  if (validation) throw new Error(validation);

  const result = await client.uploadStorageFile(file, {
    onProgress: opts.onProgress ? ({ loaded }) => opts.onProgress?.({ loaded }) : undefined,
    signal: opts.signal,
  });

  if (opts.noteId) {
    await client.linkAttachment(opts.noteId, {
      path: result.path,
      mimeType: result.mimeType,
    });
  }
  return result;
}
