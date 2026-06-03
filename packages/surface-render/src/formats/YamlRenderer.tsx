import { CodeRenderer } from "./CodeRenderer.js";
import type { HighlightFn } from "./highlight.js";

export interface YamlRendererProps {
  content: string;
  highlight?: HighlightFn;
  className?: string;
}

/**
 * YAML is rendered as highlighted code — there's no equivalent of JSON.parse
 * to pretty-print, and re-emitting via a YAML library is a real dependency
 * and a real source of surprises (anchors, key ordering, comment stripping).
 * Render the bytes as-authored.
 */
export function YamlRenderer({ content, highlight, className }: YamlRendererProps) {
  return (
    <CodeRenderer content={content} language="yaml" highlight={highlight} className={className} />
  );
}
