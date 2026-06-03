# @openparachute/surface-render

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
