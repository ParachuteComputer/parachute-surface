# @openparachute/doc-schema

The shared document schema for rich-text Parachute surfaces — **one schema,
two faces, one version**:

- the **markdown codec** (`markdownToDoc` / `docToMarkdown`, built on
  prosemirror-markdown) — what a surface backend uses for JSON ⇄ markdown;
- the **TipTap extension list** (`docSchemaExtensions`) — what the browser
  editor uses, compiling to a schema structurally identical to the codec's.

P11 in the [Surface Runtime design](../../design/2026-06-10-surface-runtime-primitives.md)
(trust decision §8: markdown-canonical, one codec). The collaborative docs
surface is the first consumer; any rich-text surface can reuse it.

## The versioned-together contract

Schema and serialization are **versioned together: one package version covers
both.** `DOC_SCHEMA_VERSION` equals the package version (test-pinned). Any
change to node/mark shapes, the extension list's schema-relevant
configuration, escaping rules, or canonical output form is a version bump of
this package — never of one half. Consumers must take the editor extensions
and the codec from the **same version**; that is what makes "the doc the
editor edits" and "the markdown the vault stores" provably the same document.

Concretely:

- TipTap extension dependencies are **exact-pinned** in package.json — the
  extension list is a schema definition, and a floating range could silently
  change the schema out from under persisted docs.
- Schema-or-serialization-affecting deps (prosemirror-markdown,
  prosemirror-model, markdown-it) are **exact-pinned** too — they define
  canonical serialization/escape behavior that the byte-stability tests pin;
  bump deliberately and re-run the round-trip suite.
- `src/__tests__/tiptap-parity.test.ts` pins structural equivalence between
  the hand-built codec schema and `getSchema(docSchemaExtensions)`: node/mark
  names, content expressions, groups, attrs + defaults, and mark rank order.

## Imports

```ts
// Server (and browser) — the codec. DOM-free, isomorphic.
import {
  markdownToDoc, markdownToDocJSON, docToMarkdown, docFromJSON,
  schema, DOC_SCHEMA_VERSION,
  createTextQuoteSelector, resolveTextQuoteSelector,
} from "@openparachute/doc-schema";

// Browser only — the editor extension list (pulls TipTap into the graph).
import { docSchemaExtensions } from "@openparachute/doc-schema/tiptap";

new Editor({ extensions: [...docSchemaExtensions /*, behavior-only extras */] });
```

Add **behavior-only** extensions on top (placeholder, collaboration cursors —
history is deliberately absent: collaborative docs get undo from Yjs).
Anything that would **change the schema** belongs in this package, as a
version bump.

## Isomorphism — how it's guaranteed

The root entry's import graph is `prosemirror-model` + `prosemirror-markdown`
+ `markdown-it` only — **no TipTap, no happy-dom, no DOM globals**. A server
imports it for JSON ⇄ markdown with zero shims. Guaranteed three ways:

1. **Runtime probe (authoritative):** `src/__tests__/isomorphism.test.ts`
   spawns a bare Bun subprocess that booby-traps `document` / `window` /
   `HTMLElement` / `Element` / `customElements` *before* importing the root
   entry, then runs the full codec surface — any DOM touch fails the suite
   (with a positive control proving the trap fires).
2. **Static gate:** `tsconfig.codec.json` typechecks the codec sources with
   `lib: ["ESNext"]` — no DOM lib, no ambient runtime types.
3. **Entry split:** TipTap is reachable only via the `./tiptap` subpath;
   the root entry never imports it.

## Canonical form + round-trip invariants (test-pinned)

`docToMarkdown` emits one canonical form: ATX headings, `-` bullets, tight
lists, fenced code, `---` rules, `*` / `**` emphasis, `\` hard breaks.
The pinned invariants (`src/__tests__/round-trip.test.ts`) are byte-real,
not tautological:

- **md → doc → md:** canonical input is byte-stable on the first pass; ANY
  input reaches a byte-stable fixpoint by the second pass
  (`emit(parse(emit(parse(md)))) === emit(parse(md))`).
- **doc → md → doc:** `parse(emit(doc))` is structurally equal (`Node.eq`).

## The lossiness contract

**Survives round-trips with structure + attributes intact** (test-pinned in
`src/__tests__/contract.test.ts`): headings (level), bullet/ordered lists
(start), **task lists (checked)**, code blocks (language, content verbatim),
blockquotes, horizontal rules, hard breaks, bold / italic / strike / inline
code, links (href, title), images (src, alt, title), plain text including
unicode.

**Canonicalized (form changes once, then stable):** setext → ATX headings,
`*`/`+` → `-` bullets, `_` → `*` emphasis, loose → tight list spacing,
indented → fenced code, soft line breaks join with a space.

**Not content (by design):**

- **Comment anchors ride W3C TextQuoteSelector metadata, never content.**
  The schema has no comment mark or node (test-pinned); anchors live beside
  the doc (note metadata / the `#comments` overlay doc) and re-resolve by
  quote + context via `createTextQuoteSelector` / `resolveTextQuoteSelector`.
- Editor-parity attrs the codec doesn't serialize: link `target`/`rel`/
  `class`, image `width`/`height` (presentation, defaults null).

**Out of scope v1 (stays literal text, byte-stable):** tables, footnotes,
raw HTML (`html: false` — tags are never parsed), mixed task/plain lists
(the `[ ]` stays escaped literal text unless **every** item in the list is a
task).

## Wikilinks

prosemirror-markdown escapes `[` / `]` by default, which would corrupt
`[[wikilinks]]`. The serializer protects `[[target]]` / `[[target|alias]]`
spans **verbatim** while ordinary bracket text keeps its escaping — so
`array[0]` still escapes to `array\[0\]` and never turns into a link, and
wikilinks sit safely adjacent to real `[links](...)`. Wikilinks are plain
text in the doc (no node/mark); surfaces decorate them at view time.
Test-pinned in `src/__tests__/wikilinks.test.ts`.

## Where this package sits (meta.server.format)

The Surface Runtime's `meta.json` `server.format` vocabulary is
`"markdown" | "opaque"` (host-side, defined by `@openparachute/surface`).
From this package's side of that contract: **a surface that declares
`format: "markdown"` must persist exactly what `docToMarkdown` emits and
seed editors via `markdownToDoc`** — vault notes stay canonical,
human-readable markdown, and external edits (any tool, any agent) re-enter
the live doc through the same codec. `"opaque"` formats (e.g. Excalidraw
scenes) bypass this codec entirely and must mark the note's format in
metadata; this package plays no role there.

## License

AGPL-3.0
