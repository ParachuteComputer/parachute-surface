# @openparachute/surface-render

## Unreleased

### Security — a note's remote images never load; the vault token stays on the vault's origin

- **`VaultImage` / `VaultAudio` load only vault attachments.** A remote
  http(s) `src` used to render directly, so `![](https://tracker.example/x.png)`
  told that server the note was opened, when and from where. It now renders
  as a plain link (`.vault-media-remote`; alt text or the address, new tab, no
  referrer) and is never loaded. Any other non-vault src (`javascript:`, a
  non-storage path) renders as words (`.vault-media-blocked`). `blob:` and
  inline `data:image/…` / `data:audio/…` still show (no request).
  `MarkdownView`, `NoteRenderer` and `MdxView` inherit this.
- **`isVaultStorageUrl(src, vaultUrl?)`** no longer treats
  `https://<any host>/api/storage/…` as storage. An absolute URL counts only
  under the vault passed as `vaultUrl` (same origin, path under
  `<vaultUrl>/api/storage/`, so not another vault on the same hub); a
  relative path climbing out with `..`, an encoded dot/slash, a backslash or
  a control character doesn't count. Before, such a URL was fetched
  through `fetchBlob`, which sent the vault bearer to that host.
- **`vaultClientFetchBlob`'s fallback** refuses an absolute URL outside the
  vault before making a request, and fetches the URL it checked (parsed),
  not the raw string.
- New `vaultUrl` prop on `VaultImage`, `VaultAudio`, `MarkdownView` and
  `NoteRenderer`, for surfaces whose notes hold absolute storage URLs on
  their own vault. New exports `mediaSrcKind`, `MediaSrcKind`;
  `useBlobObjectUrl` takes `vaultUrl` and returns `kind`.
- **Behaviour change.** A surface that relied on remote images rendering
  inline passes its own `components.img`.

### Added — rich notes (rich-notes-kit, PATTERNS v0.3)

- **`<NoteRenderer rich>`** draws a markdown note that uses a rich pattern
  (tag `recipe` / `minutes` / `session` / `chant`, tasks, a dated log, a
  callout, `<details>`, a chartable table) with the kit; every other note
  still goes to `<MarkdownView>` unchanged. Default `false`;
  `overrides.markdown` still wins.
- **`<RichNoteView>`** (`./rich`): the view on its own. Host hooks from
  surface-render's own props: `resolve` + new `onNavigate` (wikilinks),
  `fetchBlob` + `vaultUrl` (images only when `isVaultStorageUrl(src,
  vaultUrl)` passes; a remote image is a plain link, never loaded; a refused
  image reads "(not loaded)"), new `onSave(content, patch)`
  (task ticks and log lines; read-only without it; typed as the kit's
  `Host["save"]`, resolving with the saved note or `{ updatedAt }`),
  `openLink`, `calm`, `units`.
