import type { Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";

/**
 * What a surface returns when it resolves a `[[wikilink]]` target.
 *
 * The surface owns the URL space: notes-ui resolves to `/n/<id>`,
 * my-vault-ui resolves to entity paths via its own index, a graph explorer
 * might resolve to `/graph?focus=<id>`. The shared layer must not bake one
 * in — so the resolver returns the finished `href` rather than an id the
 * plugin would then template into a hard-coded path (the old notes-ui
 * `{ id } | null` shape forced every consumer onto `/n/<id>`).
 *
 * `exists` drives resolved-vs-unresolved styling (a live link vs the
 * dashed-underline "this note doesn't exist yet" affordance).
 */
export interface WikilinkTarget {
  /** Surface-chosen destination: `/n/<id>`, `/entity/<slug>`, … */
  href: string;
  /** Whether the target resolves to a real note (drives styling). */
  exists: boolean;
}

/**
 * Per-surface wikilink resolver hook.
 *
 * Given the raw target text inside `[[…]]` (before any `|alias`), return a
 * {@link WikilinkTarget}, or `null`.
 *
 * ## ⚠️ `null` vs `{ exists: false }` — two DIFFERENT rendered outcomes
 *
 * This is the single most common source of confusion. The return value picks
 * between two materially different renderings:
 *
 * | Return value                     | Rendered as                              | Navigable? |
 * |----------------------------------|------------------------------------------|------------|
 * | `{ href, exists: true }`         | live link, `wikilink wikilink-resolved`  | ✅ yes      |
 * | `{ href, exists: false }`        | dashed "create-on-navigate" link, `wikilink wikilink-unresolved` | ✅ **yes** |
 * | `null`                           | inert `<span>`, `wikilink wikilink-unresolved`, **no anchor** | ❌ **no**   |
 *
 * The trap: `null` and `{ exists: false }` look interchangeable but are not.
 * `null` drops the link entirely — the words render as styled text the reader
 * can SEE but cannot CLICK. `{ exists: false }` keeps a working link to a
 * destination that doesn't exist YET (the canonical "click to create" /
 * "create-on-navigate" affordance, which is what notes-ui does: an unresolved
 * `[[Foo]]` still navigates to `/n/Foo` where the note gets created).
 *
 * **For most surfaces, "unresolved-but-still-linked" is what you want** — see
 * {@link unresolvedLink} and {@link resolvedLink}, the obvious-default helpers.
 * Reach for `null` only when an unresolved target should have NO destination
 * at all (rare).
 *
 * ```ts
 * // Recommended default — unresolved targets still navigate (create-on-navigate):
 * const resolve: WikilinkResolver = (target) => {
 *   const id = index.lookup(target);
 *   return id ? { href: `/n/${id}`, exists: true } : unresolvedLink(`/n/${target}`);
 * };
 *
 * // Only if you genuinely want unresolved targets to be un-clickable text:
 * const resolve: WikilinkResolver = (target) =>
 *   index.lookup(target) ? { href: `/n/${index.lookup(target)}`, exists: true } : null;
 * ```
 *
 * Trust boundary: the resolver owns the `href` it returns, so it owns the
 * href trust boundary. It must validate the target against a known index and
 * mint hrefs it controls — never echo a vault-authored target string straight
 * back as the `href`. A naïve pass-through resolver (`(t) => ({ href: t, … })`)
 * would let vault-authored content inject `javascript:`-style URIs into the
 * rendered link; this plugin sets the href verbatim and does not sanitize it.
 */
export type WikilinkResolver = (target: string) => WikilinkTarget | null;

/**
 * Helper for the common case: a wikilink target that doesn't resolve to an
 * existing note yet but should STILL be a working link (the
 * "create-on-navigate" affordance — dashed styling, but clickable).
 *
 * Prefer this over returning `null` from a {@link WikilinkResolver} unless you
 * specifically want an un-clickable styled span. See {@link WikilinkResolver}
 * for the `null` vs `{ exists: false }` distinction.
 *
 * ```ts
 * return index.lookup(target)
 *   ? { href: `/n/${id}`, exists: true }
 *   : unresolvedLink(`/n/${target}`);
 * ```
 */
export function unresolvedLink(href: string): WikilinkTarget {
  return { href, exists: false };
}

/**
 * Helper for a RESOLVED wikilink target (an existing note — live link,
 * `wikilink-resolved` styling). The mirror of {@link unresolvedLink}.
 *
 * ```ts
 * return index.lookup(target) ? resolvedLink(`/n/${id}`) : unresolvedLink(`/n/${target}`);
 * ```
 */
export function resolvedLink(href: string): WikilinkTarget {
  return { href, exists: true };
}

/**
 * The "no link at all" sentinel — return this (or `null`) from a
 * {@link WikilinkResolver} when an unresolved target should render as inert
 * styled text with NO anchor. Named so call sites read intentionally:
 *
 * ```ts
 * return index.lookup(target) ? resolvedLink(href) : INERT; // un-clickable
 * ```
 *
 * Most surfaces want {@link unresolvedLink} instead (still navigable).
 */
export const INERT = null;

/** Class names emitted onto the link node; a surface styles against these. */
export const WIKILINK_CLASS = "wikilink";
export const WIKILINK_RESOLVED_CLASS = "wikilink wikilink-resolved";
export const WIKILINK_UNRESOLVED_CLASS = "wikilink wikilink-unresolved";

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

interface ParentWithChildren {
  children: RootContent[];
}

function splitTextNode(text: string, resolve: WikilinkResolver): RootContent[] {
  const out: RootContent[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(WIKILINK_RE)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      out.push({ type: "text", value: text.slice(lastIndex, matchIndex) });
    }
    const target = match[1]?.trim() ?? "";
    const display = (match[2]?.trim() || target).trim();
    const resolved = resolve(target);

    if (resolved === null) {
      // No link — emit styled inert text the surface can target via the
      // unresolved class. We still render the display text so the reader
      // sees the words; the absent href is the "dead link" signal.
      out.push({
        type: "text",
        value: display,
        data: {
          hName: "span",
          hProperties: {
            className: WIKILINK_UNRESOLVED_CLASS,
            "data-wikilink-target": target,
            "data-wikilink-resolved": "false",
          },
        },
        // mdast text nodes don't normally carry `data`, but rehype reads
        // `data.hName`/`data.hProperties` off any node — this turns the
        // text into a styled <span> without introducing a link.
      } as Text & { data: unknown });
      lastIndex = matchIndex + match[0].length;
      continue;
    }

    out.push({
      type: "link",
      url: resolved.href,
      title: null,
      children: [{ type: "text", value: display }],
      data: {
        hProperties: {
          className: resolved.exists ? WIKILINK_RESOLVED_CLASS : WIKILINK_UNRESOLVED_CLASS,
          "data-wikilink-target": target,
          "data-wikilink-resolved": resolved.exists ? "true" : "false",
        },
      },
    });
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex === 0) return [{ type: "text", value: text }];
  if (lastIndex < text.length) out.push({ type: "text", value: text.slice(lastIndex) });
  return out;
}

