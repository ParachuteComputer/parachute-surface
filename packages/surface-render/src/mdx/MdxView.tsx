import type { ComponentType, ReactElement } from "react";
import { MarkdownView, type MarkdownViewProps } from "../markdown/MarkdownView.js";

/**
 * Allowlist of components a surface explicitly permits MDX to render. Keys
 * are tag names; values are the React components to mount. Only listed tags
 * evaluate — everything else falls back to markdown rendering.
 */
export type MdxComponents = Record<string, ComponentType<Record<string, unknown>>>;

/**
 * The opt-in MDX evaluation seam. A surface that genuinely wants live MDX
 * supplies an `evaluate` function (backed by its own MDX runtime, e.g.
 * `@mdx-js/mdx`'s `evaluate`) plus the `mdxComponents` allowlist that runtime
 * is allowed to mount. surface-render deliberately does NOT bundle an MDX
 * runtime — evaluating arbitrary note content as code is a trust decision the
 * surface must make in its own code.
 *
 * @param source     the raw MDX source
 * @param components  the allowlisted components the runtime may mount
 * @returns a rendered React element
 */
export type MdxEvaluate = (source: string, components: MdxComponents) => ReactElement;

export interface MdxViewProps extends MarkdownViewProps {
  /**
   * Opt-in MDX runtime. When omitted (the default), `content` is rendered
   * **as markdown** — JSX expressions and component tags are inert, never
   * executed. This is safe-by-default: arbitrary vault MDX cannot run code.
   *
   * Supplying `evaluate` is an explicit "I am evaluating note content as
   * code; I trust this vault's authorship" decision.
   */
  evaluate?: MdxEvaluate;
  /**
   * The components allowlist passed to `evaluate` when it is supplied.
   * Present alone (without `evaluate`) this does NOTHING — MDX still renders
   * as plain markdown. Off by default.
   */
  mdxComponents?: MdxComponents;
}

/**
 * Render `.mdx` content.
 *
 * **Default (safe): renders as Markdown.** No JSX execution, no component
 * evaluation, no expression evaluation — `.mdx` goes through the same
 * `MarkdownView` path as `.md` (GFM, wikilinks, media). Component tags and
 * `{expressions}` are treated as inert text/markup. Nothing in arbitrary
 * vault MDX runs as code.
 *
 * **Opt-in (the surface's explicit trust decision): pass `evaluate` +
 * `mdxComponents`.** Only then does MDX actually evaluate, and only the
 * allowlisted components mount. The surface brings its own MDX runtime; this
 * package never bundles one.
 */
export function MdxView({ evaluate, mdxComponents, ...markdownProps }: MdxViewProps) {
  if (evaluate) {
    // Opt-in path: the surface supplied a runtime + an allowlist. Only the
    // allowlisted components can mount.
    return evaluate(markdownProps.content, mdxComponents ?? {});
  }
  // Safe default: render as markdown. No code executes.
  return <MarkdownView {...markdownProps} />;
}
