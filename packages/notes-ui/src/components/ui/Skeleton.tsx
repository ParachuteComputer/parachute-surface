import type { CSSProperties } from "react";

/**
 * Skeleton — a single shimmering placeholder block.
 *
 * Replaces the per-file `animate-pulse rounded bg-border/xx` reimplementations
 * with one primitive driven by the `.skeleton` component class (which honors
 * `prefers-reduced-motion` from the stylesheet — the animation drops to none).
 *
 * Size with utility classes (`h-4 w-1/3`) or the `width`/`height` props for the
 * dynamic-width skeleton lines used in the note-body placeholder.
 */
export function Skeleton({
  className = "",
  width,
  height,
}: {
  className?: string;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
}) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return (
    <div
      className={`skeleton ${className}`.trim()}
      style={Object.keys(style).length ? style : undefined}
      aria-hidden="true"
    />
  );
}
