# @openparachute/surface-render

## Unreleased

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
