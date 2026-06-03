import { highlightAs } from "@/lib/render/highlight";
import {
  type NoteLike,
  NoteRenderer as SurfaceNoteRenderer,
  type WikilinkResolver,
} from "@openparachute/surface-render";
import { MarkdownView } from "./MarkdownView";

// notes-ui's note-format dispatcher — a thin wrapper over
// `@openparachute/surface-render`'s <NoteRenderer>. The shared layer owns
// format detection + the csv/json/yaml/code/plain primitives; notes-ui
// supplies its own glue:
//   - the markdown branch is overridden to notes-ui's <MarkdownView> (which
//     wires the react-router link component + auth'd image fetcher),
//   - the `highlight` hook is notes-ui's highlight.js-backed `highlightAs`, so
//     code/json/yaml keep their syntax coloring (surface-render's default is
//     escape-only).

export type { NoteLike };

export function NoteRenderer({
  note,
  resolve,
  className,
}: {
  note: NoteLike;
  // Required only for the markdown branch; the other renderers don't carry
  // wikilinks. Kept required at the type level so existing call sites
  // (NoteView, NoteEditor preview, NoteNew preview) which already build a
  // resolver pass it without thinking — and so future markdown notes don't
  // silently lose wikilink resolution.
  resolve: WikilinkResolver;
  className?: string;
}) {
  return (
    <SurfaceNoteRenderer
      note={note}
      resolve={resolve}
      className={className}
      highlight={highlightAs}
      overrides={{
        // notes-ui's <MarkdownView> carries the router link component + auth'd
        // image fetcher; route the markdown branch through it rather than the
        // shared default.
        markdown: ({ content, resolve: r, className: c }) => (
          <MarkdownView content={content} resolve={r as WikilinkResolver} className={c} />
        ),
      }}
    />
  );
}
