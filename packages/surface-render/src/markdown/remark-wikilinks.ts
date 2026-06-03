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
 * {@link WikilinkTarget}, or `null` to mean "I can't resolve this — render
 * the unresolved affordance." Returning a `{ href, exists: false }` is also
 * valid (e.g. notes-ui links unresolved targets to a create-on-navigate
 * route); `null` is the "no link at all, just styled text" signal.
 */
export type WikilinkResolver = (target: string) => WikilinkTarget | null;

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
