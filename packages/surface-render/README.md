# @openparachute/surface-render

React **rendering primitives** for Parachute surfaces — the layer a custom
surface otherwise copy-pastes out of Notes. Sibling to
[`@openparachute/surface-client`](../surface-client) (which owns the
framework-agnostic auth + data layer: OAuth, `VaultClient`, token storage,
core types).

This package owns **"render a note"**:

- **Markdown + wikilinks** — `<MarkdownView>` (react-markdown + GFM) with a
  per-surface `[[wikilink]]` resolver and link-component hook.
- **Auth'd vault media** — `<VaultImage>` / `<VaultAudio>` that fetch
  `/api/storage/…` blobs *with* the surface's authorization.
- **Multi-format renderers** — `<CsvRenderer>` (→ table), `<JsonRenderer>`
  (pretty), `<YamlRenderer>`, `<CodeRenderer>`, `<PlainRenderer>`.
- **A format dispatcher** — `<NoteRenderer>` picks the renderer from the
  note's path; `formatForPath` is exported standalone.
- **MDX** — `<MdxView>` renders `.mdx` **as markdown by default** (safe; no
  code execution), with an opt-in component-allowlist evaluation seam.

It ships **primitives + good defaults + override hooks**, **not** a turnkey app
shell. The surface owns routing, chrome, and domain components; this package
never bakes in a URL space, a router, or an opinionated layout.

> Design: [parachute.computer/design/2026-06-03-surface-client.md](https://github.com/ParachuteComputer/parachute.computer)
> — decisions A–D. This package is Phase 3.

## Install

```sh
npm add @openparachute/surface-render @openparachute/surface-client react react-dom react-markdown remark-gfm
# optional, for fenced-code-block coloring in markdown:
npm add rehype-highlight
```

`react`, `react-dom`, `react-markdown`, and `remark-gfm` are **required peer
dependencies** (the package doesn't bundle React, and `MarkdownView` imports
`remark-gfm` unconditionally). `rehype-highlight` is an optional peer (only
needed if you pass it for fenced-code-block coloring).

## Quick start

```tsx
import { MarkdownView, type WikilinkResolver } from "@openparachute/surface-render/markdown";
import { vaultClientFetchBlob } from "@openparachute/surface-render/embed";
import { Link as RouterLink } from "react-router";

// 1. Your surface decides the URL space for wikilinks (decision D):
const resolve: WikilinkResolver = (target) => {
  const id = myIndex.lookup(target);
  return id ? { href: `/n/${id}`, exists: true } : null; // null → unresolved
};

// 2. Adapt your router's <Link> to the link-component shape:
const Link = ({ href, className, children }) => (
  <RouterLink to={href} className={className}>{children}</RouterLink>
);

// 3. Adapt your vault client to the fetch-blob hook (for auth'd media):
const fetchBlob = vaultClientFetchBlob(client); // client from surface-client

<MarkdownView content={note.content} resolve={resolve} linkComponent={Link} fetchBlob={fetchBlob} />;
```

Or dispatch by format with `<NoteRenderer>`:

```tsx
import { NoteRenderer } from "@openparachute/surface-render/note";

<NoteRenderer note={note} resolve={resolve} linkComponent={Link} fetchBlob={fetchBlob} />;
```

## The hooks (decisions C + D)

| Hook | Shape | Why it's a hook |
|---|---|---|
| `resolve` | `(target) => { href; exists } \| null` | The surface owns the URL space (`/n/<id>`, `/entity/<slug>`, …). `null` → render the unresolved "dead link" affordance. |
| `linkComponent` | `ComponentType<{ href; className?; children }>` | The surface injects its router's `<Link>` without the shared layer importing a router. Defaults to a plain `<a>`. |
| `fetchBlob` | `(url) => Promise<Blob>` | The surface supplies the auth. Use `vaultClientFetchBlob(client)` (works with notes-ui's `fetchAttachmentBlob` subclass *or* a base `VaultClient` via `storageUrl` + token) or a custom function. |
| `highlight` | `(code, lang) => string` | Syntax coloring for code/json/yaml. Defaults to **escape-only** (inert, no dependency); pass a `highlight.js`-backed fn for coloring. |
| `components` | react-markdown `Components` | Per-element overrides merged over the defaults. |
| `overrides` | per-format renderer fns | `<NoteRenderer>` lets a surface swap any format's renderer (e.g. a JSON tree view). |

## Wikilinks vs embeds

`remarkWikilinks` handles **only `[[…]]` links**. Embeds (`![[…]]`) are *not*
handled here: the Obsidian import rewrites `![[file]]` embeds to standard
markdown images `![](/api/storage/…)`, which the `img` override routes through
`<VaultImage>` (auth'd blob). This keeps the renderer's embed handling and the
importer's rewrite as two ends of one contract. A surface with raw,
un-imported `![[…]]` embeds can preprocess them into `/api/storage/…` images
or `<VaultAudio>` before rendering.

## MDX safety (decision B)

`<MdxView>` renders `.mdx` **as markdown by default** — JSX expressions and
component tags are inert, never executed. Arbitrary vault MDX **cannot run
code**.

Opting into live MDX is the surface's explicit trust decision: pass an
`evaluate` runtime (e.g. backed by `@mdx-js/mdx`) plus a `mdxComponents`
allowlist. Only then does MDX evaluate, and only the allowlisted components
mount. This package never bundles an MDX runtime.

```tsx
// safe default — renders as markdown, executes nothing:
<MdxView content={note.content} resolve={resolve} />

// opt-in — YOU are evaluating note content as code; only do this for vaults
// whose authorship you trust:
<MdxView content={note.content} evaluate={myMdxRuntime} mdxComponents={{ Chart }} />
```

## Default class contract

The defaults emit a documented, styleable class contract (override
`className` / `components` to opt out):

- Markdown container: `prose-note`
- Wikilinks: `wikilink wikilink-resolved` / `wikilink wikilink-unresolved`
  (+ `data-wikilink-target`, `data-wikilink-resolved`)
- Media states: `vault-media-loading`, `vault-media-error`
- Audio: `vault-audio`, `vault-audio-label`
- CSV: `csv-scroll`, `csv-warning`

## Subpath exports

```
@openparachute/surface-render            barrel (everything)
@openparachute/surface-render/markdown   MarkdownView, remarkWikilinks, resolver/link hooks
@openparachute/surface-render/embed      VaultImage, VaultAudio, FetchBlob, vaultClientFetchBlob
@openparachute/surface-render/formats    Csv/Json/Yaml/Code/Plain renderers, parseCsv, highlight hook
@openparachute/surface-render/note       NoteRenderer, formatForPath
@openparachute/surface-render/mdx        MdxView
```

## License

AGPL-3.0
