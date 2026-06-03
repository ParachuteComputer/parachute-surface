/**
 * Resolve attachment references in note content against the files bundled
 * in an Obsidian zip, and rewrite them to the served-markdown shape that
 * renders via `VaultImage` (`![filename](/api/storage/<path>)` for images,
 * `[filename](/api/storage/<path>)` for everything else).
 *
 * Four reference syntaxes are matched (per the task spec):
 *   1. Obsidian embed:    `![[file.ext]]`        (and `![[file.ext|alt]]`)
 *   2. Obsidian wikilink: `[[file.ext]]`         (and `[[path/file.ext|alt]]`)
 *   3. Markdown image:    `![alt](relative.ext)` (incl. `%20`-encoded spaces)
 *   4. Markdown link:     `[text](relative.ext)`
 *
 * Resolution heuristic — how an Obsidian reference name maps to a bundled
 * file (judgment calls, documented):
 *   - Obsidian's own resolver is "shortest-path / by basename": `![[a.png]]`
 *     finds the file named `a.png` anywhere in the vault. So the PRIMARY
 *     match key is the basename (case-insensitive), URL-decoded.
 *   - A reference MAY carry a subpath (`![[sub/a.png]]`, `![](../img/a.png)`).
 *     We first try an exact suffix match on the normalized relative path
 *     (so `sub/a.png` prefers `.../sub/a.png` over a different `a.png`),
 *     then fall back to basename.
 *   - `[[wikilink]]` WITHOUT a file extension is a note link, NOT an
 *     attachment — left untouched (vault's wikilink resolver handles those
 *     server-side). Only extension-bearing wikilinks that resolve to a
 *     collected attachment are rewritten.
 *   - A reference that matches nothing is left verbatim (could be a note
 *     wikilink, an external URL, or an attachment we couldn't classify).
 *
 * Only references whose target is in `pathByFilename` (the storage paths of
 * attachments we actually uploaded) get rewritten; unresolved or
 * non-uploaded references pass through unchanged.
 */

/** A resolved attachment: its served storage path + whether it's an image. */
export interface ResolvedAttachment {
  /** Original archive path (the key used to link the right attachment). */
  sourcePath: string;
  /** Vault storage path returned by upload (e.g. `2026-06-02/uuid.png`). */
  storagePath: string;
  /** Render as `![]()` (image) vs `[]()` (link). */
  isImage: boolean;
  /** Display name to use as the markdown label. */
  filename: string;
}

/**
 * Index of uploadable attachments keyed for lookup. We hold two maps:
 *   - `byBasename`: lowercased basename → resolved (Obsidian's default).
 *   - `byPath`: lowercased full relative path → resolved (for subpath refs).
 * On a basename collision the first-collected file wins and the rest are
 * still reachable via their full path; this matches Obsidian's "shortest
 * path wins, disambiguate by folder" behavior closely enough for import.
 */
export interface AttachmentIndex {
  byBasename: Map<string, ResolvedAttachment>;
  byPath: Map<string, ResolvedAttachment>;
}

export function buildAttachmentIndex(entries: ResolvedAttachment[]): AttachmentIndex {
  const byBasename = new Map<string, ResolvedAttachment>();
  const byPath = new Map<string, ResolvedAttachment>();
  for (const resolved of entries) {
    const base = resolved.filename.toLowerCase();
    if (!byBasename.has(base)) byBasename.set(base, resolved);
    byPath.set(normalizeRefPath(resolved.sourcePath), resolved);
  }
  return { byBasename, byPath };
}

/** Lowercase, URL-decode, strip leading `./` and `/`, collapse backslashes. */
function normalizeRefPath(ref: string): string {
  let s = ref.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // leave as-is if it isn't valid percent-encoding
  }
  s = s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return s.toLowerCase();
}

function basename(ref: string): string {
  const norm = normalizeRefPath(ref);
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Does `ref` end in a file extension (so it's an attachment, not a note)? */
function hasExtension(ref: string): boolean {
  return /\.[a-z0-9]+$/i.test(basename(ref));
}

function lookup(index: AttachmentIndex, ref: string): ResolvedAttachment | null {
  const path = normalizeRefPath(ref);
  // Prefer an exact full-path match, then a suffix match (`sub/a.png`
  // matching `vault/sub/a.png`), then fall back to basename.
  const exact = index.byPath.get(path);
  if (exact) return exact;
  for (const [p, resolved] of index.byPath) {
    if (p === path || p.endsWith(`/${path}`)) return resolved;
  }
  return index.byBasename.get(basename(ref)) ?? null;
}

function servedMarkdown(resolved: ResolvedAttachment, label: string): string {
  const url = `/api/storage/${resolved.storagePath}`;
  const name = label || resolved.filename;
  return resolved.isImage ? `![${name}](${url})` : `[${name}](${url})`;
}

/**
 * Rewrite every resolvable attachment reference in `content` to served
 * markdown. Unresolved references (note wikilinks, external URLs,
 * unclassified files) are left exactly as they were. Returns the rewritten
 * content, the count of references rewritten, and the SET of attachment
 * `sourcePath`s that were referenced (so the caller can link exactly those
 * attachments to the note — no URL re-scan needed).
 */
export function rewriteReferences(
  content: string,
  index: AttachmentIndex,
): { content: string; rewritten: number; referenced: Set<string> } {
  let rewritten = 0;
  const referenced = new Set<string>();

  // 1) Obsidian embeds + wikilinks: `![[target|alt]]` / `[[target|alt]]`.
  //    The embed (`!`) and bare-wikilink forms only differ in rendering;
  //    both reference the same target, so one pass handles both. We capture
  //    the optional leading `!`, the target up to a `|` or `#`, and ignore
  //    the alias/size suffix.
  const wiki = /(!?)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  const afterWiki = content.replace(wiki, (whole, _bang: string, target: string) => {
    if (!hasExtension(target)) return whole; // note link — leave to vault resolver
    const resolved = lookup(index, target);
    if (!resolved) return whole;
    rewritten++;
    referenced.add(resolved.sourcePath);
    // Embeds keep their image/link nature from the file type, not the `!`.
    return servedMarkdown(resolved, basename(target));
  });

  // 2) Standard markdown image + link: `![alt](target)` / `[text](target)`.
  //    Only rewrite when the target resolves to a collected attachment —
  //    external URLs and unmatched relative paths pass through. The target
  //    may carry a `"title"` after a space; capture only the URL token.
  const md = /(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(\s+[^)]*)?\)/g;
  const afterMd = afterWiki.replace(
    md,
    (whole, _bang: string, text: string, rawTarget: string, _title: string) => {
      const target =
        rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
      // Leave absolute/external + already-served targets alone.
      if (/^(https?:|mailto:|tel:|#|\/api\/storage\/)/i.test(target.trim())) return whole;
      if (!hasExtension(target)) return whole;
      const resolved = lookup(index, target);
      if (!resolved) return whole;
      rewritten++;
      referenced.add(resolved.sourcePath);
      // Preserve the author's alt/text if they wrote one; else use filename.
      const label = text.trim() || basename(target);
      return servedMarkdown(resolved, label);
    },
  );

  return { content: afterMd, rewritten, referenced };
}

// Exposed for unit tests of the resolver internals.
export const __testing = { normalizeRefPath, basename, hasExtension, lookup };
