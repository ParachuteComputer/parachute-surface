import JSZip from "jszip";
import { buildParsedNote } from "./build-note";
import type { ParseError, ParsedImport, ParsedNote } from "./types";

/**
 * Parse an Obsidian vault delivered as a `.zip`.
 *
 * Walks every entry in the archive, picks the `.md` / `.markdown` files,
 * decodes their text, and produces one `ParsedNote` per source file.
 * Intake exclusion (`isExcludedPath`, shared with the vault CLI per the
 * alignment contract §1.9) skips:
 *
 *   - `.obsidian/` (the workspace config — every Obsidian vault ships one
 *     and importing it as notes would create dozens of useless
 *     JSON-shaped junk paths).
 *   - `.trash/` (Obsidian's "deleted notes" holding area — if they're
 *     there the user threw them away on purpose).
 *   - `.git/`, `.parachute/`, `__MACOSX/`, `node_modules/`, and any
 *     other dot-prefixed segment (generic dotfile/dotdir rule).
 *
 * Non-markdown entries (images, PDFs, JSON, etc.) aren't surfaced as
 * errors — they're a routine part of an Obsidian vault and the import
 * UX would be noisy if we listed every PNG as "skipped." Attachments
 * are out of scope for v1 (the create-note path doesn't carry binary
 * attachments either; that's a follow-up).
 *
 * If the archive doesn't contain any `.md` files, we still return a
 * `ParsedImport` with `notes: []` — the UI surfaces this as
 * "no markdown found in archive" rather than throwing.
 */
export async function parseObsidianZip(file: File): Promise<ParsedImport> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    return {
      format: "obsidian-zip",
      notes: [],
      errors: [
        {
          sourcePath: file.name,
          reason: `Could not read zip: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      tags: [],
    };
  }

  const notes: ParsedNote[] = [];
  const errors: ParseError[] = [];

  // JSZip's `files` is a flat map { fullPath: ZipObject } — easier to
  // iterate than the nested `folder()` API for our walk-everything case.
  const entries: Array<{ path: string; obj: JSZip.JSZipObject }> = [];
  zip.forEach((path, obj) => {
    entries.push({ path, obj });
  });

  // Sort for deterministic order in the dry-run summary — operator-friendly
  // diff against the source filesystem.
  entries.sort((a, b) => a.path.localeCompare(b.path));

  for (const { path, obj } of entries) {
    if (obj.dir) continue;
    if (isExcludedPath(path)) continue;
    if (!isMarkdownEntry(path)) continue;
    try {
      const raw = await obj.async("string");
      // Strip the top-level folder if the zip was created from inside the
      // vault folder (common Obsidian export shape: `MyVault/Note.md`).
      // We keep the user's intra-vault structure intact; just lose the
      // wrapping directory if there is one. The detector is "every entry
      // shares the same top segment" — same heuristic GitHub uses for
      // `tarball/zipball` downloads.
      const sourcePath = stripCommonRoot(path, entries);
      const note = buildParsedNote({ sourcePath, raw });
      notes.push(note);
    } catch (err) {
      errors.push({
        sourcePath: path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    format: "obsidian-zip",
    notes,
    errors,
    tags: collectTagSet(notes),
  };
}

/**
 * Named internal/tooling segments excluded regardless of the generic
 * dotfile rule. The dot-prefixed ones (`.obsidian`, `.trash`, `.git`,
 * `.parachute`) are also caught by the generic `startsWith(".")` check
 * below; they're kept explicit for readability. `__MACOSX` and
 * `node_modules` don't start with `.`, so they need the named set.
 */
const EXCLUDED_SEGMENTS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  ".parachute",
  "__MACOSX",
  "node_modules",
]);

/**
 * Intake (file-selection) exclusion — applied identically by both the
 * vault CLI and this web importer per the alignment contract §1.9.
 *
 * Exclude (return true) if ANY path segment is in the named set above OR
 * starts with `.` (generic dotfile/dotdir). The generic dot rule means a
 * legit dot-prefixed user note like `.daily-note.md` is also excluded —
 * documented, chosen behavior matching the CLI's long-standing skip.
 */
export function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((seg) => EXCLUDED_SEGMENTS.has(seg) || seg.startsWith("."));
}

function isMarkdownEntry(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * If every markdown entry shares the same first folder segment, drop it.
 * Otherwise return `path` unchanged.
 *
 * The common case we're targeting: Obsidian exports zipped from above
 * the vault folder (`MyVault/Note.md`, `MyVault/Sub/Other.md`). The
 * wrapping `MyVault/` segment isn't part of the user's chosen structure
 * — it's an accident of where they ran the zip from — so stripping it
 * produces cleaner paths in the vault.
 *
 * There is a (small) downside: a flat zip whose only contents are
 * `Notes/A.md` and `Notes/B.md` will also have `Notes/` stripped,
 * collapsing both to top-level. That's the price of a simple, single-
 * pass heuristic; users with a critical folder structure can always
 * override per-note via frontmatter `path:` or unzip + re-zip the parent.
 *
 * Files are inspected (not non-markdown entries) because non-markdown
 * (images, JSON, attachments) are skipped before reaching here — a
 * top-level `image.png` shouldn't perturb the markdown-folder detection.
 */
function stripCommonRoot(path: string, entries: Array<{ path: string }>): string {
  const firstSegment = path.split("/")[0];
  if (!firstSegment) return path;
  let commonRoot: string | null = firstSegment;
  for (const e of entries) {
    if (isExcludedPath(e.path)) continue;
    if (!isMarkdownEntry(e.path)) continue;
    const seg = e.path.split("/")[0];
    if (seg !== commonRoot) {
      commonRoot = null;
      break;
    }
  }
  // A path with no `/` (the entry IS the file, no folder) can't be
  // stripped because that would leave an empty path. Bail in that case
  // so a flat-root markdown file survives intact.
  if (commonRoot && path.startsWith(`${commonRoot}/`)) {
    return path.slice(commonRoot.length + 1);
  }
  return path;
}

function collectTagSet(notes: ParsedNote[]): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags) set.add(t);
  return [...set].sort();
}
