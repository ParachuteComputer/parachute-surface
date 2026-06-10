# Changelog — @openparachute/surface-server

## 0.1.1 (2026-06-10)

Dependency-range fix, no code changes.

- `@openparachute/surface-client` range corrected `^0.2.0` → `^0.3.0`. The kit's
  GrantStore SSE cache and reconciler use `VaultClient.subscribe()`, which only
  exists in surface-client ≥ 0.3.0 — under the 0.1.0 ranges, npm resolved
  surface-client 0.2.0 and the subscribe path failed at runtime.
- `@openparachute/surface` range corrected `^0.3.0` → `^0.3.1` for the same
  reason (`SurfaceStateStore` / `SurfaceHostContext` ship in 0.3.1).

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
