import { useActiveVaultClient } from "@/lib/vault/queries";
import type { Note } from "@/lib/vault/types";
import {
  type LinkComponentProps,
  MarkdownView as SurfaceMarkdownView,
  type WikilinkResolver,
  vaultClientFetchBlob,
} from "@openparachute/surface-render";
import { useMemo } from "react";
import { Link } from "react-router";
import rehypeHighlight from "rehype-highlight";

// notes-ui-specific glue over `@openparachute/surface-render`'s
// <MarkdownView>. The shared layer owns markdown + wikilink parsing + the
// resolved/unresolved class contract + the auth'd-image path; notes-ui owns
// the note-index → resolver source, the `/n/<id>` URL space, and the
// react-router link component.

/**
 * Build a notes-ui wikilink resolver from a note's link records.
 *
 * Adapts to surface-render's `(target) => { href, exists } | null` contract.
 * The href space is notes-ui's `/n/<id>` for resolved targets, and
 * `/n/<target>` for unresolved targets (notes-ui links unresolved wikilinks
 * to a create-on-navigate route — so we return `{ exists: false }` rather than
 * `null`, which would drop the link entirely). The id/target is
 * percent-encoded exactly as the old resolver did.
 */
export function buildWikilinkResolver(note: Note): WikilinkResolver {
  const map = new Map<string, string>();
  for (const l of note.links ?? []) {
    if (l.sourceId !== note.id || !l.targetNote) continue;
    if (l.targetNote.path) map.set(l.targetNote.path, l.targetNote.id);
    map.set(l.targetNote.id, l.targetNote.id);
  }
  return (target) => {
    const id = map.get(target);
    if (id) return { href: `/n/${encodeURIComponent(id)}`, exists: true };
    // Unresolved: still link to a create-on-navigate route, styled dashed.
    return { href: `/n/${encodeURIComponent(target)}`, exists: false };
  };
}

// React-router link component. Internal/wikilinks navigate client-side;
// external links open in a new tab. The wikilink resolved/unresolved styling
// rides on the `className` the shared plugin emits
// (`wikilink wikilink-resolved` / `wikilink wikilink-unresolved`).
function NotesLink({ href, className, children }: LinkComponentProps) {
  const classes = className ?? "";
  if (classes.includes("wikilink")) {
    const styleCls = classes.includes("wikilink-resolved")
      ? "text-accent hover:underline"
      : "text-fg-dim underline decoration-dashed underline-offset-4 hover:text-fg";
    return (
      <Link to={href} className={`${classes} ${styleCls}`}>
        {children}
      </Link>
    );
  }
  if (href.startsWith("/") || href.startsWith("#")) {
    return (
      <Link to={href} className="text-accent hover:underline">
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className="text-accent hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

export function MarkdownView({
  content,
  resolve,
  className,
}: {
  content: string;
  resolve: WikilinkResolver;
  className?: string;
}) {
  const client = useActiveVaultClient();
  // `vaultClientFetchBlob` adapts notes-ui's VaultClient (`fetchAttachmentBlob`)
  // to surface-render's `FetchBlob` hook, so `/api/storage/…` images load
  // auth'd via <VaultImage>. `?? undefined` when not signed in / no client.
  const fetchBlob = useMemo(() => vaultClientFetchBlob(client) ?? undefined, [client]);
  return (
    <SurfaceMarkdownView
      content={content}
      resolve={resolve}
      linkComponent={NotesLink}
      fetchBlob={fetchBlob}
      rehypePlugins={[rehypeHighlight]}
      className={`prose-note ${className ?? ""}`.trim()}
    />
  );
}