function transformChildren(node: ParentWithChildren, resolve: WikilinkResolver): void {
  const next: RootContent[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      const pieces = splitTextNode((child as Text).value, resolve);
      next.push(...pieces);
      continue;
    }
    // Never touch code — `[[x]]` inside a fenced block or inline code is
    // literal, not a wikilink.
    if (child.type === "code" || child.type === "inlineCode") {
      next.push(child);
      continue;
    }
    if ("children" in child && Array.isArray((child as { children?: unknown[] }).children)) {
      transformChildren(child as unknown as ParentWithChildren, resolve);
    }
    next.push(child);
  }
  node.children = next;
}

/**
 * remark plugin that rewrites `[[target]]` / `[[target|alias]]` into link
 * nodes via a per-surface {@link WikilinkResolver}. The resolver owns the
 * href; this plugin owns parsing + the resolved/unresolved class contract.
 *
 * Embeds (`![[…]]`) are intentionally NOT handled here — see the package
 * README and the embed primitives. The canonical embed path is
 * `![](/api/storage/…)` standard-markdown images (what the Obsidian import
 * rewrites embeds to), rendered by `<VaultImage>` / `<VaultAudio>`.
 */
export const remarkWikilinks: Plugin<[{ resolve: WikilinkResolver }], Root> = ({ resolve }) => {
  return (tree) => {
    transformChildren(tree as unknown as ParentWithChildren, resolve);
  };
};
