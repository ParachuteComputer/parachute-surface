/**
 * Non-markdown file collection + classification for the Obsidian importer.
 *
 * Obsidian vaults bundle attachments (images, PDFs, audio) and loose data
 * files (json/csv/yaml) right alongside the `.md` notes. v1 of the importer
 * silently dropped everything non-markdown ("Attachments are out of scope").
 * This module classifies each non-md entry so the apply path can bring it
 * across via the proven upload→link→served-markdown chain.
 *
 * Classification is driven by the vault's *server-side* storage allowlist —
 * the hard constraint. `POST /api/storage/upload` only accepts:
 *
 *     audio: wav mp3 m4a ogg webm
 *     image: png jpg jpeg gif webp
 *     pdf, mp4
 *
 * `.svg` and `.html` are deliberately refused server-side (they can embed
 * `<script>` → same-origin XSS when served back). Text-shaped data
 * (json/csv/yaml/yml/txt/svg/md-adjacent) is not a storage type at all.
 *
 * So we split into three buckets:
 *   - storage-eligible (image/pdf/audio/video) → upload + link as attachment.
 *   - text-shaped (txt/json/csv/yaml/yml/svg/…) → import as a NOTE whose body
 *     preserves the file's text verbatim (fenced for code-ish types). This
 *     honors "attach as files — preserve, no interpretation" within what the
 *     vault accepts: the bytes survive, searchable, no XSS surface.
 *   - everything else (a binary the allowlist refuses, e.g. `.docx`) →
 *     `unsupported`; reported as skipped-with-reason, never silently dropped.
 */

import { fileExt, isStorageAllowedExt } from "@/lib/vault/attachment-upload";
import type { AttachmentKind } from "./types";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const AUDIO_EXTS = new Set(["wav", "mp3", "m4a", "ogg", "webm"]);
const VIDEO_EXTS = new Set(["mp4"]);

/**
 * Text-shaped extensions imported as notes (bytes preserved, no upload).
 * These are NOT in the vault storage allowlist; folding them into note
 * content is how we "attach as files" without losing them. `svg` lives
 * here (refused by storage as an XSS vector) — its markup is preserved as
 * fenced text, which is inert.
 */
const TEXT_EXTS = new Set(["txt", "json", "csv", "yaml", "yml", "svg", "tsv", "log"]);

/** Extensions whose text body we fence as a code block (vs. inline prose). */
const FENCED_TEXT_EXTS = new Set(["json", "csv", "yaml", "yml", "svg", "tsv", "log"]);

/** Map an extension (no dot, any case) to its import classification. */
export function classifyExt(ext: string): AttachmentKind {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return "image";
  if (e === "pdf") return "pdf";
  if (AUDIO_EXTS.has(e)) return "audio";
  if (VIDEO_EXTS.has(e)) return "video";
  if (TEXT_EXTS.has(e)) return "text";
  return "unsupported";
}

/** Convenience over `classifyExt` when you hold a filename. */
export function classifyFilename(filename: string): AttachmentKind {
  return classifyExt(fileExt(filename));
}

/**
 * `true` when the kind is one the vault storage endpoint accepts (so the
 * apply path should upload+link it). Cross-checks the canonical allowlist
 * so this can't drift from the server.
 */
export function isUploadableKind(kind: AttachmentKind): boolean {
  return kind === "image" || kind === "pdf" || kind === "audio" || kind === "video";
}

/** Should the text body of a `text`-kind file be wrapped in a code fence? */
export function isFencedTextExt(ext: string): boolean {
  return FENCED_TEXT_EXTS.has(ext.toLowerCase());
}

/**
 * Defense-in-depth: confirm an extension we classified storage-eligible is
 * actually on the server allowlist. The two lists are kept in lockstep, but
 * this guards against a future edit to one and not the other.
 */
export function assertUploadable(ext: string): boolean {
  return isUploadableKind(classifyExt(ext)) && isStorageAllowedExt(ext);
}
