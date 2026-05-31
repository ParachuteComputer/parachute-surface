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
 *   - Inline `#hashtag` extraction from the body, AFTER stripping fenced
 *     code blocks + inline code spans (so a `#tag` inside code is not
 *     harvested) — see the canonical regex + `stripCode` below. Aligned
 *     with the vault CLI importer (contract §1.3).
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
    pickTimestampField(frontmatter, "created_at") ?? pickTimestampField(frontmatter, "createdAt");
  const updatedAt =
    pickTimestampField(frontmatter, "updated_at") ?? pickTimestampField(frontmatter, "updatedAt");
  const tags = mergeTags(frontmatter, content);

  // Metadata bag: everything frontmatter said except the keys we hoisted
  // onto first-class fields. Keeps a clean separation between vault's
  // typed columns and the catch-all JSON. The hoisted key set MUST match
  // the vault CLI's (id, path, tags, created_at/createdAt,
  // updated_at/updatedAt) so the two importers produce the same metadata.
  const HOISTED_KEYS = new Set([
    "id",
    "path",
    "tags",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
  ]);
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (HOISTED_KEYS.has(k)) continue;
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
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

function pickPath(frontmatter: Record<string, unknown>, sourcePath: string): string {
  const fmPath = pickStringField(frontmatter, "path");
  // Strip a trailing `.md`/`.markdown` on BOTH branches — a frontmatter
  // `path: My/Note.md` override must normalize to `My/Note`, matching the
  // CLI's `normalizeImportPath` (alignment contract §1.8). Without this the
  // web yields `My/Note.md` while the CLI yields `My/Note`, causing a 409 +
  // broken wikilinks on re-import.
  if (fmPath) return normalizePath(stripExtension(fmPath));
  return normalizePath(stripExtension(sourcePath));
}

function pickStringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const v = frontmatter[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return undefined;
}

/**
 * Hoist a timestamp field (`created_at` / `updated_at` and camelCase
 * variants) as a trimmed string, verbatim — NO Date coercion/validation
 * (alignment contract §1.6). Accepts a number too: a bare YAML year like
 * `created_at: 2024` is parsed as the number `2024` by the YAML subset,
 * so we stringify it (→ `"2024"`) to match the contract's
 * FX-METADATA-EXCLUSIONS expected value and the CLI's stringified
 * timestamp (the CLI's `restoreNoteTimestamps` takes a string). ISO
 * timestamps are always strings already and pass through untouched.
 */
function pickTimestampField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const v = frontmatter[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
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

/**
 * Canonical inline-tag regex (Obsidian's actual rule; shared with the
 * vault CLI per the alignment contract §1.3):
 *   - `#` at line start or after whitespace (`(?:^|\s)`), so `foo#bar`
 *     does not match.
 *   - Tag body chars are `[A-Za-z0-9_/-]` — letters, digits, underscore,
 *     hyphen, and slash for hierarchy (`#area/sub`).
 *   - The tag MUST contain at least one non-numeric char (the
 *     `[A-Za-z_/-]` in the middle forces a non-digit), so `#2024` is
 *     NOT a tag while `#v2` / `#2024-plan` / `#area/sub` are.
 */
const INLINE_HASHTAG = /(?:^|\s)#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

/**
 * Strip fenced code blocks and inline code spans before inline-tag
 * extraction, so a `#tag` inside ``` ```fences``` ``` or `` `inline code` ``
 * is NOT harvested as a real tag. This was the headline web bug — the
 * web parser previously ran the hashtag regex over the raw body.
 *
 * Known limitation (shared with the CLI, documented, not fixed here):
 * `~~~`-fenced and 4-space-indented code blocks are NOT stripped, so
 * `#tags` inside those still extract.
 */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
}

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
  const stripped = stripCode(content);
  for (const m of stripped.matchAll(INLINE_HASHTAG)) {
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
