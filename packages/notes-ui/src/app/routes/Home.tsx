import { InstallPrompt } from "@/components/InstallPrompt";
import { RecentTimeline, groupNotesByDay } from "@/components/RecentTimeline";
import { OfflineRibbon } from "@/components/ui";
import {
  type DerivedStep,
  type HomeStepId,
  deriveSteps,
  hasUserAuthoredNote,
  stepsComplete,
} from "@/lib/home/checklist";
import { useHomeChecklist } from "@/lib/home/use-home-checklist";
import { useInstallAffordance } from "@/lib/pwa-install";
import { useNotesForDateViews, useVaultStore } from "@/lib/vault";
import type { Note } from "@/lib/vault/types";
import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

// The guided home — the default surface a connected vault opens on (App.tsx's
// NotesIndex renders this at `/`; the no-vault case renders `Landing`).
//
// One coherent home: a light welcome, quick actions, a dismissible setup
// checklist, a search box, and the recent-notes timeline. It leans warm for a
// fresh vault and recedes to a quiet version once the vault feels lived-in — so
// it guides newcomers without getting in a returning user's way. Guidance is
// always dismissible; the door is never a manual.
export function Home() {
  const vault = useVaultStore((s) => s.getActiveVault());
  const notes = useNotesForDateViews();
  const install = useInstallAffordance();
  const { state: checklistState, setOverride, dismiss } = useHomeChecklist(vault?.id ?? null);

  // NotesIndex only mounts Home when a vault is active, but guard anyway: a
  // vault removed mid-session should fall back to the landing (via the index),
  // not render an empty home.
  if (!vault) return <Navigate to="/" replace />;

  // `settled` gates the "fresh" welcome on notes having loaded, so a returning
  // user never flashes "Welcome aboard" before their notes come back.
  const settled = notes.data !== undefined;
  const hasUserNote = hasUserAuthoredNote(notes.data);

  const steps = deriveSteps(checklistState, {
    hasUserNote,
    installed: install.state === "installed",
    installable: install.state === "available",
  });
  const allDone = stepsComplete(steps);
  const showChecklist = !checklistState.dismissed && !allDone;

  // Fresh = a brand-new vault the user hasn't made their own yet. Once a real
  // note exists (or they dismiss/finish the checklist) the home goes quiet.
  const mode: "fresh" | "returning" =
    settled && !hasUserNote && showChecklist ? "fresh" : "returning";

  return (
    <div className="page-prose">
      <Masthead vaultName={vault.name} mode={mode} />

      <QuickActions installAvailable={install.state === "available"} />

      {showChecklist ? (
        <SetupChecklist
          steps={steps}
          expandedByDefault={mode === "fresh"}
          onToggle={(id, done) => setOverride(id, done)}
          onDismiss={dismiss}
        />
      ) : null}

      <HomeSearch />

      <RecentNotes isPending={notes.isPending} isError={notes.isError} notes={notes.data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Masthead — the adaptive welcome header.
// ---------------------------------------------------------------------------

function Masthead({ vaultName, mode }: { vaultName: string; mode: "fresh" | "returning" }) {
  return (
    <header className="mb-8">
      <p className="eyebrow">{vaultName}</p>
      {mode === "fresh" ? (
        <>
          <h1 className="page-title">Welcome aboard.</h1>
          <p className="mt-3 text-fg-muted">
            This is your vault — a home for your notes that any AI can read and write. A few small
            steps and it's yours.
          </p>
        </>
      ) : (
        <h1 className="page-title">Home</h1>
      )}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Quick actions — the always-present doors.
// ---------------------------------------------------------------------------

function QuickActions({ installAvailable }: { installAvailable: boolean }) {
  return (
    <nav aria-label="Quick actions" className="mb-8 grid gap-3 sm:grid-cols-2">
      <ActionCard to="/new" title="Write a note" description="Capture a thought — it's yours." />
      <ActionCard
        to="/connect"
        title="Connect your AI"
        description="Let Claude or ChatGPT read and write your vault."
      />
      <ActionCard
        to="/import"
        title="Bring your notes over"
        description="Import from Obsidian or plain markdown."
      />
      {installAvailable ? (
        <div className="card flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-medium text-fg">Install the app</p>
            <p className="mt-0.5 text-sm text-fg-muted">Add Notes to your home screen.</p>
          </div>
          <InstallPrompt />
        </div>
      ) : null}
    </nav>
  );
}

function ActionCard({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="focus-ring card p-4 transition-colors hover:border-accent">
      <p className="font-medium text-fg">{title}</p>
      <p className="mt-0.5 text-sm text-fg-muted">{description}</p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Setup checklist — dismissible, collapsible, persisted per vault.
// ---------------------------------------------------------------------------

const STEP_COPY: Record<HomeStepId, { title: string; description: string; to?: string }> = {
  write: {
    title: "Write your first note",
    description: "Capture something real — a thought, a task, a fragment.",
    to: "/new",
  },
  connect: {
    title: "Connect your AI",
    description: "Claude, ChatGPT, or any MCP client — one shared memory.",
    to: "/connect",
  },
  import: {
    title: "Bring your notes over",
    description: "Import an Obsidian vault or a folder of markdown.",
    to: "/import",
  },
  install: {
    title: "Install the app",
    description: "Add Notes to your home screen for one-tap capture.",
  },
};

function SetupChecklist({
  steps,
  expandedByDefault,
  onToggle,
  onDismiss,
}: {
  steps: DerivedStep[];
  expandedByDefault: boolean;
  onToggle: (id: HomeStepId, done: boolean) => void;
  onDismiss: () => void;
}) {
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section aria-label="Setup checklist" className="card mb-8 overflow-hidden">
      <details open={expandedByDefault}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-bg/40">
          <span className="flex items-center gap-2">
            <span className="font-medium text-fg">Finish setting up</span>
            <span className="text-sm text-fg-dim">
              {doneCount}/{steps.length}
            </span>
          </span>
          <span aria-hidden="true" className="font-mono text-xs text-fg-dim">
            ▾
          </span>
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {steps.map((step) => (
            <ChecklistRow key={step.id} step={step} onToggle={onToggle} />
          ))}
        </ul>
        <div className="flex justify-end border-t border-border px-4 py-2">
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm text-fg-dim hover:text-accent"
          >
            Dismiss
          </button>
        </div>
      </details>
    </section>
  );
}

function ChecklistRow({
  step,
  onToggle,
}: {
  step: DerivedStep;
  onToggle: (id: HomeStepId, done: boolean) => void;
}) {
  const copy = STEP_COPY[step.id];
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {/* Auto-detected steps show their status as a fact (no checkbox — the
          truth comes from the vault / platform, not a claim). Manual steps
          expose a checkbox the user ticks. */}
      {step.auto ? (
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
            step.done
              ? "border-accent bg-accent text-[--color-on-accent]"
              : "border-border text-transparent"
          }`}
        >
          ✓
        </span>
      ) : (
        <input
          type="checkbox"
          checked={step.done}
          onChange={(e) => onToggle(step.id, e.target.checked)}
          aria-label={`Mark "${copy.title}" done`}
          className="h-5 w-5 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-medium ${step.done ? "text-fg-muted line-through" : "text-fg"}`}
        >
          {copy.title}
        </p>
        <p className="mt-0.5 text-sm text-fg-muted">{copy.description}</p>
      </div>
      {copy.to && !step.done ? (
        <Link to={copy.to} className="shrink-0 text-sm text-accent hover:underline">
          {step.id === "write" ? "Write" : step.id === "connect" ? "Connect" : "Import"}
        </Link>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Search — a modest deep link into the full notes list's search.
// ---------------------------------------------------------------------------

function HomeSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    // Empty search just opens the full list; a query pre-fills its search box
    // (reuses /all's existing `?search=` filter — no new backend).
    navigate(q ? `/all?search=${encodeURIComponent(q)}` : "/all");
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: `<form role="search">` is the portable search-landmark pattern; `<search>` isn't a form and we need submit semantics.
    <form role="search" onSubmit={submit} className="mb-8">
      <label htmlFor="home-search" className="eyebrow mb-2 block">
        Search your notes
      </label>
      <div className="flex gap-2">
        <input
          id="home-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles and content…"
          className="input"
        />
        <button type="submit" className="btn btn-secondary btn-touch shrink-0">
          Search
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Recent notes — the day-grouped timeline (shared with /today).
// ---------------------------------------------------------------------------

function RecentNotes({
  isPending,
  isError,
  notes,
}: {
  isPending: boolean;
  isError: boolean;
  notes: Note[] | undefined;
}) {
  const groups = useMemo(() => groupNotesByDay(notes ?? []), [notes]);

  return (
    <section aria-label="Recent notes">
      <h2 className="eyebrow mb-3 flex items-center justify-between">
        <span>Recent</span>
        <Link to="/all" className="text-fg-dim hover:text-accent">
          All notes
        </Link>
      </h2>
      {isPending ? (
        <RecentSkeleton />
      ) : isError && !notes ? (
        <p className="rounded-md border border-border bg-card px-4 py-3 text-sm text-fg-muted">
          Couldn't load recent notes. They'll appear once you're back online.
        </p>
      ) : groups.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-8 text-center">
          <p className="mb-1 font-serif text-lg text-fg">A quiet, empty page.</p>
          <p className="mb-5 text-sm text-fg-muted">Your notes will gather here.</p>
          <Link to="/new" className="btn btn-primary btn-touch">
            Write the first one
          </Link>
        </div>
      ) : (
        <>
          {isError ? <OfflineRibbon /> : null}
          <RecentTimeline notes={notes ?? []} />
        </>
      )}
    </section>
  );
}

function RecentSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-border/30" />
      ))}
    </div>
  );
}
