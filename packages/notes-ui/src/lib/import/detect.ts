import type { DetectedFormat } from "./types";

/**
 * Heuristic format detector for the file picker.
 *
 * Cheap, by-file-extension only — we don't crack open zips here. The
 * import surface re-classifies after parsing if the contents don't match
 * (e.g. a `.zip` that turns out empty), but at the picker stage we just
 * want a label.
 *
 * Rules:
 *   - A single `.zip` → `obsidian-zip`. (Notion exports are also `.zip`,
 *     but Notion lands in a follow-up; calling it obsidian-zip in the
 *     UI is wrong then but harmless — the parser will surface "no
 *     markdown found".)
 *   - One or more `.md` / `.markdown` files → `loose-markdown`.
 *   - Mixed `.md` + `.zip` → `obsidian-zip` wins (the zip is the bigger
 *     payload; loose files alongside are usually overflow).
 *   - Anything else → `unknown`.
 */
export function detectFormat(files: File[]): DetectedFormat {
  if (files.length === 0) return "unknown";
  const hasZip = files.some(isZipLike);
  if (hasZip) return "obsidian-zip";
  const hasMarkdown = files.some(isMarkdownLike);
  if (hasMarkdown) return "loose-markdown";
  return "unknown";
}

export function isZipLike(file: File): boolean {
  return file.name.toLowerCase().endsWith(".zip");
}

export function isMarkdownLike(file: File): boolean {
  const lower = file.name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}
