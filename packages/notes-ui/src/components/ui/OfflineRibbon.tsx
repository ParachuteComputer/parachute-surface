/**
 * OfflineRibbon — a quiet inline notice shown ABOVE cached content when a
 * background refetch failed but we still have saved data to render.
 *
 * The phone-first PWA must never blank what you're reading just because the
 * network dropped mid-session. When a query is in an error state yet still
 * holds previously-fetched data, routes render the data under this ribbon
 * instead of swapping in a full error block (the "error-over-data" fix from
 * the 2026-07-03 offline-PWA brief).
 */
export function OfflineRibbon({ className = "" }: { className?: string }) {
  // `<output>` carries an implicit ARIA `status` role, so the ribbon is
  // announced to assistive tech without a redundant `role` attribute.
  return (
    <output
      className={`mb-4 block rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg-muted ${className}`.trim()}
    >
      Offline — showing what's saved.
    </output>
  );
}
