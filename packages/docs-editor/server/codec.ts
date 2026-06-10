/**
 * The reconciliation boundary's two hooks — markdown ⇄ Y.Doc, built on
 * `@openparachute/doc-schema` (P11) and `y-prosemirror`. The ONLY codec in
 * this surface: both faces (server seed/serialize here, browser editor via
 * `@openparachute/doc-schema/tiptap`) come from the SAME package version,
 * which is what makes "the doc the editor edits" and "the markdown the
 * vault stores" provably the same document.
 *
 *   - `seedDocFromMarkdown` REPLACES the live fragment's content from the
 *     note's markdown (the reconciler hook contract). It uses
 *     y-prosemirror's `updateYFragment` — a DIFFERENTIAL update, so a
 *     re-seed never duplicates content (the classic double-seed bug) and
 *     unchanged spans keep their CRDT identity (connected clients keep
 *     cursors where the winner agrees with what they saw).
 *   - `serializeDocToMarkdown` derives the note's canonical markdown via
 *     `docToMarkdown` — never an ad-hoc serializer.
 *
 * Fragment name: `"default"` — TipTap's Collaboration extension default,
 * shared by the browser binding and every server-side read.
 */

import { type DocJSON, docFromJSON, docToMarkdown, markdownToDoc } from "@openparachute/doc-schema";
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";

/** The Y.Doc fragment both editor and server bind to (TipTap default). */
export const DOC_FRAGMENT = "default";

/**
 * Replace the doc's content from markdown — differential, in the caller's
 * transaction (the reconciler wraps seeds in its own `RECONCILER_ORIGIN`
 * transaction; Yjs nested transactions reuse the outer one, so the origin
 * survives).
 */
export function seedDocFromMarkdown(doc: Y.Doc, markdown: string): void {
  const fragment = doc.getXmlFragment(DOC_FRAGMENT);
  const node = markdownToDoc(markdown);
  // y-prosemirror's differential apply: Y.Doc first arg opens the
  // transaction (re-used when one is already open); the meta object is its
  // per-call binding cache (the shape lib.js's own callers pass).
  updateYFragment(doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
}

/** Canonical markdown for the live doc (the writeback payload). */
export function serializeDocToMarkdown(doc: Y.Doc): string {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(DOC_FRAGMENT)) as DocJSON;
  // Round through the shared schema so malformed CRDT state fails loudly
  // here (hook-error) instead of writing broken markdown to the vault.
  return docToMarkdown(docFromJSON(json));
}
