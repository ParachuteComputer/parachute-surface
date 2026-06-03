export interface PlainRendererProps {
  content: string;
  className?: string;
}

/**
 * Fallback renderer: plain text in a monospace block. Used for unknown
 * extensions and as a graceful-fallback target when a format-specific
 * renderer can't parse its input. Reuses `.prose-note pre` styling so the
 * treatment matches markdown code blocks.
 */
export function PlainRenderer({ content, className = "prose-note" }: PlainRendererProps) {
  return (
    <div className={className}>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}
