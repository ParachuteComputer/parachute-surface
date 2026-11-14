import { useEffect, useMemo, useRef } from "react";
import { type FetchBlob, isVaultStorageUrl } from "../embed/fetch-blob.js";
import type { WikilinkResolver } from "../markdown/remark-wikilinks.js";
import { mountRichNote, parseRichNote } from "./kit-api.js";
import type { RichDoc, RichHandle, RichHost, RichNote, RichPatch } from "./types.js";

export interface RichNoteViewProps {
  /** The note: content plus whatever of metadata / tags / path / id /
   *  updatedAt the surface has (surface-client's `Note` has all of them). */
  note: { content?: string } & Partial<Omit<RichNote, "content">>;
  /** An already parsed doc for this note (NoteRenderer passes the one it
   *  parsed to decide), so the note is parsed once. */
  doc?: RichDoc;
  /** Wikilink resolver: `[[target]]` → its href, as in `MarkdownView`.
   *  Without it a wikilink is plain text. */
  resolve?: WikilinkResolver;
  /** The surface's router navigate, for wikilinks and internal links. */
  onNavigate?: (href: string) => void;
  /** Opens an external link (`https:`, `mailto:`, `geo:`, the only schemes
   *  the kit keeps). An app webview should pass its platform opener; without
   *  it the kit uses an ordinary `target=_blank` link. */
  openLink?: (href: string) => void;
  /** Auth'd blob fetcher for the note's own attachments (`/api/storage/…`).
   *  Nothing else is ever fetched. */
  fetchBlob?: FetchBlob;
  /** Saves a one-line content edit (a ticked task, a "made today" line).
   *  Resolve with the saved note (its `updatedAt` becomes the next
   *  revision); reject with `{ status: 409 }` when stale. Without it the note is
   *  read-only. */
  onSave?: (content: string, patch: RichPatch) => Promise<unknown>;
  /** Ink / reduced-motion screens: nothing moves. */
  calm?: boolean;
  /** The reader's lasting choice of units for recipes. */
  units?: "us" | "metric";
  /** Wrapper class (default `rich-note`). */
  className?: string;
}

/**
 * Draws one note with rich-notes-kit (PATTERNS v0.3): recipes with servings,
 * units and timers; minutes with quorum and tallies; session notes; chant
 * charts; and for every note, tasks, dated logs, callouts, `<details>` and
 * charts from number tables.
 *
 * **No network.** The kit loads nothing itself: a remote image is a link,
 * links open only on a tap, and the one thing it asks the host for — an
 * attachment image — goes through `fetchBlob` only for a vault storage path.
 * Note text only ever enters the page as text.
 */
export function RichNoteView(props: RichNoteViewProps) {
  // One mount per note, and per set of hooks the kit was given: a different
  // note starts with a fresh sitting (servings, ticks, timers belong to the
  // note they were set on), and a hook that appears or goes (a note you may
  // edit, a resolver or fetcher that loaded) redraws with it. A note with
  // neither id nor path can't be told apart, so it updates in place. The same note with new
  // content updates in place and keeps the sitting.
  const { note, resolve, openLink, onSave, fetchBlob, units } = props;
  const key = [
    note.id ?? note.path ?? "",
    resolve ? "r" : "",
    openLink ? "l" : "",
    onSave ? "s" : "",
    fetchBlob ? "b" : "",
    units ?? "",
  ].join("|");
  return <RichNoteMount key={key} {...props} />;
}

function RichNoteMount({ note, doc, className = "rich-note", ...hooks }: RichNoteViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<RichHandle | null>(null);
  const drawn = useRef<RichDoc | null>(null);
  // The host is built once per mount; it reads the latest props through this
  // ref, so a new callback identity never remounts the note (and never loses
  // the reader's sitting: ticks, scale, step, timers).
  const latest = useRef(hooks);
  latest.current = hooks;

  const parsed = useMemo(
    () => doc ?? parseRichNote({ ...note, content: note.content ?? "" }),
    [doc, note],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount once; updates go through handle.update below.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const objectUrls: string[] = [];
    let disposed = false;
    const h = latest.current;
    const host: RichHost = {
      async image(path) {
        const fetchBlob = latest.current.fetchBlob;
        if (!fetchBlob || !isVaultStorageUrl(path)) throw new Error("not a vault attachment");
        const blob = await fetchBlob(path);
        if (disposed) throw new Error("view closed");
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        return url;
      },
      calm: () => Boolean(latest.current.calm),
    };
    if (h.resolve) {
      host.openNote = (target) => {
        const resolved = latest.current.resolve?.(target);
        if (resolved?.href) navigate(resolved.href, latest.current.onNavigate);
      };
    }
    if (h.openLink) host.openLink = (href) => latest.current.openLink?.(href);
    if (h.onSave) {
      host.save = (content, patch) => {
        const save = latest.current.onSave;
        return save ? save(content, patch) : Promise.reject(new Error("read-only"));
      };
    }
    if (h.units) host.units = h.units;
    handle.current = mountRichNote(el, parsed, host);
    drawn.current = parsed;
    return () => {
      disposed = true;
      handle.current?.destroy();
      handle.current = null;
      for (const u of objectUrls) URL.revokeObjectURL(u);
    };
  }, []);

  useEffect(() => {
    if (!handle.current || drawn.current === parsed) return;
    drawn.current = parsed;
    handle.current.update(parsed);
  }, [parsed]);

  return <div ref={ref} className={className} />;
}

/** Routes go to the surface's navigate; without one, only an href on this
 *  page's own origin is followed (the resolver owns the href; parsing it
 *  first means `/\\host` or `/<TAB>/host` can't leave the site). */
function navigate(href: string, onNavigate?: (href: string) => void): void {
  if (onNavigate) {
    onNavigate(href);
    return;
  }
  try {
    const u = new URL(href, window.location.href);
    if (u.origin === window.location.origin) window.location.assign(u.href);
  } catch {
    // not a URL: nothing to follow
  }
}
