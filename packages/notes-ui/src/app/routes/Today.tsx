import {
  NoteTimelineRow,
  RecentTimeline,
  SectionLabel,
  groupNotesByDay,
} from "@/components/RecentTimeline";
import { OfflineRibbon } from "@/components/ui";
import { formatLongDate, parseDateKey, shiftDay, toDateKey, todayKey } from "@/lib/dates";
import { useNotesForDateViews, useVaultStore } from "@/lib/vault";
import { VaultAuthError } from "@/lib/vault/client";
import type { Note } from "@/lib/vault/types";
import { useMemo } from "react";
import { Link, Navigate, useSearchParams } from "react-router";

// Re-exported so existing importers of the grouping helper (and its unit test)
// keep resolving it from this module after the list itself moved into the
// shared RecentTimeline component.
export { groupNotesByDay };

// The front door. With no `?date` it renders a day-grouped timeline of recent
// notes (the calm daily driver at `/`); with `?date=YYYY-MM-DD` it renders the
// single-day view a Calendar cell drills into. Empty days never render — the
// timeline only shows days that actually hold notes.
export function Today() {
  const activeVault = useVaultStore((s) => s.getActiveVault());
  const [searchParams] = useSearchParams();
  const dateParam = searchParams.get("date");

  if (!activeVault) return <Navigate to="/" replace />;
  if (dateParam !== null) return <SingleDay dateParam={dateParam} />;
  return <Timeline vaultName={activeVault.name} />;
}

// ---------------------------------------------------------------------------
// Front-door timeline: recent notes grouped by their most-recent-activity day.
// The grouped list itself lives in the shared RecentTimeline component (also
// used by the guided home at `/`); this wrapper adds Today's header + states.
// ---------------------------------------------------------------------------

function Timeline({ vaultName }: { vaultName: string }) {
  const notes = useNotesForDateViews();
  const groups = useMemo(() => groupNotesByDay(notes.data ?? []), [notes.data]);

  return (
    <div className="page-prose">
      <header className="mb-8">
        <p className="eyebrow">{vaultName}</p>
        <h1 className="page-title">Today</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
          <Link to="/new" className="text-accent hover:underline">
            + Capture
          </Link>
          <Link to="/all" className="hover:text-accent">
            All notes
          </Link>
          <Link to="/calendar" className="hover:text-accent">
            Calendar
          </Link>
        </div>
      </header>

      {notes.isPending ? (
        <Skeleton />
      ) : notes.isError && !notes.data ? (
        // Only a genuinely empty cache falls through to the error block — when
        // a background refetch fails but we still hold notes, keep showing them.
        <ErrorBlock error={notes.error} />
      ) : groups.length === 0 ? (
        <TimelineEmpty />
      ) : (
        <>
          {notes.isError ? <OfflineRibbon /> : null}
          <RecentTimeline notes={notes.data ?? []} />
        </>
      )}
    </div>
  );
}

function TimelineEmpty() {
  return (
    <div className="rounded-md border border-border bg-card p-10 text-center">
      <p className="mb-1 font-serif text-xl text-fg">A quiet, empty page.</p>
      <p className="mb-6 text-sm text-fg-muted">Your notes will gather here, newest day first.</p>
      <Link to="/new" className="btn btn-primary btn-touch">
        Capture the first one
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single day (Calendar drill-in): notes created / edited on the target day.
// ---------------------------------------------------------------------------

function SingleDay({ dateParam }: { dateParam: string }) {
  const todayStr = todayKey();
  const targetKey = dateParam || todayStr;
  const parsed = parseDateKey(targetKey);

  const notes = useNotesForDateViews();

  const buckets = useMemo(() => {
    const created: Note[] = [];
    const edited: Note[] = [];
    if (!notes.data || !parsed) return { created, edited };
    for (const n of notes.data) {
      const ck = toDateKey(n.createdAt);
      const uk = toDateKey(n.updatedAt ?? n.createdAt);
      if (ck === targetKey) created.push(n);
      if (uk === targetKey && ck !== targetKey) edited.push(n);
    }
    return { created, edited };
  }, [notes.data, parsed, targetKey]);

  if (!parsed) {
    return (
      <div className="page-prose">
        <p className="text-sm text-red-400">Invalid date in URL: {targetKey}</p>
        <Link to="/today" className="text-sm text-accent hover:underline">
          Back to today
        </Link>
      </div>
    );
  }

  const isToday = targetKey === todayStr;
  const prev = shiftDay(targetKey, -1);
  const next = shiftDay(targetKey, 1);
  const monthKey = targetKey.slice(0, 7);

  return (
    <div className="page-prose">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="eyebrow">{isToday ? "Today" : "On"}</p>
          <h1 className="page-title">{formatLongDate(targetKey)}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            to={`/today?date=${prev}`}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-fg-muted hover:text-accent"
            aria-label="Previous day"
          >
            ← {prev}
          </Link>
          {!isToday ? (
            <Link
              to="/today"
              className="rounded-md border border-border bg-card px-3 py-1.5 text-fg-muted hover:text-accent"
            >
              Today
            </Link>
          ) : null}
          <Link
            to={`/today?date=${next}`}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-fg-muted hover:text-accent"
            aria-label="Next day"
          >
            {next} →
          </Link>
          <Link
            to={`/calendar?month=${monthKey}`}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-fg-muted hover:text-accent"
          >
            Calendar
          </Link>
          <Link
            to="/new"
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-[--color-on-accent] hover:bg-accent-hover"
          >
            + New note
          </Link>
        </div>
      </header>

      {notes.isPending ? (
        <Skeleton />
      ) : notes.isError && !notes.data ? (
        <ErrorBlock error={notes.error} />
      ) : buckets.created.length === 0 && buckets.edited.length === 0 ? (
        <EmptyBlock isToday={isToday} targetKey={targetKey} />
      ) : (
        <div className="space-y-8">
          {notes.isError ? <OfflineRibbon /> : null}
          {buckets.created.length > 0 ? (
            <Section
              title={isToday ? "Created today" : `Created on ${targetKey}`}
              notes={buckets.created}
            />
          ) : null}
          {buckets.edited.length > 0 ? (
            <Section
              title={isToday ? "Edited today" : `Edited on ${targetKey}`}
              notes={buckets.edited}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function Section({ title, notes }: { title: string; notes: Note[] }) {
  return (
    <section>
      <SectionLabel>
        {title} ({notes.length})
      </SectionLabel>
      <ol className="divide-y divide-border rounded-md border border-border bg-card">
        {notes.map((n) => (
          <NoteTimelineRow key={n.id} note={n} />
        ))}
      </ol>
    </section>
  );
}

function EmptyBlock({ isToday, targetKey }: { isToday: boolean; targetKey: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-10 text-center">
      <p className="mb-4 text-fg-muted">
        {isToday ? "Nothing yet today — start capturing." : `Nothing on ${targetKey}.`}
      </p>
      {isToday ? (
        <Link
          to="/new"
          className="inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover"
        >
          New note
        </Link>
      ) : null}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-md bg-border/30" />
      ))}
    </div>
  );
}

function ErrorBlock({ error }: { error: Error }) {
  const isAuth = error instanceof VaultAuthError;
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 p-6">
      <p className="mb-2 font-medium text-red-400">
        {isAuth ? "Session expired" : "Could not load notes"}
      </p>
      <p className="mb-4 text-sm text-fg-muted">{error.message}</p>
      {isAuth ? (
        <Link
          to="/add"
          className="inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover"
        >
          Reconnect vault
        </Link>
      ) : null}
    </div>
  );
}
