import type { ReactNode } from "react";

/**
 * ErrorState — the canonical error block (danger-bordered, soft danger fill).
 *
 * Replaces the per-file error blocks that hardcoded `border-red-500/30
 * bg-red-500/5 ... text-red-400`, now driven by the semantic `--color-danger*`
 * tokens so they track the theme (and lighten correctly in dark mode).
 *
 * Slots: a title, optional detail message, and either a `retry` callback (renders
 * a Try-again button) and/or an arbitrary `action` node (e.g. a Reconnect link).
 */
export function ErrorState({
  title,
  message,
  retry,
  retryLabel = "Try again",
  action,
  className = "",
}: {
  title: ReactNode;
  message?: ReactNode;
  retry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-[--color-danger-border] bg-[--color-danger-soft] p-6 ${className}`.trim()}
    >
      <p className="mb-2 font-medium text-[--color-danger]">{title}</p>
      {message ? <p className="mb-4 text-sm text-fg-muted">{message}</p> : null}
      {retry || action ? (
        <div className="flex flex-wrap items-center gap-2">
          {retry ? (
            <button type="button" onClick={retry} className="btn btn-secondary btn-touch">
              {retryLabel}
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
