# Changelog — @openparachute/surface-server

## 0.1.3-rc.1 (unreleased)

- `defineTool` — the WRITE-capable sibling of `defineProjection`. A tool
  declares a domain ACTION (`name`/`describe`/`params`/`access`/`handler`)
  whose handler `async ({ params, actor, ctx }) => result` MAY mutate via
  `ctx.vault.createNote/updateNote/deleteNote` — projections only ever
  query. Both faces ride the SAME `POST ${mount}/api/mcp` endpoint:
  `tools/list` shows projections AND tools (filtered per actor),
  `tools/call` dispatches to whichever owns the name. Add tools via the new
  `tools` field on `createSurfaceProjections`, or the `createSurfaceTools`
  convenience (co-hosts projections + tools, MCP-only — no REST route).
  - **Actor-gating + no-existence-oracle carry over exactly**: a
    denied/anon actor never sees a tool in `tools/list`, and a denied
    `tools/call` returns the IDENTICAL "unknown tool" error as a
    nonexistent one — across BOTH projections and tools (one unified
    visibility map, same `projectionAllows`/`toolAllows` predicate).
  - **Access is REQUIRED — no default.** Unlike `defineProjection` (which
    defaults to `audience`), `defineTool` makes `access` mandatory and
    THROWS if omitted: a write tool with no access bar is a worse footgun
    than a leaky read. `public` is expressible but is an explicit
    world-writable opt-in, never implicit. Deny-by-default is enforced
    identically to the router/projections.
  - **Host-custodied write boundary.** Handlers write through `ctx.vault`
    (the `ScopedVaultClient`), which already rejects `force: true`
    host-side; the kit adds no second force path. Names share one kebab
    space with projections (collisions throw at build).

## 0.1.2 (2026-06-12)

- `GrantStore.onChange(handler)` — subscribe to grant-set changes, fired after
  any cache mutation (stream snapshot/upsert/remove, degraded-revalidation
  rebuild, optimistic local writes). Coarse by design (no payload): consumers
  holding long-lived authorization (live collab connections) re-evaluate via
  `can()`; handler errors are contained, never thrown into the stream. (#100)
- Missing-note oracle closed: the deny-by-default router normalizes the
  vault's typed not-found on note reads to the same 404 as a denied read
  (missing ≡ denied) instead of leaking a 500-vs-404 existence oracle. The
  `isVaultNotFound` helper is exported for backends doing their own note
  reads. (#102)
- Reconciler not-found normalization: `getNote` throws normalize to `null`
  through the same `isVaultNotFound` seam, so deleted-note branches are
  reachable — tracking drops instead of retrying forever against a gone
  note. (#117)
- `SECURITY.template.md` ships in the published package — the fill-in
  security-posture template for surfaces built on the kit. (#116)

## 0.1.1 (2026-06-10)

Dependency-range fix, no code changes.

- `@openparachute/surface-client` range corrected `^0.2.0` → `^0.3.0`. The kit's
  GrantStore SSE cache and reconciler use `VaultClient.subscribe()`, which only
  exists in surface-client ≥ 0.3.0 — under the 0.1.0 ranges, npm resolved
  surface-client 0.2.0 and the subscribe path failed at runtime.
- `@openparachute/surface` range corrected `^0.3.0` → `^0.3.1` for the same
  reason (the host's `SurfaceStateStore` export ships in 0.3.1).

**Do not use 0.1.0** — it was published manually ahead of the range fix and
installs a broken dependency graph in a fresh project.

## 0.1.0 (2026-06-10)

First publish (manual, superseded same-day by 0.1.1).

- `createSurfaceAuth` — actor resolution (hub JWT / capability links / anon;
  presented-but-invalid credentials are refused, never downgraded), audience
  store, capability-link mint/verify/exchange, origin checks, fail-closed
  rate limiting.
- `SurfaceAuthz` — `can()` grant table, vault-native `GrantStore` with an
  SSE-fed cache that fails closed on stream loss, deny-by-default router.
- `defineProjection` — one declaration compiles to audience-gated REST
  endpoints and a per-surface Streamable-HTTP MCP server.
- Public conformance suite (`@openparachute/surface-server/conformance`)
  with positive controls.
