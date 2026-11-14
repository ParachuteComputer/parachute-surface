# @openparachute/surface-render

React **rendering primitives** for Parachute surfaces — the layer a custom
surface otherwise copy-pastes out of Notes. Sibling to
[`@openparachute/surface-client`](../surface-client) (which owns the
framework-agnostic auth + data layer: OAuth, `VaultClient`, token storage,
core types).

This package owns **"render a note"**:

- **Markdown + wikilinks** — `<MarkdownView>` (react-markdown + GFM) with a
  per-surface `[[wikilink]]` resolver and link-component hook. A single
  internal newline renders as a visible line break by default (Obsidian /
  GitHub-comment style, not strict CommonMark) — see
  [**Line breaks**](#line-breaks).
- **Auth'd vault media** — `<VaultImage>` / `<VaultAudio>` that fetch
  `/api/storage/…` blobs *with* the surface's authorization.
- **Multi-format renderers** — `<CsvRenderer>` (→ table), `<JsonRenderer>`
  (pretty), `<YamlRenderer>`, `<CodeRenderer>`, `<PlainRenderer>`.
- **A format dispatcher** — `<NoteRenderer>` picks the renderer from the
  note's path; `formatForPath` is exported standalone.
- **MDX** — `<MdxView>` renders `.mdx` **as markdown by default** (safe; no
  code execution), with an opt-in component-allowlist evaluation seam.
- **Rich notes** — `<RichNoteView>` and `<NoteRenderer rich>` draw a note that
  uses a rich pattern (a recipe, minutes, tasks, a dated log, callouts, a
  chartable table…) with the vendored rich-notes-kit; every other note draws
  as before. See [**Rich notes**](#rich-notes).

It ships **primitives + good defaults + override hooks**, **not** a turnkey app
shell. The surface owns routing, chrome, and domain components; this package
never bakes in a URL space, a router, or an opinionated layout.

> Design: [parachute.computer/design/2026-06-03-surface-client.md](https://github.com/ParachuteComputer/parachute.computer)
> — decisions A–D. This package is Phase 3.

## Install

```sh
npm add @openparachute/surface-render @openparachute/surface-client react react-dom react-markdown remark-gfm remark-breaks
# optional, for fenced-code-block coloring in markdown:
npm add rehype-highlight
```

`react`, `react-dom`, `react-markdown`, `remark-gfm`, and `remark-breaks` are
**required peer dependencies** (the package doesn't bundle React, and
`MarkdownView` imports `remark-gfm` and `remark-breaks` unconditionally).
`rehype-highlight` is an optional peer (only needed if you pass it for
fenced-code-block coloring).

## Quick start

```tsx
import { MarkdownView, type WikilinkResolver } from "@openparachute/surface-render/markdown";
import { vaultClientFetchBlob } from "@openparachute/surface-render/embed";
import { Link as RouterLink } from "react-router";

// 1. Your surface decides the URL space for wikilinks (decision D):
import { resolvedLink, unresolvedLink } from "@openparachute/surface-render/markdown";

const resolve: WikilinkResolver = (target) => {
  const id = myIndex.lookup(target);
  // Unresolved targets STILL navigate (create-on-navigate) — the common case.
  return id ? resolvedLink(`/n/${id}`) : unresolvedLink(`/n/${target}`);
};

// 2. Adapt your router's <Link> to the link-component shape:
const Link = ({ href, className, children }) => (
  <RouterLink to={href} className={className}>{children}</RouterLink>
);

// 3. Adapt your vault client to the fetch-blob fn (for auth'd media).
//    `vaultClientFetchBlob` is a plain fn — safe at module scope. Inside a
//    component, prefer the memoized `useVaultFetchBlob(client)` hook.
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
| `resolve` | `(target) => { href; exists } \| null` | The surface owns the URL space (`/n/<id>`, `/entity/<slug>`, …). See [**Resolving wikilinks**](#resolving-wikilinks-null-vs-existsfalse) for the `null` vs `{ exists: false }` distinction. |
| `linkComponent` | `ComponentType<{ href; className?; children }>` | The surface injects its router's `<Link>` without the shared layer importing a router. Defaults to a plain `<a>`. |
| `fetchBlob` | `(url) => Promise<Blob>` | The surface supplies the auth. Use the [`useVaultFetchBlob(client)`](#fetching-authd-media) hook (works with notes-ui's `fetchAttachmentBlob` subclass *or* a base `VaultClient` via `storageUrl` + token) or a custom function. |
| `highlight` | `(code, lang) => string` | **One** syntax-coloring hook for [**all** code paths](#syntax-highlighting-one-hook-everywhere) — code/json/yaml notes *and* fenced code inside markdown. Defaults to **escape-only** (inert, no dependency); pass a `highlight.js`-backed fn for coloring. |
| `components` | react-markdown `Components` | Per-element overrides merged over the defaults (and over the built-in `highlight` `code` renderer). |
| `overrides` | per-format renderer fns | `<NoteRenderer>` lets a surface swap any format's renderer (e.g. a JSON tree view). The override prop types are [exported as named aliases](#override-prop-types) so no `as`-casts are needed. |

## Resolving wikilinks (`null` vs `{ exists: false }`)

A `WikilinkResolver` returns one of three things, and the choice between `null`
and `{ exists: false }` is the single most common source of confusion — they
look interchangeable but render **materially differently**:

| Return value              | Rendered as                                           | Navigable? |
|---------------------------|-------------------------------------------------------|------------|
| `{ href, exists: true }`  | live link, class `wikilink wikilink-resolved`         | ✅ yes      |
| `{ href, exists: false }` | dashed "create-on-navigate" link, `wikilink wikilink-unresolved` | ✅ **yes**  |
| `null`                    | inert `<span>`, `wikilink wikilink-unresolved`, **no anchor**  | ❌ **no**   |

- `{ exists: false }` keeps a **working link** to a destination that doesn't
  exist *yet* — the canonical "click to create" affordance (notes-ui links an
  unresolved `[[Foo]]` to `/n/Foo`, where the note is created on navigate).
- `null` drops the link **entirely** — the words render as styled text the
  reader can see but **cannot click**.

**For most surfaces, "unresolved-but-still-linked" is what you want.** Two tiny
helpers make the intent obvious at the call site:

```ts
import { resolvedLink, unresolvedLink } from "@openparachute/surface-render/markdown";

const resolve: WikilinkResolver = (target) => {
  const id = index.lookup(target);
  return id ? resolvedLink(`/n/${id}`) : unresolvedLink(`/n/${target}`); // still navigates
};
```

Reach for `null` (re-exported as the named sentinel `INERT`) only when an
unresolved target should genuinely have **no destination**:

```ts
import { INERT, resolvedLink } from "@openparachute/surface-render/markdown";
const resolve: WikilinkResolver = (t) => (index.has(t) ? resolvedLink(href(t)) : INERT);
```

> ⚠️ **Trust boundary:** the resolver owns the `href` it returns — validate the
> target and mint hrefs you control. Never echo a vault-authored target string
> straight back as the `href` (a `javascript:` URI could be injected). The
> plugin sets the href verbatim and does **not** sanitize it.

## Fetching auth'd media

`/api/storage/…` images and audio need the surface's authorization. Adapt your
vault client to a `fetchBlob` with the **`useVaultFetchBlob` hook** — no more
hand-writing `useMemo(() => vaultClientFetchBlob(client) ?? undefined, …)`:

```tsx
import { useVaultFetchBlob } from "@openparachute/surface-render/embed";

function NoteBody({ note, client }) {
  const fetchBlob = useVaultFetchBlob(client); // memoized; undefined when signed out
  return <MarkdownView content={note.content} fetchBlob={fetchBlob} />;
}
```

It accepts any client exposing `fetchAttachmentBlob` (notes-ui's subclass) **or**
`storageUrl` + `getAccessToken` (a base `VaultClient`), returns `undefined` when
the client can't produce blobs, and is memoized on `client` so the function
identity is stable (important — `fetchBlob` is an effect dependency downstream).
The lower-level `vaultClientFetchBlob(client)` adapter is still exported for
non-hook contexts.

### Only vault attachments load

A note never makes the reader's device load anything from outside the vault.
`VaultImage` / `VaultAudio` (and so every image `MarkdownView` and
`NoteRenderer` draw) treat a `src` like this:

| `src` | Shown as |
|---|---|
| `/api/storage/…` (what the Obsidian import writes) | fetched with auth through `fetchBlob`, shown from an object URL |
| an absolute `<vaultUrl>/api/storage/…` URL | the same, **only** when you pass `vaultUrl` (the vault's base URL, e.g. `https://hub.example/vault/default`) |
| `data:image/png\|jpeg\|gif\|webp\|avif`, `data:audio/…`, `blob:` | shown as is (no request) |
| any other `http(s)` URL | never loaded: a plain link (`.vault-media-remote`, alt text or the address) that opens in a new tab with no referrer when tapped |
| anything else (`javascript:`, a non-storage path, …) | never loaded: words (`.vault-media-blocked`) |

So `![](https://tracker.example/x.png)` can't tell a server the note was
opened, and `![](https://evil.example/api/storage/x.png)` can't collect the
vault token: an absolute URL is storage only under the vault you name, and the
`fetchBlob` adapters and `VaultClient.fetchAttachmentBlob` refuse any other
vault before making a request (they resolve the URL once and fetch exactly
what they checked). A surface that wants remote images loaded
anyway passes its own `components.img`. Pair this with a page CSP that has no
remote `img-src` / `media-src` / `connect-src`: the renderer is one wall, the
CSP the second.

## Syntax highlighting (one hook, everywhere)

There is **one** `highlight` hook — `(code, lang) => htmlString` — and it now
covers **both** code paths:

1. whole code/json/yaml notes (the format renderers), and
2. **fenced code blocks inside markdown** (` ```ts … ``` ` in a `.md` note).

Pass it once to `<NoteRenderer>` (or `<MarkdownView>`) and every code path
colors consistently, emitting the same `<pre><code class="hljs language-X">`
markup so one stylesheet themes them all:

```tsx
import { NoteRenderer } from "@openparachute/surface-render/note";
<NoteRenderer note={note} resolve={resolve} highlight={highlightAs} />;
// highlightAs is your highlight.js-backed (code, lang) => string
```

The default (omit `highlight`) is **escape-only** — inert, no coloring, no
dependency.

> ⚠️ **Don't combine `highlight` with `rehypePlugins={[rehypeHighlight]}`.**
> They are two routes to the same fenced-code result; using both
> double-processes the markup. Pick one:
> - **`highlight`** (recommended) — shares the hook the format renderers use,
>   no extra peer dependency, one mechanism for every code path.
> - **`rehypePlugins={[rehypeHighlight]}`** — the older path; needs the optional
>   `rehype-highlight` peer and only colors markdown fences (not code notes).
>
> When `highlight` is set, the built-in markdown `code` renderer activates; a
> `components.code` override you pass still wins over both.

## Line breaks

`<MarkdownView>` renders a single `\n` inside a paragraph as a visible `<br>`
by default (`breaks` defaults to `true`) — Obsidian / GitHub-comment behavior,
not strict CommonMark (which collapses a soft break to a space, requiring a
trailing double-space or backslash to force one). This matches the
Enter=paragraph / Shift+Enter=newline authoring model: the newline only reads
right if it actually shows.

```tsx
<MarkdownView content={note.content} />               {/* breaks: true (default) */}
<MarkdownView content={note.content} breaks={false} />  {/* strict CommonMark */}
```

Fenced code blocks and inline code are unaffected either way — the newlines
inside them are never touched. `<NoteRenderer>` forwards `breaks` straight
through to the markdown branch.

## Wikilinks vs embeds

`remarkWikilinks` handles **only `[[…]]` links**. Embeds (`![[…]]`) are *not*
handled here: the Obsidian import rewrites `![[file]]` embeds to standard
markdown images `![](/api/storage/…)`, which the `img` override routes through
`<VaultImage>` (auth'd blob). This keeps the renderer's embed handling and the
importer's rewrite as two ends of one contract. A surface with raw,
un-imported `![[…]]` embeds can preprocess them into `/api/storage/…` images
or `<VaultAudio>` before rendering.

## Rich notes

`<NoteRenderer rich>` draws a markdown note that uses a rich pattern with
[rich-notes-kit](./src/rich/VENDORED.md) (PATTERNS v0.3, vendored, MIT), and
every other note with `<MarkdownView>` exactly as before:

| Pattern | Drawn as |
|---|---|
| tag `recipe` | ingredient check-offs, servings stepper, US ↔ metric, timers in the steps, cook mode |
| tag `minutes` | attendance against `quorum`, a tally per vote |
| tag `session` | pull quotes, who owes what, check-ins chart |
| tag `chant` (` ```chordpro `) | chords over syllables, transpose |
| `- [ ] task @owner due 2026-11-20` | a checkbox that saves `[x]` through `onSave`, owner chips, "3 days late" |
| `- 2026-11-03: …` lines | a timeline, newest first, with a button to add today's line |
| `> [!NOTE]` … the five GitHub callouts | a callout |
| `<details><summary>` | a disclosure (any other HTML is text) |
| a table with an all-number column | a quiet "Chart" switch |

A note with only headings, paragraphs, plain lists, links or metadata has no
rich pattern and goes to `<MarkdownView>`. `rich` defaults to `false`;
`overrides.markdown` still wins over it.

```tsx
import "@openparachute/surface-render/rich-notes-kit.css";

<NoteRenderer
  note={note}                 // surface-client's Note: content, metadata, tags, id, updatedAt
  rich
  resolve={resolve}           // [[wikilinks]] → onNavigate(href); without it they're text
  onNavigate={navigate}       // your router
  fetchBlob={fetchBlob}       // the note's own /api/storage/… images; nothing else is fetched
  vaultUrl={vaultUrl}         // optional: the vault's base URL, as for MarkdownView
  onSave={(content, patch) =>   // resolve with the saved note; the kit moves its revision on
    vault.updateNote(note.id, { content, if_updated_at: patch.revision ?? note.updatedAt })}
  openLink={openExternal}     // an app webview's opener; without it, a target=_blank link
/>
```

Without `onSave` tasks and logs are read-only. `<RichNoteView note={…}>` is the
same view on its own (`@openparachute/surface-render/rich`). The same note with
new content updates in place and keeps the reader's sitting (ticks, servings,
cook-mode step, timers); a different note (by `id`, else `path`; give unsaved
notes one of them), or a hook that appears or goes (`onSave`, `resolve`,
`openLink`, `fetchBlob`, `units`), starts fresh.

**No network, ever.** The kit loads nothing: a remote image is a link, links
open only on a tap (`https:`, `mailto:`, `geo:` and wikilinks only), the
stylesheet has no `url()`, and note text enters the page only as text
(`<details>`/`<summary>` is the only HTML honoured). The one thing it asks the
host for, an attachment image, goes through `fetchBlob` only when
`isVaultStorageUrl(src, vaultUrl)` passes, the same check as the table above.
The kit hands the host only relative paths, so in a rich note an absolute
URL, even `<vaultUrl>/api/storage/…`, is a link, never loaded.
`RichNoteView.test.tsx` draws every fixture with every control opened and
fails on any request or URL-loading node; `no-remote-media.test.tsx` draws a
rich note full of remote images against a surface `fetchBlob` that would send
the token anywhere, and fails on any request.

Theme it with the kit's variables (`--rn-ink`, `--rn-paper`, `--rn-accent`,
`--rn-serif`, …; see `rich-notes-kit.css`). Dark mode follows
`prefers-color-scheme`; `[data-screen="ink"]` or `.rn-ink` gives the e-ink look.

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

## Emitted CSS classes (complete contract)

The renderers emit a fixed, styleable class contract. This is the **complete**
list — every class any renderer can put on the page. Style against these
(override `className` / `components` to opt out of any). Most need a surface
theme; the *affordance* classes (scroll/warning/error/loading/audio) have sane
defaults in the [optional baseline stylesheet](#optional-baseline-stylesheet).

| Class | Emitted by | On | Purpose |
|---|---|---|---|
| `prose-note` | `MarkdownView`, `Csv/Json/Yaml/Code/Plain`, `MdxView` (default `className`) | container `<div>` | The typographic prose container. **Surface owns the theme.** |
| `wikilink` | `remarkWikilinks` | every wikilink `<a>` / inert `<span>` | Base wikilink class (always paired with one below). |
| `wikilink-resolved` | `remarkWikilinks` | resolved wikilink `<a>` | Live link to an existing note. |
| `wikilink-unresolved` | `remarkWikilinks` | unresolved `<a>` *or* inert `<span>` | Dashed "doesn't exist yet" affordance. |
| `hljs` | `CodeRenderer`, highlighted markdown fences | `<code>` | highlight.js host class — theme via any highlight.js stylesheet. |
| `language-<id>` | `CodeRenderer`, markdown fences | `<code>` | The code language (`language-ts`, `language-json`, …). |
| `csv-scroll` | `CsvRenderer` | wrapper `<div>` | Horizontal-scroll container for wide tables. |
| `csv-warning` | `CsvRenderer` | `<p>` | Malformed-CSV inline warning. |
| `vault-media-loading` | `VaultImage`, `VaultAudio` | `<span>` | Shown while an auth'd blob fetch is in flight. |
| `vault-media-error` | `VaultImage`, `VaultAudio` | `<span>` | Shown when the auth'd fetch fails (renders the message). |
| `vault-media-remote` | `VaultImage`, `VaultAudio` | `<a>` | A remote http(s) src, not loaded: a link the reader can open. |
| `vault-media-blocked` | `VaultImage`, `VaultAudio` | `<span>` | Any other non-vault src, not loaded: shown as words. |
| `vault-audio` | `VaultAudio` | wrapper `<span>` | Audio-embed container. |
| `vault-audio-label` | `VaultAudio` | `<span>` | Optional caption next to the control. |

Wikilink `<a>`/`<span>` also carry data attributes: `data-wikilink-target`
(the raw `[[target]]` text) and `data-wikilink-resolved` (`"true"`/`"false"`).

### Optional baseline stylesheet

So you're not source-spelunking to discover unstyled scroll/warning/error/
loading/audio elements, the package ships an **optional** baseline stylesheet
with sane neutral defaults for those *affordance* classes:

```ts
import "@openparachute/surface-render/styles.css";
```

Scope, on purpose:

- It styles the **affordance** classes (`csv-scroll`, `csv-warning`,
  `vault-media-loading`, `vault-media-error`, `vault-media-remote`,
  `vault-media-blocked`, `vault-audio*`, dashed
  `wikilink-unresolved`) and a minimal no-theme `.hljs` (display block +
  overflow).
- It does **not** theme `.prose-note` typography — that's your design decision.
- It does **not** ship a highlight.js color theme — import one yourself (e.g.
  `import "highlight.js/styles/github-dark.css"`).

Every value uses a CSS custom property with a neutral fallback
(`--sr-warning-fg`, `--sr-error-fg`, `--sr-loading-bg`, `--sr-muted-fg`, …) so
you can retheme by setting vars instead of overriding rules.

## Override prop types

`<NoteRenderer overrides={…}>` and `<MarkdownView components={…}>` accept
per-format / per-element override functions. The override prop types are
**re-exported as named aliases from the main entry** so you can annotate your
override functions without `as`-casts or deep imports:

```ts
import type {
  WikilinkResolver,
  MarkdownViewProps,
  NoteRendererOverrides,
  MarkdownOverride,        // (props: MarkdownOverrideProps) => ReactNode
  MarkdownOverrideProps,   // === MarkdownViewProps
  CodeOverrideProps,       // { content; language; className?; highlight? }
  HighlightableOverrideProps, // json/yaml: { content; className?; highlight? }
  BasicFormatOverrideProps,   // csv/plain: { content; className? }
} from "@openparachute/surface-render";

const overrides: NoteRendererOverrides = {
  markdown: (props) => <MyMarkdown {...props} />, // props: MarkdownViewProps, no cast
  code: ({ content, language, highlight }) => <MyCode … />,
};
```

## Subpath exports

```
@openparachute/surface-render            barrel (everything)
@openparachute/surface-render/markdown   MarkdownView, remarkWikilinks, resolver/link hooks, resolvedLink/unresolvedLink/INERT
@openparachute/surface-render/embed      VaultImage, VaultAudio, FetchBlob, vaultClientFetchBlob, useVaultFetchBlob
@openparachute/surface-render/formats    Csv/Json/Yaml/Code/Plain renderers, parseCsv, highlight hook
@openparachute/surface-render/note       NoteRenderer, formatForPath, override prop types
@openparachute/surface-render/mdx        MdxView
@openparachute/surface-render/rich       RichNoteView, parseRichNote, hasRichPattern
@openparachute/surface-render/styles.css optional baseline stylesheet (affordance defaults)
@openparachute/surface-render/rich-notes-kit.css  the rich view's stylesheet (needed with `rich`)
```

## License

AGPL-3.0. The vendored rich-notes-kit and markdown-it are MIT
([THIRD_PARTY.md](./THIRD_PARTY.md)).
