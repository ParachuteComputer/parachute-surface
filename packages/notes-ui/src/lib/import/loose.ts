import { buildParsedNote } from "./build-note";
import { isMarkdownLike } from "./detect";
import { readBlobAsText } from "./read-file";
import type { ParseError, ParsedImport, ParsedNote } from "./types";

/**
 * Parse a flat list of `.md` / `.markdown` files dropped onto the import
 * surface. Filenames map to vault paths (extension stripped) unless the
 * file's frontmatter declares its own `path`.
 *
 * Non-markdown files in the list aren't an error — we just skip them and
 * surface a `parse-error` row in the summary. That keeps drag-drop ergonomic
 * (drop a folder, get markdown imported, get told about everything else).
 */
export async function parseLooseMarkdown(files: File[]): Promise<ParsedImport> {
  const notes: ParsedNote[] = [];
  const errors: ParseError[] = [];

  for (const file of files) {
    if (!isMarkdownLike(file)) {
      errors.push({
        sourcePath: file.name,
        reason: "Not a markdown file (.md / .markdown) — skipped.",
      });
      continue;
    }
    try {
      const raw = await readBlobAsText(file);
      // `webkitRelativePath` carries the in-folder layout when the user
      // picks a directory; falls back to filename for individual file
      // picks or drag-drops outside a folder context.
      const sourcePath = file.webkitRelativePath || file.name;
      const note = buildParsedNote({ sourcePath, raw });
      notes.push(note);
    } catch (err) {
      errors.push({
        sourcePath: file.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    format: "loose-markdown",
    notes,
    errors,
    tags: collectTagSet(notes),
    // Loose-markdown drops don't carry attachments — the picker accepts
    // `.md`/`.markdown` only, and there's no archive to resolve embeds
    // against. Attachment carry-across is an Obsidian-zip feature.
    attachments: [],
  };
}

function collectTagSet(notes: ParsedNote[]): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags) set.add(t);
  return [...set].sort();
}
