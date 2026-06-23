import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import { applyImport } from "@/lib/import/apply";
import { detectFormat, isMarkdownLike, isZipLike } from "@/lib/import/detect";
import { parseLooseMarkdown } from "@/lib/import/loose";
import { parseObsidianZip } from "@/lib/import/obsidian";
import type {
  DetectedFormat,
  ImportProgress,
  ImportReport,
  ParsedImport,
} from "@/lib/import/types";
import { useToastStore } from "@/lib/toast/store";
import { useVaultStore } from "@/lib/vault";
import { useActiveVaultClient } from "@/lib/vault/queries";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";

type Stage =
  | { kind: "pick" }
  | { kind: "parsing" }
  | { kind: "review"; parsed: ParsedImport }
  | { kind: "importing"; parsed: ParsedImport; progress: ImportProgress }
  | { kind: "done"; report: ImportReport; parsed: ParsedImport };

/**
 * The browser-based import surface (notes#NN).
 *
 * Two paths land in v1: Obsidian-vault-as-zip and loose markdown files.
 * Both parse entirely client-side, then POST to the active vault via the
 * existing OAuth session — same wire path the editor uses for a single
 * note save.
 *
 * UX is two-phase: parse + show a dry-run summary, then require a
 * confirmation click before any vault writes happen. That click maps to
 * "Run import"; until then the user can swap files or back out
 * without consequences.
 */
