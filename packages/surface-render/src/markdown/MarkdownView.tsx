import type { ComponentType, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { VaultImage } from "../embed/VaultImage.js";
import type { FetchBlob } from "../embed/fetch-blob.js";
import type { HighlightFn } from "../formats/highlight.js";
import { type WikilinkResolver, remarkWikilinks } from "./remark-wikilinks.js";

/**
 * Props a surface-supplied link component receives. A surface passes its
 * router's `<Link>` (wrapped to this shape) so wikilinks and internal links
 * navigate client-side instead of full-page-reloading — without the shared
 * layer importing any router.
 */
export interface LinkComponentProps {
  href: string;
  className?: string;
  children?: ReactNode;
}

export type LinkComponent = ComponentType<LinkComponentProps>;

/**
 * Default link component — a plain anchor. External links open in a new tab;
 * internal (`/…`, `#…`) links render as same-document anchors. A surface that
 * wants client-side routing passes its own `linkComponent`.
 */
const DefaultLink: LinkComponent = ({ href, className, children }) => {
  const isExternal = /^https?:\/\//.test(href) && !href.startsWith("/");
  if (isExternal) {
    return (
      <a href={href} className={className} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
};

export interface MarkdownViewProps {
  /** The markdown source to render. */
  content: string;
  /**
   * Per-surface wikilink resolver. `[[target]]` → a link via the resolver's
   * `href`, styled resolved/unresolved by `exists`. See {@link WikilinkResolver}.
   * Omit to disable wikilink handling entirely (plain markdown).
   */
  resolve?: WikilinkResolver;
  /**
   * Surface-supplied link component (e.g. React Router `<Link>` adapted to
   * {@link LinkComponentProps}). Defaults to a plain `<a>`. Receives both
   * wikilinks and ordinary internal/external links.
   */
  linkComponent?: LinkComponent;
  /**
   * Auth'd blob fetcher for `/api/storage/…` images. Required for vault
   * media to render; pass `vaultClientFetchBlob(client)` or a custom
   * `(url) => Promise<Blob>`. Omit if the content has no vault media.
   */
  fetchBlob?: FetchBlob;
  /**
   * Per-element renderer overrides, merged over the defaults. Lets a surface
   * customize any markdown element (`h1`, `code`, `table`, …) without
   * forking the view. Override `img` / `a` to fully replace media/link
   * handling.
   */
  components?: Components;
  /**
   * Container class. Defaults to `prose-note` (the class notes-ui styles
   * against). Pass `""` to opt out of the default prose container.
   */
  className?: string;
  /**
   * Syntax highlighter for fenced code blocks (```​lang … ```), wired into the
   * markdown `code` renderer so the SAME `highlight` hook colors both
   * "a fenced block inside a `.md` note" *and* "a whole `.ts`/`.json`/`.yaml`
   * note" (which the format renderers color via {@link HighlightFn}). This
   * unifies the two highlight paths under one prop — pass `highlight` once to
   * `<NoteRenderer>` and every code path colors consistently.
   *
   * Output markup matches `<CodeRenderer>`: `<pre><code class="hljs
   * language-X">`, so one stylesheet themes both. The default (omit it) leaves
   * fenced code unstyled — no dependency, no coloring.
   *
   * **Don't combine with `rehypePlugins={[rehypeHighlight]}`.** They are two
   * routes to the same result; using both double-processes fenced code. Pick
   * one: `highlight` (recommended — same hook the format renderers use, no
   * extra peer dep) OR `rehypePlugins={[rehypeHighlight]}` (the older path,
   * needs the optional `rehype-highlight` peer). When `highlight` is set, the
   * built-in `code` override takes precedence; a `components.code` override you
   * pass still wins over both.
   */
  highlight?: HighlightFn;
  /**
   * remark plugins appended after the built-ins (gfm + wikilinks). Use to add
   * footnotes, math, etc.
   */
  remarkPlugins?: NonNullable<React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;
  /**
   * rehype plugins. Defaults to none. An alternative to the `highlight` prop
   * for fenced-code coloring: a surface can instead pass `[rehypeHighlight]`
   * here (the package keeps `rehype-highlight` an optional peer so
   * non-highlighting surfaces don't pull it in). Prefer the `highlight` prop —
   * it shares the hook the format renderers use and needs no extra peer. Use
   * one or the other, never both (see `highlight`).
   */
  rehypePlugins?: NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;
}

/**
 * The core markdown renderer for Parachute surfaces.
 *
 * Wraps `react-markdown` with:
 *  - GFM (tables, strikethrough, task lists),
 *  - the {@link remarkWikilinks} plugin wired to a per-surface `resolve` hook,
 *  - an `img` override that routes `/api/storage/…` images through the
 *    auth'd {@link VaultImage} (when `fetchBlob` is supplied),
 *  - an `a` override that renders wikilinks + internal links via the
 *    surface's `linkComponent` (default plain `<a>`),
 *  - a documented default class contract (`prose-note` container,
 *    `wikilink`/`wikilink-resolved`/`wikilink-unresolved` link classes).
 *
 * Everything is overridable via `components`, `remarkPlugins`,
 * `rehypePlugins`, `linkComponent`, and `className`.
 */
/**
 * Pull a highlight.js-style language id out of react-markdown's `code`
 * `className` (`language-ts` → `ts`). Returns `""` when absent.
 */
function languageFromClass(className: unknown): string {
  if (typeof className !== "string") return "";
  const m = className.match(/(?:^|\s)language-([^\s]+)/);
  return m?.[1] ?? "";
}

/** Flatten a code node's children to its raw source text. */
function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(codeText).join("");
  return children == null ? "" : String(children);
}

export function MarkdownView({
  content,
  resolve,
  linkComponent,
  fetchBlob,
  components,
  className = "prose-note",
  highlight,
  remarkPlugins,
  rehypePlugins,
}: MarkdownViewProps) {
  const Link = linkComponent ?? DefaultLink;

  const defaultComponents: Components = {
    img({ node: _node, src, alt, className: imgClass }) {
      if (typeof src !== "string" || !src) return null;
      return <VaultImage src={src} alt={alt ?? ""} className={imgClass} fetchBlob={fetchBlob} />;
    },
    a({ node: _node, href, className: linkClass, children }) {
      const classes = typeof linkClass === "string" ? linkClass : "";
      const target = typeof href === "string" ? href : "#";
      return (
        <Link href={target} className={classes || undefined}>
          {children}
        </Link>
      );
    },
    // When a `highlight` hook is supplied, color fenced code blocks through it
    // — the SAME hook the format renderers use, so markdown fences and whole
    // code notes look identical. Only fenced blocks (those carrying a
    // `language-…` class) are highlighted; inline code is left untouched so it
    // keeps `.prose-note code` inline styling. Emits the same
    // `<code class="hljs language-X">` markup as <CodeRenderer> so one
    // stylesheet themes both. Omitted entirely when no `highlight` is passed,
    // so the rehype-highlight path (and the no-coloring default) are unchanged.
    ...(highlight
      ? {
          code({ node: _node, className: codeClass, children, ...rest }) {
            const language = languageFromClass(codeClass);
            if (!language) {
              // inline code — leave as-is.
              return (
                <code className={typeof codeClass === "string" ? codeClass : undefined} {...rest}>
                  {children}
                </code>
              );
            }
            const html = highlight(codeText(children), language);
            return (
              <code
                className={`hljs language-${language}`}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: the highlight hook is contracted to return sanitized HTML (escape-only by default); same contract as <CodeRenderer>.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          },
        }
      : {}),
  };

  const mergedComponents: Components = { ...defaultComponents, ...components };

  type RemarkPlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;
  const remark: RemarkPlugins = [
    remarkGfm,
    ...(resolve ? ([[remarkWikilinks, { resolve }]] as RemarkPlugins) : []),
    ...(remarkPlugins ?? []),
  ];

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remark}
        rehypePlugins={rehypePlugins}
        components={mergedComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
