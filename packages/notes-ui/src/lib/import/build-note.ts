import { parseFrontmatter } from "./frontmatter";
import type { ParsedNote } from "./types";

/**
 * Convert one source file's raw text into a `ParsedNote`. Shared between
 * the Obsidian-zip walker and the loose-markdown reader so the two
 * formats can't drift on tag/path/metadata conventions.
 *
 * Path resolution:
 *   1. Frontmatter `path` wins if present and non-empty (lets the user
 *      override the source layout).
 *   2. Otherwise we derive from `sourcePath`: strip the leading folder
 *      separators, strip the `.md` / `.markdown` extension, normalize
 *      backslashes (Windows zips) → forward slashes.
 *
 * Tag merging:
 *   - Frontmatter `tags` (array or comma-separated string both supported).
 *   - Inline `#hashtag` extraction from the body — same regex Capture
 *     uses (`#[a-zA-Z][\w-]*`) so notes coming through capture vs
 *     import end up with the same tag normalization.
 *   - Deduplicated, lowercased.
 *
 * Wikilinks (`[[name]]`) pass through untouched in `content`. Vault's
 * server resolver handles them on save — same as a note authored via
 * the editor.
 */
export function buildParsedNote(args: {
  sourcePath: string;
  raw: string;
}): ParsedNote {
  const { sourcePath, raw } = args;
  const { data: frontmatter, content } = parseFrontmatter(raw);

  const path = pickPath(frontmatter, sourcePath);
  const id = pickStringField(frontmatter, "id");
  const createdAt =
    pickStringField(frontmatter, "created_at") ?? pickStringField(frontmatter, "createdAt");
  const tags = mergeTags(frontmatter, content);

  // Metadata bag: everything frontmatter said except the keys we hoisted
  // onto first-class fields. Keeps a clean separation between vault's
  // typed columns and the catch-all JSON.
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (k === "id" || k === "path" || k === "tags" || k === "created_at" || k === "createdAt") {
      continue;
    }
    metadata[k] = v;
  }

  const out: ParsedNote = {
    sourcePath,
    path,
    content,
    tags,
    metadata,
  };
  if (id) out.id = id;
  if (createdAt) out.createdAt = createdAt;
  return out;
}

function pickPath(frontmatter: Record<string, unknown>, sourcePath: string): string {
  const fmPath = pickStringField(frontmatter, "path");
  if (fmPath) return normalizePath(fmPath);
  return normalizePath(stripExtension(sourcePath));
}

function pickStringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const v = frontmatter[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return undefined;
}

function stripExtension(p: string): string {
  return p.replace(/\.(md|markdown)$/i, "");
}

/**
 * Normalize a path the way vault's path column expects:
 *   - Backslashes → forward slashes (Obsidian on Windows).
 *   - Collapse double slashes.
 *   - Trim leading/trailing slashes.
 *
 * We do NOT lowercase or slugify — vault accepts the path as authored,
 * and case-preserving import is the friend-friendly default.
 */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

const INLINE_HASHTAG = /(?:^|\s)#([a-zA-Z][\w-]*)/g;

function mergeTags(frontmatter: Record<string, unknown>, content: string): string[] {
  const out = new Set<string>();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const norm = normalizeTagValue(t);
      if (norm) out.add(norm);
    }
  } else if (typeof fmTags === "string") {
    // Obsidian also accepts space- or comma-separated tags. Split on both.
    for (const piece of fmTags.split(/[,\s]+/)) {
      const norm = normalizeTagValue(piece);
      if (norm) out.add(norm);
    }
  }
  for (const m of content.matchAll(INLINE_HASHTAG)) {
    const norm = normalizeTagValue(m[1] ?? "");
    if (norm) out.add(norm);
  }
  return [...out];
}

function normalizeTagValue(v: unknown): string | null {
  if (typeof v !== "string") {
    if (typeof v === "number" || typeof v === "boolean") return String(v).toLowerCase();
    return null;
  }
  // Strip leading `#` (Obsidian frontmatter sometimes writes `tags: [#a]`)
  // and lowercase. Reject empties and anything that wouldn't survive
  // vault's tag regex (a-z, 0-9, dash, underscore, slash for hierarchy).
  const stripped = v.trim().replace(/^#/, "").toLowerCase();
  if (!stripped) return null;
  if (!/^[a-z0-9_/-]+$/.test(stripped)) return null;
  return stripped;
}