export function Import() {
  const activeVault = useVaultStore((s) => s.getActiveVault());
  const client = useActiveVaultClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pushToast = useToastStore((s) => s.push);
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const inputRef = useRef<HTMLInputElement>(null);
  // Abort handle for the in-flight import. We hold a ref rather than
  // state because flipping it doesn't drive any render — only the
  // worker reads it.
  const abortRef = useRef<AbortController | null>(null);

  if (!activeVault) {
    // The hub `/account` "Import notes" deep-link arrives as
    // `/import?url=<hubOrigin>/vault/<name>`. A first-time user (no vault
    // connected yet) would otherwise lose the `?url=` and land on the home
    // screen (notes#63). Forward into the connect flow carrying the url AND
    // a post-connect redirect back here, so they land on import once the
    // vault is connected. The `?url=` value is opaque user-supplied input —
    // /add validates it via normalizeVaultUrl before any OAuth runs.
    const urlParam = searchParams.get("url");
    if (urlParam) {
      const target = `/add?url=${encodeURIComponent(urlParam)}&redirect=${encodeURIComponent("/import")}`;
      return <Navigate to={target} replace />;
    }
    return <Navigate to="/" replace />;
  }

  const onFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setStage({ kind: "parsing" });
      const format = detectFormat(files);
      try {
        let parsed: ParsedImport;
        if (format === "obsidian-zip") {
          const zip = files.find(isZipLike);
          if (!zip) {
            // Defensive — detector said obsidian-zip but no zip in the list.
            pushToast("No zip file found in selection", "error");
            setStage({ kind: "pick" });
            return;
          }
          parsed = await parseObsidianZip(zip);
        } else if (format === "loose-markdown") {
          parsed = await parseLooseMarkdown(files.filter(isMarkdownLike));
        } else {
          parsed = {
            format,
            notes: [],
            errors: files.map((f) => ({
              sourcePath: f.name,
              reason: "Unrecognized format (expected .zip, .md, or .markdown).",
            })),
            tags: [],
            attachments: [],
          };
        }
        setStage({ kind: "review", parsed });
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "Parse failed", "error");
        setStage({ kind: "pick" });
      }
    },
    [pushToast],
  );

  const onConfirmImport = useCallback(async () => {
    if (stage.kind !== "review") return;
    if (!client) {
      pushToast("Vault session unavailable — reconnect first", "error");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStage({
      kind: "importing",
      parsed: stage.parsed,
      progress: { done: 0, total: stage.parsed.notes.length },
    });
    const report = await applyImport({
      client,
      parsed: stage.parsed,
      signal: ctrl.signal,
      onProgress: (progress) => {
        // Use functional setState so a fast-firing onProgress doesn't
        // wedge React's batching with a stale `stage` snapshot.
        setStage((prev) => (prev.kind === "importing" ? { ...prev, progress } : prev));
      },
    });
    abortRef.current = null;
    setStage({ kind: "done", report, parsed: stage.parsed });
  }, [stage, client, pushToast]);

  const onCancelImport = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onReset = useCallback(() => {
    setStage({ kind: "pick" });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-7 md:px-6 md:py-10">
      <nav className="mb-4 text-sm text-fg-dim">
        <Link to="/" className="hover:text-accent">
          ← All notes
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="font-serif text-2xl tracking-tight md:text-3xl">
          Import notes into <span className="text-accent">{activeVault.name}</span>
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          Upload an Obsidian vault zip or drop in loose markdown files. Everything is parsed in your
          browser and previewed before any note lands in the vault.
        </p>
      </header>

      {stage.kind === "pick" || stage.kind === "parsing" ? (
        <PickStage
          parsing={stage.kind === "parsing"}
          onFiles={onFilesSelected}
          inputRef={inputRef}
        />
      ) : null}

      {stage.kind === "review" ? (
        <ReviewStage parsed={stage.parsed} onConfirm={onConfirmImport} onBack={onReset} />
      ) : null}

      {stage.kind === "importing" ? (
        <ImportingStage progress={stage.progress} onCancel={onCancelImport} />
      ) : null}

      {stage.kind === "done" ? (
        <DoneStage
          report={stage.report}
          parsed={stage.parsed}
          onAnother={onReset}
          onHome={() => navigate("/")}
        />
      ) : null}
    </div>
  );
}

interface PickProps {
  parsing: boolean;
  onFiles: (files: File[]) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function PickStage({ parsing, onFiles, inputRef }: PickProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles(files);
  };

  return (
    <section>
      <AttachmentDropZone
        onDropFiles={onFiles}
        className="rounded-md border border-border bg-card"
        hint="zip or markdown"
      >
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="font-serif text-lg">{parsing ? "Reading files…" : "Drop a file here"}</p>
          <p className="text-sm text-fg-dim">
            Accepts an Obsidian vault `.zip`, or one or more `.md` / `.markdown` files.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover">
              {parsing ? "Reading…" : "Choose files"}
              <input
                ref={inputRef}
                type="file"
                className="sr-only"
                accept=".zip,.md,.markdown"
                multiple
                disabled={parsing}
                onChange={handleChange}
              />
            </label>
            <span className="text-xs text-fg-dim">— or drag and drop above</span>
          </div>
          <details className="mt-2 text-left text-xs text-fg-dim">
            <summary className="cursor-pointer text-fg-muted hover:text-accent">
              What about other tools?
            </summary>
            <p className="mt-2 max-w-md">
              Notion CSV/JSON, Roam, Logseq, and Apple Notes exports are on the roadmap. For now,
              the CLI path{" "}
              <code className="rounded bg-bg/60 px-1 font-mono">
                parachute-vault import &lt;path&gt;
              </code>{" "}
              handles broader formats — or paste the contents into Claude and ask it to add the
              notes via MCP.
            </p>
          </details>
        </div>
      </AttachmentDropZone>
    </section>
  );
}

interface ReviewProps {
  parsed: ParsedImport;
  onConfirm: () => void;
  onBack: () => void;
}

function ReviewStage({ parsed, onConfirm, onBack }: ReviewProps) {
  const { notes, errors, tags, attachments } = parsed;
  const noteCount = notes.length;
  // Files we'll bring across as attachments (image/pdf/audio/video) vs. as
  // notes (text-shaped: txt/json/csv/yaml/svg) vs. can't import (allowlist).
  const attachmentCount = attachments.filter((a) =>
    ["image", "pdf", "audio", "video"].includes(a.kind),
  ).length;
  const fileNoteCount = attachments.filter((a) => a.kind === "text").length;
  const unsupportedCount = attachments.filter((a) => a.kind === "unsupported").length;
  const canImport = noteCount > 0 || attachmentCount > 0 || fileNoteCount > 0;

  const sampleNotes = useMemo(() => notes.slice(0, 8), [notes]);
  const sampleTags = useMemo(() => tags.slice(0, 12), [tags]);

  return (
    <section className="space-y-6">
      <div className="rounded-md border border-border bg-card p-4">
        <h2 className="font-serif text-lg">Dry run</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Detected format: <FormatBadge format={parsed.format} />.{" "}
          <strong className="text-fg">{noteCount}</strong> {noteCount === 1 ? "note" : "notes"} will
          be created.{" "}
          {attachmentCount > 0 ? (
            <span className="text-fg-muted">
              <strong className="text-fg">{attachmentCount}</strong> attachment
              {attachmentCount === 1 ? "" : "s"} (images / PDFs / audio) will come across.{" "}
            </span>
          ) : null}
          {fileNoteCount > 0 ? (
            <span className="text-fg-muted">
              {fileNoteCount} data file{fileNoteCount === 1 ? "" : "s"} (json / csv / yaml / txt)
              will be saved as notes.{" "}
            </span>
          ) : null}
          {unsupportedCount > 0 ? (
            <span className="text-fg-dim">
              {unsupportedCount} file{unsupportedCount === 1 ? "" : "s"} can't be imported (not a
              vault file type).{" "}
            </span>
          ) : null}
          {errors.length > 0 ? (
            <span className="text-fg-dim">{errors.length} file(s) couldn't be parsed.</span>
          ) : null}
        </p>
        {tags.length > 0 ? (
          <p className="mt-2 text-sm text-fg-muted">
            <span className="text-xs uppercase tracking-wider text-fg-dim">Tags found</span>{" "}
            {sampleTags.map((t) => (
              <span
                key={t}
                className="ml-1 inline-block rounded bg-bg/60 px-1.5 py-0.5 font-mono text-xs text-fg"
              >
                #{t}
              </span>
            ))}
            {tags.length > sampleTags.length ? (
              <span className="ml-2 text-fg-dim">+{tags.length - sampleTags.length} more</span>
            ) : null}
          </p>
        ) : null}
      </div>

      {sampleNotes.length > 0 ? (
        <div className="rounded-md border border-border bg-card p-4">
          <h3 className="mb-2 text-xs uppercase tracking-wider text-fg-dim">
            Preview ({sampleNotes.length} of {noteCount})
          </h3>
          <ul className="space-y-1.5 font-mono text-xs">
            {sampleNotes.map((n) => (
              <li key={n.sourcePath} className="flex items-center justify-between gap-3">
                <span className="truncate text-fg">{n.path || n.sourcePath}</span>
                <span className="shrink-0 text-fg-dim">
                  {n.tags.length > 0 ? `${n.tags.length} tag${n.tags.length === 1 ? "" : "s"}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {errors.length > 0 ? (
        <details className="rounded-md border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm text-fg-muted hover:text-accent">
            {errors.length} file(s) skipped during parse
          </summary>
          <ul className="mt-3 space-y-1 text-xs">
            {errors.map((e) => (
              <li key={e.sourcePath} className="flex flex-col gap-0.5">
                <span className="font-mono text-fg">{e.sourcePath}</span>
                <span className="text-fg-dim">{e.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={onBack}
          className="min-h-11 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg-muted hover:text-accent"
        >
          Choose different files
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canImport}
          className="min-h-11 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover disabled:opacity-40"
        >
          Run import ({noteCount} {noteCount === 1 ? "note" : "notes"}
          {attachmentCount > 0
            ? ` + ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
            : ""}
          )
        </button>
      </div>
    </section>
  );
}

function ImportingStage({
  progress,
  onCancel,
}: {
  progress: ImportProgress;
  onCancel: () => void;
}) {
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <section className="space-y-4 rounded-md border border-border bg-card p-6">
      <h2 className="font-serif text-lg">Importing…</h2>
      <p className="text-sm text-fg-muted">
        {progress.done} / {progress.total} notes processed.
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded bg-bg/60"
        role="progressbar"
        tabIndex={0}
        aria-label="Import progress"
        aria-valuenow={progress.done}
        aria-valuemin={0}
        aria-valuemax={progress.total}
      >
        <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg-muted hover:text-accent"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

function DoneStage({
  report,
  parsed,
  onAnother,
  onHome,
}: {
  report: ImportReport;
  parsed: ParsedImport;
  onAnother: () => void;
  onHome: () => void;
}) {
  const errored = report.outcomes.filter((o) => o.status === "errored");
  const skipped = report.outcomes.filter((o) => o.status === "skipped");
  const attachmentsSkipped = report.attachmentOutcomes.filter((o) => o.status === "skipped");
  const attachmentsErrored = report.attachmentOutcomes.filter((o) => o.status === "errored");
  const hasAttachments = report.attachmentOutcomes.length > 0;
  return (
    <section className="space-y-6">
      <div className="rounded-md border border-border bg-card p-4">
        <h2 className="font-serif text-lg">Import complete</h2>
        <ul className="mt-3 space-y-1 text-sm">
          <li>
            <span className="text-accent">{report.created}</span> notes created
          </li>
          <li>
            <span className="text-fg-muted">{report.skipped}</span> notes skipped (already in vault)
          </li>
          <li>
            <span className={report.errored > 0 ? "text-red-400" : "text-fg-muted"}>
              {report.errored}
            </span>{" "}
            notes errored
          </li>
          {hasAttachments ? (
            <>
              <li className="pt-1">
                <span className="text-accent">{report.attachmentsUploaded}</span> attachments
                imported
              </li>
              {report.filesImportedAsNotes > 0 ? (
                <li>
                  <span className="text-accent">{report.filesImportedAsNotes}</span> data files
                  imported as notes
                </li>
              ) : null}
              {report.attachmentsSkipped > 0 ? (
                <li>
                  <span className="text-fg-muted">{report.attachmentsSkipped}</span> attachments
                  skipped (not a vault file type)
                </li>
              ) : null}
              {report.attachmentsErrored > 0 ? (
                <li>
                  <span className="text-red-400">{report.attachmentsErrored}</span> attachments
                  errored
                </li>
              ) : null}
            </>
          ) : null}
        </ul>
        {parsed.errors.length > 0 ? (
          <p className="mt-2 text-xs text-fg-dim">
            (Plus {parsed.errors.length} file(s) skipped at the parse stage — see above.)
          </p>
        ) : null}
      </div>

      {attachmentsSkipped.length > 0 || attachmentsErrored.length > 0 ? (
        <details className="rounded-md border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm text-fg-muted hover:text-accent">
            {attachmentsSkipped.length + attachmentsErrored.length} attachment(s) not imported as
            files — why
          </summary>
          <ul className="mt-3 space-y-1 text-xs">
            {[...attachmentsErrored, ...attachmentsSkipped].map((o) => (
              <li key={`a-${o.sourcePath}`} className="flex flex-col gap-0.5">
                <span className="font-mono text-fg">{o.sourcePath}</span>
                <span className="text-fg-dim">
                  {o.status === "skipped" || o.status === "errored" ? o.reason : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {skipped.length > 0 ? (
        <details className="rounded-md border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm text-fg-muted hover:text-accent">
            {skipped.length} skipped — vault already had a matching note
          </summary>
          <ul className="mt-3 space-y-1 text-xs">
            {skipped.map((o) => (
              <li key={`s-${o.sourcePath}`} className="flex flex-col gap-0.5">
                <span className="font-mono text-fg">{o.sourcePath}</span>
                <span className="text-fg-dim">{o.status === "skipped" ? o.reason : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {errored.length > 0 ? (
        <details className="rounded-md border border-red-500/30 bg-red-500/5 p-4" open>
          <summary className="cursor-pointer text-sm font-medium text-red-400">
            {errored.length} errored
          </summary>
          <ul className="mt-3 space-y-1 text-xs">
            {errored.map((o) => (
              <li key={`e-${o.sourcePath}`} className="flex flex-col gap-0.5">
                <span className="font-mono text-fg">{o.sourcePath}</span>
                <span className="text-fg-dim">{o.status === "errored" ? o.reason : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={onAnother}
          className="min-h-11 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg-muted hover:text-accent"
        >
          Run another import
        </button>
        <button
          type="button"
          onClick={onHome}
          className="min-h-11 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover"
        >
          Back to vault
        </button>
      </div>
    </section>
  );
}

function FormatBadge({ format }: { format: DetectedFormat }) {
  const label =
    format === "obsidian-zip"
      ? "Obsidian vault (zip)"
      : format === "loose-markdown"
        ? "loose markdown"
        : "unknown";
  return <span className="rounded bg-bg/60 px-1.5 py-0.5 font-mono text-xs text-fg">{label}</span>;
}
