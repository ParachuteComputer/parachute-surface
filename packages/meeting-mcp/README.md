# @openparachute/meeting-mcp

**Meeting MCP** — a **read-only** backed Parachute surface that reads
`#capture/meeting` notes from a vault and exposes them as an
**end-user-friendly MCP tool set + REST**, surfacing *domain vocabulary*
(recent meetings, search, one meeting) rather than raw vault notes.

This package is also **the reusable template for the "custom MCP over a
vault" pattern** — e.g. a public city-council-meetings vault, a product
changelog vault, a research-notes vault. Read the
[Re-targeting](#re-targeting-this-template) section to point it at your own
vault and tag.

It demonstrates the **P9 projection primitive** (`defineProjection` +
`createSurfaceProjections` from `@openparachute/surface-server`): you
declare a domain query **once**, and the kit derives **both** consumer
faces from that single definition — a REST endpoint and an MCP tool — both
riding the same deny-by-default gateway as every other surface.

It composes downstream of an ingest surface:
[`meeting-ingest`](../meeting-ingest) **writes** `#meeting` notes from
provider webhooks; this surface **reads** them. `ingest → vault → this
read-MCP`. (Point both at the same tag — see below.)

## What it exposes

Three projections, each available as **both** an MCP tool and a REST GET:

| Tool / REST | Params | Returns (the curated shape) |
|---|---|---|
| `recent-meetings` | `limit?` (default 20, max 100) | `{ id, title, date, summary }` |
| `search-meetings` | `query` (required) | `{ id, title, date, snippet }` |
| `meeting` | `id` (required) | `{ id, title, date, attendees, body }` |

### MCP endpoint

```
<your-hub-origin>/surface/meeting-mcp/api/mcp
```

Stateless Streamable HTTP (POST only; a GET is a 405, never a hanging
stream). Point any MCP client at it — `tools/list` returns the three tools
with their generated input schemas; `tools/call` runs the projection and
returns the shaped JSON envelope.

### REST

The same projections are plain HTTP GETs:

```
<your-hub-origin>/surface/meeting-mcp/api/recent-meetings?limit=20
<your-hub-origin>/surface/meeting-mcp/api/search-meetings?query=budget
<your-hub-origin>/surface/meeting-mcp/api/meeting?id=<meeting-id>
```

Each returns `{ projection, count, items: [...] }`. Bad params are a `400`
with per-param issues — never a `500`.

## The shape functions ARE the disclosure boundary

This is the whole point of the pattern. The **only** data that ever leaves
a projection is `notes.map(shape)`. The raw vault note — its full body, its
other tags, its path, and every metadata field the `shape` function does
not explicitly copy — **never rides out**.

A consumer (browser or AI) sees domain vocabulary, curated to exactly the
fields each `shape` returns. The list shapes deliberately omit the
transcript body; the single-`meeting` shape includes a curated `body` by
design. `server/__tests__/projections.test.ts` proves a raw-note field that
is **not** in a shape (a distinctive content/tag/metadata marker) never
appears in any response.

When you adapt this template, **the `shape` functions are the thing to get
right** — adding a field to a shape is the deliberate act of disclosing it.

## Public vs. gated — the one-line access knob

Every projection here is `access: "public"` (the end-user MCP use case:
anyone may query the curated projection, and the shape is the boundary).

To gate a projection, change its `access` in
[`server/projections.ts`](./server/projections.ts):

- `"public"` — anyone (the default here).
- `"audience"` — requires a link/capability session (a **gated MCP**).
- `"operator"` — hub identity only.

That single field changes **both faces identically**: the REST route
declares it to the gateway, and the MCP endpoint filters its `tools/list` +
dispatch by the same predicate (a denied tool is indistinguishable from a
nonexistent one — no existence oracle). An anon caller sees exactly the
`public` slice.

## Re-targeting this template

To point this surface at a **different vault and tag** (the "custom MCP over
*your* vault" case), three edits:

1. **`meta.json`** — set `vault_default` to your vault name and
   `scopes_required` to the read scope the operator provisions. Keep it
   **read-only** (`vault:<name>:read`) and, at provision time, narrow that
   read credential to your tag so even a shape bug can't disclose notes
   outside it.
2. **`DEFAULT_TAG`** in [`server/projections.ts`](./server/projections.ts)
   (or set the surface config `tag` at runtime).
3. **The `shape` functions** — match your domain's metadata vocabulary
   (and rename the projections / tweak the `describe` text so the MCP tool
   reads naturally for your domain).

Nothing in the kit changes — that's the reusable seam. The projection
primitive, the gateway, the MCP endpoint, the param validation, and the
disclosure boundary all come from `@openparachute/surface-server`.

## Composing with meeting-ingest

`meeting-ingest` writes meeting notes (default tag `meeting`); this surface
reads them (default tag `capture/meeting`, matching the team/project vault
convention). Align them by setting the surface config `tag` on **one** of
them so both name the same tag, then: a meeting transcribes → `meeting-ingest`
files a note → this surface immediately serves it over MCP + REST.

## Shape

```
meta.json                  audience: surface · scopes_required: vault:default:read · server.entry: server/index.bundle.js
server/index.ts            createBackend(ctx) — auth + grants + projections wiring (READ-only)
server/projections.ts      the three defineProjection() calls + the shape functions (the boundary)
web/                       a static landing page (fills the live MCP/REST URLs)
```

The surface NEVER writes the vault — no `createNote` / `updateNote` /
`deleteNote` anywhere. It only ever calls `ctx.vault.queryNotes`.

## Install

This package is `private: true` — it never publishes to npm. The
distribution is the GitHub release tarball attached by this repo's release
workflow on `meeting-mcp-v*` tags (layout: `package/` → `meta.json` +
`dist/` + `server/index.bundle.js`, the self-contained install shape).

**Requires hub ≥ the surface-audience tier** — this surface declares
`audience: "surface"`. Install via Surface admin → Add surface → paste the
release-tag URL, then `parachute restart surface`.

## Development

`bun run build` produces BOTH artifacts: the web bundle (`dist/`, via Vite)
and the server bundle (`server/index.bundle.js`, via `bun build
--target=bun`). The host mounts the bundle named by meta.json, not the TS
sources — after changing anything under `server/`, re-run `bun run build`
(or `bun run build:server`) before reloading the surface. Both artifacts are
gitignored (generated); `package.json#files` ships them in the release
tarball.

## Tests

`bun test packages/meeting-mcp/server/` (or `bun run test:meeting-mcp` from
the repo root): param validation (missing required / bad type / cap
enforced / unknown param), the projection shapes, the **disclosure
boundary** (a raw field outside a shape never leaks), empty-result shapes,
the MCP tool list + dispatch, the read-only invariant, error hygiene, and
the kit's public gateway conformance suite.

## Security

See [SECURITY.md](./SECURITY.md). In short: read-only (never writes the
vault); the shape functions are the disclosure boundary; a vault failure is
the router's generic 500 (logged, never leaked); the read credential should
be narrowed to the meeting tag at provision time.
