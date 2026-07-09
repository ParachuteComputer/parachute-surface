import { formatLongDate, shiftDay, toDateKey, todayKey } from "@/lib/dates";
import { noteTitle } from "@/lib/note-title";
import { relativeTime } from "@/lib/time";
import type { Note } from "@/lib/vault/types";
import { useMemo } from "react";
import { Link } from "react-router";

// The day-grouped recent-notes list, shared by the front-door home (`/`) and
// the Today route (`/today`). Both surfaces want the same "recent notes,
// newest day first, human titles" list; only their surrounding chrome differs,
// so the list itself lives here once.

export interface DayGroup {
  key: string;
  notes: Note[];
}

// Group the capped recent-notes window by day (updatedAt, falling back to
// createdAt — a note lands on the day it was last touched). Days sort newest
// first; notes within a day sort newest first. Exported for unit testing the
// bucketing without mounting a route.
export function groupNotesByDay(notes: Note[]): DayGroup[] {
  const byDay = new Map<string, Note[]>();
  for (const n of notes) {
    const key = toDateKey(n.updatedAt ?? n.createdAt);
    if (!key) continue;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(n);
    else byDay.set(key, [n]);
  }
  const stamp = (n: Note) => n.updatedAt ?? n.createdAt;
  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, group]) => ({
      key,
      notes: group.sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0)),
    }));
}

// "Today" / "Yesterday" for the two most recent days, else the long date. Keeps
// the timeline's day headers legible at a glance.
export function relativeDayLabel(key: string): string {
  const today = todayKey();
  if (key === today) return "Today";
  if (key === shiftDay(today, -1)) return "Yesterday";
  return formatLongDate(key);
}

// Eyebrow-style section label with a hairline rule, per the design system.
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="eyebrow mb-2 flex items-center gap-3">
      <span className="shrink-0">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </h2>
  );
}

// One note row, shared by the timeline and the single-day sections: human
// title as the headline, the mono path as dim metadata only when it adds
// something the title doesn't, then preview and tag chips.
export function NoteTimelineRow({ note }: { note: Note }) {
  const title = noteTitle(note);
  // Show the mono path only when it carries a folder the title's leaf drops;
  // compare extension-stripped so a bare "Morning.md" isn't shown under
  // the title "Morning".
  const showPath = !!note.path && note.path.replace(/\.md$/i, "") !== title;
  const stamp = note.updatedAt ?? note.createdAt;
  return (
    <li>
      <Link
        to={`/n/${encodeURIComponent(note.id)}`}
        className="focus-ring block px-4 py-3 hover:bg-bg/60 focus:bg-bg/60"
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{title}</span>
          <span className="shrink-0 text-xs text-fg-dim">{relativeTime(stamp)}</span>
        </div>
        {showPath ? <p className="mt-0.5 min-w-0 truncate note-id">{note.path}</p> : null}
        {note.preview ? (
          <p className="mt-1 truncate text-sm text-fg-muted">{note.preview}</p>
        ) : null}
        {note.tags && note.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {note.tags.map((t) => (
              <span key={t} className="chip chip-tag max-w-full break-all">
                #{t}
              </span>
            ))}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

// The day-grouped list itself. Callers own loading / empty / error states and
// pass the resolved notes; this renders only the grouped sections. Day headers
// link into the single-day view at `/today?date=<key>`.
export function RecentTimeline({ notes }: { notes: Note[] }) {
  const groups = useMemo(() => groupNotesByDay(notes), [notes]);
  return (
    <div className="space-y-10">
      {groups.map((g) => (
        <section key={g.key}>
          <SectionLabel>
            <Link to={`/today?date=${g.key}`} className="hover:text-accent">
              {relativeDayLabel(g.key)}
            </Link>
          </SectionLabel>
          <ol className="divide-y divide-border rounded-md border border-border bg-card">
            {g.notes.map((n) => (
              <NoteTimelineRow key={n.id} note={n} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
