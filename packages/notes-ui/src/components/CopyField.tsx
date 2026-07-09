import { useToastStore } from "@/lib/toast/store";
import { useState } from "react";

// A read-only value (URL / command) shown in a mono field with a copy button.
// Copy uses the async clipboard API and toasts either way so the user always
// gets feedback; on failure it invites manual selection (the value is
// selectable text, not hidden behind the button).
export function CopyField({
  value,
  label,
  className,
}: {
  value: string;
  /** Accessible name for the copy button, e.g. "vault address". */
  label: string;
  className?: string;
}) {
  const pushToast = useToastStore((s) => s.push);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      pushToast("Copied to clipboard.", "success");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      pushToast("Couldn't copy — select and copy manually.", "error");
    }
  };

  return (
    <div className={`flex items-stretch gap-2 ${className ?? ""}`}>
      <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-bg-soft px-3 py-2 font-mono text-sm text-fg">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="btn btn-secondary btn-touch shrink-0"
        aria-label={`Copy ${label}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
