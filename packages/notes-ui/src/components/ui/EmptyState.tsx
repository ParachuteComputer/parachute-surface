import type { ReactNode } from "react";

/**
 * EmptyState — the canonical "nothing here yet" / "no results" block.
 *
 * Replaces the per-file empty blocks (`rounded-md border bg-card p-10 text-center`)
 * with one primitive. Slots: optional icon, a title, optional description, and an
 * optional action (typically a `.btn .btn-primary` link/button).
 *
 * Generic — carries no note-type assumptions; callers supply all copy.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card p-10 text-center ${className}`.trim()}>
      {icon ? (
        <div className="mb-3 flex justify-center text-fg-dim" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="text-fg-muted">{title}</p>
      {description ? <p className="mt-1 text-sm text-fg-dim">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
