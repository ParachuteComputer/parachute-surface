import { useMemo } from "react";
import { CodeRenderer } from "./CodeRenderer.js";
import { PlainRenderer } from "./PlainRenderer.js";
import type { HighlightFn } from "./highlight.js";

export interface JsonRendererProps {
  content: string;
  highlight?: HighlightFn;
  className?: string;
}

/**
 * Pretty-print + (optionally) highlight a JSON note as code. On invalid JSON
 * we fall back to the plain renderer so the user still sees their bytes — and
 * we don't reformat the original string in that case (the author's
 * spacing/indentation is signal too).
 */
export function JsonRenderer({ content, highlight, className }: JsonRendererProps) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return null;
    }
  }, [content]);

  if (pretty === null) {
    return <PlainRenderer content={content} className={className} />;
  }
  return (
    <CodeRenderer content={pretty} language="json" highlight={highlight} className={className} />
  );
}