- `NoteLike` grows optional `metadata`, `tags`, `id`, `updatedAt`
  (surface-client's `Note` already has them).
- New stylesheet export `./rich-notes-kit.css`; `parseRichNote`,
  `needsRich` (the kit's own rule), `RICH_NOTES_KIT_VERSION`, `RICH_NOTES_CONTRACT`.
- The kit (MIT, 0.2.0) is vendored as source in `src/rich/kit/`, typed by
  its own `index.d.ts`, with
  markdown-it 15 (`src/rich/vendor/`), compiled by `tsc` (`allowJs`): no new
  dependency and no new package to publish. `scripts/sync-rich-notes-kit.ts`
  re-syncs from a kit checkout; `THIRD_PARTY.md` carries the licences.
- **No network:** a test draws every made-up fixture with every control
  opened and fails on any request API call or URL-loading node.

## [0.3.1] - 2026-08-30

Stable promotion of `0.3.1-rc.1` — suffix-drop, no code change. Ships the
`WIKILINK_RE` export (surface#204). The `@openparachute/surface-client`
exact pin moves to `0.3.7` (stable) in the same commit.

## [0.3.1-rc.1] - 2026-08-29

### Added — canonical wikilink matcher export (surface#204)

`WIKILINK_RE` — the regex the renderer itself uses for `[[target]]` and
`[[target|alias]]` spans — is now exported from the package root and
`markdown/` subpath, so consumers matching wikilinks in surrounding code
(previews, link indexing) use the same definition instead of hand-rolling a
divergent one. No rendering behavior change.

First surface-render release published by merge-to-`next` (surface#215)
rather than a tag push. Depends on `@openparachute/surface-client
0.3.7-rc.2` (exact pin moved with the recut — an exact pin that trails the
workspace version makes bun resolve the npm tarball instead of the
workspace package).

## 0.3.0

Renders a single newline inside a paragraph as a visible line break, matching
Obsidian / GitHub-comment markdown — not strict CommonMark, which collapses a
soft break to a space.

- **`<MarkdownView breaks>` / `<NoteRenderer breaks>`** — new prop, **default
  `true`**. Wires [`remark-breaks`](https://github.com/remarkjs/remark-breaks)
  into the remark pipeline (before `remarkWikilinks`, so it only ever sees
  plain paragraph text and never re-splits the wikilink plugin's styled
  inert-unresolved span). Set `breaks={false}` to opt back into strict
  CommonMark soft-break behavior. `remark-breaks` joins `remark-gfm` as a
  required peer dependency (imported unconditionally, like `remark-gfm`).
- **Behavior change, minor bump.** This is a rendering *default* change for
  consumers that upgrade — existing `.md` content with internal single
  newlines will now show a break where it previously collapsed to a space.
  0.x caret semantics mean consumers pinned to `^0.2.0` (e.g. notes-ui) do
  **not** auto-resolve to 0.3.0 — bumping in is a deliberate per-consumer
  choice.
- Fenced code blocks and inline code are unaffected — `remark-breaks` only
  rewrites `text` mdast nodes, which code/inlineCode nodes are not.

## 0.2.0

DX polish from the notes-ui Phase-4 dogfood ([#74](https://github.com/ParachuteComputer/parachute-surface/issues/74)). All additive + backward-compatible — existing consumers (notes-ui) render identically.

- **`useVaultFetchBlob(client)` hook** (`/embed`) — convenience over
  `vaultClientFetchBlob`: memoized, returns `undefined` when signed out, so
  surfaces stop hand-writing `useMemo(() => vaultClientFetchBlob(client) ?? undefined, …)`.
- **Unified `highlight`** — the `highlight` hook now also colors fenced code
  blocks inside markdown (`<MarkdownView highlight>` / `<NoteRenderer highlight>`),
  not just code/json/yaml notes. One hook for every code path, same
  `hljs language-X` markup. Backward-compatible: the markdown `code` override
  only activates when `highlight` is passed, so the `rehypePlugins={[rehypeHighlight]}`
  path (notes-ui) and the no-coloring default are unchanged. Use one or the
  other, never both.
- **Resolver clarity** — prominent `WikilinkResolver` docs on the `null` vs
  `{ exists: false }` distinction, plus tiny named helpers `unresolvedLink(href)`
  / `resolvedLink(href)` / the `INERT` sentinel (`/markdown`) that make
  "unresolved-but-still-linked" the obvious default. No contract change.
- **Optional baseline stylesheet** — `import "@openparachute/surface-render/styles.css"`
  gives sane neutral defaults for the affordance classes (csv-scroll/warning,
  vault-media-loading/error, vault-audio, dashed unresolved wikilinks) so
  consumers aren't source-spelunking for unstyled elements. Does not theme
  `.prose-note` or ship a highlight.js color theme.
- **Ergonomic override types** — re-exported named aliases for the
  `NoteRendererOverrides` prop shapes (`MarkdownOverride`, `MarkdownOverrideProps`,
  `CodeOverrideProps`, `HighlightableOverrideProps`, `BasicFormatOverrideProps`)
  so consumers annotate override fns without `as`-casts or deep imports.
- **Docs** — README now enumerates the *complete* emitted CSS class contract.

## 0.1.0

Initial release — Phase 3 of the
[surface-client design](https://github.com/ParachuteComputer/parachute.computer)
(make custom surfaces a thin import). New sibling package to
`@openparachute/surface-client`.

Extracts the proven rendering stack out of `notes-ui` and generalizes it to be
surface-agnostic (decisions A–D):

- **Markdown** — `<MarkdownView>` (react-markdown + GFM) with the
  `remarkWikilinks` plugin rewired to the new `(target) => { href, exists } |
  null` resolver (decision D — the surface owns the URL space, not the plugin)
  and a `linkComponent` hook for the surface's router `<Link>`.
- **Auth'd media** — `<VaultImage>` + a new `<VaultAudio>` (voice memos),
  driven by a `FetchBlob` hook + `vaultClientFetchBlob` adapter rather than a
  hard dependency on `fetchAttachmentBlob` (which lives on notes-ui's
  subclass, not the base `VaultClient`).
- **Multi-format renderers** — `<Csv/Json/Yaml/Code/Plain Renderer>` with good
  defaults; `<CodeRenderer>` takes an optional `highlight` hook (default
  escape-only, no `highlight.js` dependency).
- **Dispatcher** — `<NoteRenderer>` + `formatForPath` / `extensionOf`, with
  per-format `overrides`.
- **MDX** — `<MdxView>` renders `.mdx` **as markdown by default** (no code
  execution; decision B) with an opt-in `evaluate` + allowlist seam.

Ships primitives + defaults + hooks; not an app shell (decision C). React is a
peer dependency. Not yet consumed by notes-ui (Phase 4) or my-vault-ui
(Phase 5).
