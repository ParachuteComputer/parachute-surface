/**
 * `@openparachute/surface-render` — React rendering primitives for Parachute
 * surfaces.
 *
 * The framework-agnostic auth + data layer lives in
 * `@openparachute/surface-client` (OAuth, VaultClient, token storage, core
 * types). This sibling package owns the React rendering layer that custom
 * surfaces otherwise copy-paste from notes-ui: markdown + wikilinks, auth'd
 * vault media embeds, multi-format renderers, the note-format dispatcher, and
 * an MDX-safe-by-default view.
 *
 * Everything ships as **primitives with good defaults + per-surface override
 * hooks** — NOT a turnkey app shell. The surface owns routing, chrome, and
 * domain components; this package owns "render a note."
 *
 * Design doc: parachute.computer/design/2026-06-03-surface-client.md
 * (decisions A–D; this package is Phase 3).
 *
 * Subpath exports for tree-shaking:
 *   - `./markdown` — <MarkdownView>, remarkWikilinks, the resolver/link hooks
 *   - `./embed`    — <VaultImage>, <VaultAudio>, the fetchBlob hook + adapter
 *   - `./formats`  — <Csv/Json/Yaml/Code/Plain Renderer> + the highlight hook
 *   - `./note`     — <NoteRenderer> dispatcher + formatForPath
 *   - `./mdx`      — <MdxView> (markdown-by-default; opt-in component allowlist)
 */

// Markdown + wikilinks
export {
  MarkdownView,
  type MarkdownViewProps,
  type LinkComponent,
  type LinkComponentProps,
  remarkWikilinks,
  type WikilinkResolver,
  type WikilinkTarget,
  unresolvedLink,
  resolvedLink,
  INERT,
  WIKILINK_CLASS,
  WIKILINK_RESOLVED_CLASS,
  WIKILINK_UNRESOLVED_CLASS,
} from "./markdown/index.js";

// Auth'd vault media embeds
export {
  VaultImage,
  type VaultImageProps,
  VaultAudio,
  type VaultAudioProps,
  type FetchBlob,
  type BlobCapableClient,
  vaultClientFetchBlob,
  isVaultStorageUrl,
  useBlobObjectUrl,
  type BlobObjectUrlState,
  useVaultFetchBlob,
} from "./embed/index.js";

// Multi-format renderers
export {
  CsvRenderer,
  type CsvRendererProps,
  JsonRenderer,
  type JsonRendererProps,
  YamlRenderer,
  type YamlRendererProps,
  CodeRenderer,
  type CodeRendererProps,
  PlainRenderer,
  type PlainRendererProps,
  parseCsv,
  type ParsedCsv,
  type HighlightFn,
  escapeHtml,
  escapeOnlyHighlight,
} from "./formats/index.js";

// Note-format dispatcher
export {
  NoteRenderer,
  type NoteRendererProps,
  type NoteRendererOverrides,
  type NoteLike,
  type MarkdownOverride,
  type MarkdownOverrideProps,
  type BasicFormatOverrideProps,
  type HighlightableOverrideProps,
  type CodeOverrideProps,
  formatForPath,
  extensionOf,
  CODE_EXTENSIONS,
  type NoteFormat,
} from "./note/index.js";

// MDX (markdown-by-default; opt-in component evaluation)
export {
  MdxView,
  type MdxViewProps,
  type MdxComponents,
  type MdxEvaluate,
} from "./mdx/index.js";

/**
 * Library semver — surfaced by a surface in "surface-render 0.1.0" diagnostics.
 * Auto-derived from `package.json` at build time via `scripts/gen-version.ts`
 * (the `prebuild` step), so it can never drift from the version the package
 * actually ships at. Do not hand-edit; bump `package.json` and the build
 * regenerates `src/version.ts`. Mirrors surface-client's guard (see #57).
 */
export { SURFACE_RENDER_VERSION } from "./version.js";
