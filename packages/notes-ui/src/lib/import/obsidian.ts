import JSZip from "jszip";
import { classifyFilename } from "./attachments";
import { buildParsedNote } from "./build-note";
import type { CollectedAttachment, ParseError, ParsedImport, ParsedNote } from "./types";

/**
 * Parse an Obsidian vault delivered as a `.zip`.
 *
 * Walks every entry in the archive, picks the `.md` / `.markdown` files,
 * decodes their text, and produces one `ParsedNote` per source file. Every
 * NON-markdown entry (images, PDFs, audio, json/csv/yaml, …) is collected
 * as a `CollectedAttachment` (path + bytes + classification) so the apply
 * path can bring it across via the upload→link→served-markdown chain —
 * attachments no longer silently vanish (the v1 "out of scope" gap).
 *
 * Intake exclusion (`isExcludedPath`, shared with the vault CLI per the
 * alignment contract §1.9) skips — for BOTH notes and attachments:
 *
 *   - `.obsidian/` (the workspace config — every Obsidian vault ships one
 *     and importing it as notes would create dozens of useless
 *     JSON-shaped junk paths; its bundled icons/snippets aren't user
 *     content either).
 *   - `.trash/` (Obsidian's "deleted notes" holding area — if they're
 *     there the user threw them away on purpose).
 *   - `.git/`, `.parachute/`, `__MACOSX/`, `node_modules/`, and any
 *     other dot-prefixed segment (generic dotfile/dotdir rule).
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
      attachments: [],
    };
  }

  const notes: ParsedNote[] = [];
  const errors: ParseError[] = [];
  const attachments: CollectedAttachment[] = [];

  // JSZip's `files` is a flat map { fullPath: ZipObject } — easier to
  // iterate than the nested `folder()` API for our walk-everything case.
  const entries: Array<{ path: string; obj: JSZip.JSZipObject }> = [];
  zip.forEach((path, obj) => {
    entries.push({ path, obj });
  });

  // Sort for deterministic order in the dry-run summary — operator-friendly
  // diff against the source filesystem.
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // Determine the wrapping folder ONCE (over markdown entries, the same
  // signal as before: the zip-from-above-vault shape `MyVault/Note.md`) and
  // strip it from BOTH notes and attachments so an embed's resolved path
  // lines up with the note's source layout. Computing it once also avoids
  // the prior O(n²) per-markdown-entry recompute.
  const commonRoot = detectCommonRoot(entries);

  for (const { path, obj } of entries) {
    if (obj.dir) continue;
    if (isExcludedPath(path)) continue;
    const sourcePath = applyCommonRoot(path, commonRoot);
    if (isMarkdownEntry(path)) {
      try {
        const raw = await obj.async("string");
        const note = buildParsedNote({ sourcePath, raw });
        notes.push(note);
      } catch (err) {
        errors.push({
          sourcePath: path,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    // Non-markdown entry → collect as an attachment (bytes + classification)
    // so the apply path can upload/link/rewrite it. A single unreadable blob
    // becomes a parse-error row rather than aborting the whole import — the
    // file still shows up in the report instead of silently vanishing.
    try {
      const blob = await obj.async("blob");
      const filename = baseName(sourcePath);
      attachments.push({
        sourcePath,
        filename,
        ext: extOf(filename),
        kind: classifyFilename(filename),
        blob,
      });
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
    attachments,
  };
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
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
 * Detect the single wrapping folder shared by every markdown entry, or
 * `null` if there isn't one. Returns the bare segment (no trailing slash).
 *
 * The common case we're targeting: Obsidian exports zipped from above the
 * vault folder (`MyVault/Note.md`, `MyVault/Sub/Other.md`). The wrapping
 * `MyVault/` segment isn't part of the user's chosen structure — it's an
 * accident of where they ran the zip from — so stripping it produces
 * cleaner paths in the vault.
 *
 * There is a (small) downside: a flat zip whose only contents are
 * `Notes/A.md` and `Notes/B.md` will also have `Notes/` detected,
 * collapsing both to top-level. That's the price of a simple, single-pass
 * heuristic; users with a critical folder structure can always override
 * per-note via frontmatter `path:` or unzip + re-zip the parent.
 *
 * Only MARKDOWN entries drive detection — a top-level `image.png` (which is
 * now collected as an attachment, not skipped) shouldn't perturb the
 * folder-strip signal. But the detected root is then applied to attachments
 * too (`applyCommonRoot`), so an attachment under `MyVault/assets/a.png`
 * lands at `assets/a.png`, lining up with how the note refers to it.
 */
function detectCommonRoot(entries: Array<{ path: string }>): string | null {
  let commonRoot: string | null = null;
  for (const e of entries) {
    if (isExcludedPath(e.path)) continue;
    if (!isMarkdownEntry(e.path)) continue;
    const seg = e.path.split("/")[0] ?? "";
    // A markdown file with no folder (`Top.md`) means there's no single
    // wrapping root — bail.
    if (!e.path.includes("/")) return null;
    if (commonRoot === null) {
      commonRoot = seg;
    } else if (seg !== commonRoot) {
      return null;
    }
  }
  return commonRoot;
}

/** Strip `root/` off `path` when present; otherwise return `path` intact. */
function applyCommonRoot(path: string, root: string | null): string {
  if (root && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1);
  }
  return path;
}

function collectTagSet(notes: ParsedNote[]): string[] {
  const set = new Set<string>();
  for (const n of notes) for (const t of n.tags) set.add(t);
  return [...set].sort();
}
