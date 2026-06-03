import { useMemo } from "react";
import { type HighlightFn, escapeOnlyHighlight } from "./highlight.js";

export interface CodeRendererProps {
  content: string;
  /** highlight.js-style language id (used as the `language-<id>` class and
   *  passed to `highlight`). */
  language: string;
  /** Optional syntax highlighter. Defaults to escape-only (no coloring,
   *  no dependency). Pass a `highlight.js`-backed fn for coloring. */
  highlight?: HighlightFn;
  className?: string;
}

/**
 * Render `content` as code for `language`. Output is wrapped in
 * `<pre><code class="hljs language-X">` — the same markup a rehype-highlight
 * markdown pipeline produces, so one stylesheet themes both paths.
 *
 * The default highlighter escapes only; the rendered HTML is always inert
 * (escaped) unless a surface opts into a real highlighter, which is expected
 * to return sanitized HTML built from escaped tokens.
 */
export function CodeRenderer({
  content,
  language,
  highlight = escapeOnlyHighlight,
  className = "prose-note",
}: CodeRendererProps) {
  const html = useMemo(() => highlight(content, language), [content, language, highlight]);
  return (
    <div className={className}>
      <pre>
        {/* The default highlighter escapes all HTML-significant chars; a
            custom highlighter is contracted to return sanitized HTML. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: see comment above */}
        <code dangerouslySetInnerHTML={{ __html: html }} className={`hljs language-${language}`} />
      </pre>
    </div>
  );
}
