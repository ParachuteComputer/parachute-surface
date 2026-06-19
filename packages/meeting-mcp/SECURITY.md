# Security — Meeting MCP

This surface is **read-only**: it reads `#capture/meeting` notes from the
vault and exposes them as curated projections (MCP tools + REST). Its trust
model is small and deliberate.

## Actors & routes

| Route | Access | Auth |
|---|---|---|
| `GET  /api/recent-meetings` | public | none (curated projection) |
| `GET  /api/search-meetings` | public | none (curated projection) |
| `GET  /api/meeting` | public | none (curated projection) |
| `POST /api/mcp` | public | none (per-tool access enforced inside) |

All routes ride the kit's deny-by-default gateway (`createSurfaceRouter`):
rate limit → actor resolution → access enforcement → handler. Undeclared
paths under the api namespace are 404. Presented-but-invalid credentials are
a 401 (never a silent downgrade to anon). The gateway conformance suite
(`server/__tests__/conformance.test.ts`) pins deny-by-default; the
projection suite pins the disclosure boundary.

## The disclosure boundary (the hard invariant)

The ONLY data that leaves a projection is `notes.map(shape)`. The raw vault
note — its full body, its other tags, its path, and every metadata field the
`shape` function does not explicitly copy — **never rides out**. A consumer
sees exactly the curated fields:

- `recent-meetings` / `search-meetings` → `{ id, title, date, summary|snippet }`
- `meeting` → `{ id, title, date, attendees, body }`

`server/__tests__/projections.test.ts` proves a raw-note field that is NOT in
a shape (a distinctive content/tag marker) never appears in any response.

## Access (public by design, one-line knob to gate)

Every projection is `access: "public"` — the end-user MCP use case (anyone may
query the curated projection; the shape is the boundary). To require a
link/capability session, change a projection's `access` to `"audience"`; for
hub-identity only, `"operator"`. That single field changes BOTH faces
identically: the REST route declares it to the gateway, and the MCP endpoint
filters its `tools/list` + dispatch by the same predicate (a denied tool is
indistinguishable from a nonexistent one — no existence oracle).

## Vault effect

- The surface NEVER writes the vault — no `createNote` / `updateNote` /
  `deleteNote` anywhere. It only ever calls `ctx.vault.queryNotes`.
- The vault credential is the surface's host-custodied capability, scoped
  to read only (`scopes_required: ["vault:default:read"]`). The operator
  should narrow that read credential to the meeting tag at provision time —
  then even a shape bug cannot disclose notes outside the meeting tag.
- A vault query failure is the router's generic 500 (the real error is
  logged, never leaked in the response body).

## Reporting

Report security issues per the repository's root policy.
