# Changelog

## [0.1.0-rc.3] - 2026-05-22

feat(app): Phase 1.2 — admin endpoints + DCR + npm-fetch + Vite+React admin SPA.

Phase 1.2 takes the bundled-UI-host daemon from "operator manually drops
dist/ into uis/" to "operator runs `parachute-app add <source>` and the
daemon handles copy + DCR + re-scan." Adds the admin HTTP surface, the
Dynamic Client Registration call to hub, an npm-fetch shorthand for
sourcing UIs by package specifier, and a Vite + React admin SPA mounted
at `/app/admin/`.

### Added

- `src/auth.ts` — hub-JWT validation via `@openparachute/scope-guard@^0.3.0`.
  Audience `app`; scopes `app:read` (list/info) and `app:admin` (add/remove/
  reload). `enforceScope` mirrors runner's pattern; `hasReadAccess` lets
  admin imply read.
- `src/operator-token.ts` — operator bearer sourcing for outbound DCR
  calls. Priority: `PARACHUTE_HUB_TOKEN` env > `~/.parachute/operator.token`
  file (chmod 0o600 required on Unix). Missing token returns undefined; the
  caller decides whether that's fatal.
- `src/dcr.ts` — RFC 7591 Dynamic Client Registration with hub. Sends
  `client_name`, `redirect_uris` (`/app/<name>/` + `/app/<name>/oauth-callback`),
  `scope` (joined), `token_endpoint_auth_method: "none"`, `grant_types:
  ["authorization_code"]`, `response_types: ["code"]`. Persists the returned
  `client_id` to `~/.parachute/app/uis/<name>/.oauth-client.json` (chmod 0o600).
  Surfaces hub errors as a typed `DcrError` (status: hub_unreachable /
  hub_rejected / invalid_response). Best-effort `DELETE /oauth/clients/<id>`
  on remove; tolerates 404/405 (RFC 7592 not universally implemented yet).
- `src/npm-fetch.ts` — `bun add <spec>` into a `/tmp/parachute-app-staging-*`
  dir, then copies `node_modules/<pkg>/dist/` into the UI's home. Distinguishes
  404 / network / generic errors by sniffing stderr. Cleanup always runs.
  Supports plain names, scoped names, and `@version` tails.
- `src/admin-routes.ts` — the Phase 1.2 admin endpoints:
  - `GET /app/list` (`app:read`) — serialized UI summaries + skipped list
  - `POST /app/add` (`app:admin`) — accepts local path OR npm spec; copies
    bundle + writes meta.json + (optionally) fires DCR + re-scans
  - `DELETE /app/<name>` (`app:admin`) — revokes OAuth + removes dir +
    re-scans
  - `POST /app/<name>/reload` (`app:admin`) — re-scans without daemon restart
  - `GET /app/<name>/info` (`app:read`) — full info: meta + oauth + paths
  - `GET /app/<name>/oauth-client` — UNAUTHENTICATED — returns
    `{client_id, hub_url, scope, redirect_uris}` for the UI to use at boot
  - Auto-rejects `/app/admin` as a reserved mount path.
  - Validates name + path patterns; rejects collisions with 409.
  - After every mutation: re-runs `scanUis()` + refreshes `services.json`
    with the per-UI `uis` map (design doc section 12 shape).
- `src/http-server.ts` — wires the admin routes into the existing Bun.serve
  handler. POST/DELETE now flow through the admin matcher; non-admin POST/
  DELETE returns 404 (was 405). Unknown methods still return 405. New
  `/app/admin/[*]` static mount serves the built SPA from `dist/admin/`;
  falls back to a dev-time placeholder when the bundle is absent.
- `web/admin/` — Vite + React + TypeScript admin SPA. React 19, react-router
  7. Routes: `/` (Modules), `/add` (Add UI form), `/info/:name`. Auth via
  `localStorage["parachute_operator_token"]` (Phase 1.3 wires hub-session
  auth). Builds to root `dist/admin/`. Per-UI Reload + Remove buttons hit
  the live admin endpoints. Skipped UIs surface inline with their failure
  reason.
- `bin/parachute-app.ts` — `add`, `remove`, `list`, `reload` verbs are no
  longer stubs. Each calls the local daemon's admin endpoints over HTTP
  (`PARACHUTE_APP_URL` env overrides). Sources the operator bearer via the
  same `readOperatorToken` the daemon uses.
- Tests:
  - `src/__tests__/auth.test.ts` — bearer extraction, scope checks,
    `validateBearer` 401 paths, `getHubOrigin` resolution
  - `src/__tests__/operator-token.test.ts` — env vs file priority, mode
    0o600 defense
  - `src/__tests__/dcr.test.ts` — DCR request shape, operator-bearer
    forwarding, hub-error surfacing, file persistence + revocation
  - `src/__tests__/npm-fetch.test.ts` — spec parsing, fake-bun-add
    integration, error-code mapping
  - `src/__tests__/admin-routes.test.ts` — auth gates + full happy paths
    with the `enforceScopeFn` test seam
  - `src/__tests__/admin-integration.test.ts` — end-to-end add/delete/
    reload through Bun.serve
  - `web/admin/src/lib/api.test.ts` — api.ts wrapper coverage
  - `web/admin/src/routes/Modules.test.tsx` — list view, error banner,
    Reload + Remove button flows
  - `web/admin/src/routes/Add.test.tsx` — form submission shape + success
    rendering
  - `web/admin/src/App.test.tsx` — shell + token banner

### Changed

- Bumped to `0.1.0-rc.3`. `.parachute/info` capabilities now include
  `admin-spa`.
- `bin/parachute-app.ts` help text reflects the live `add`/`remove`/`list`/
  `reload` verbs.
- `src/http-server.ts` 405 policy: POST/DELETE no longer return 405 globally;
  they flow to admin routes and fall through to 404 when no admin route
  matches. PATCH and other unhandled methods still return 405.
- `package.json#files` now includes `dist/admin/**` so the npm-published
  bundle ships the admin SPA. Added `build` / `test:admin` / `typecheck:all`
  scripts coordinating root + web/admin.
- `package.json` now depends on `@openparachute/scope-guard@^0.3.0` for
  hub-JWT validation.

### Verified

- `bun test ./src` → 213 pass / 0 fail (was 117).
- `cd web/admin && bun run test` → 21 pass / 0 fail.
- `bun run typecheck` → clean (root + web/admin).
- `bunx biome check .` → clean.
- `cd web/admin && bun run build` → `dist/admin/` populated.
- `bin/parachute-app.ts --version` → 0.1.0-rc.3.
- `bin/parachute-app.ts --help` → shows full Phase 1.2 verb list.

## [0.1.0-rc.2] - 2026-05-22

feat(app): Phase 1.1 — core UI hosting with smart cache headers + PWA opt-in.

Replaces the Phase 1.0 stub with a real `serve` daemon. App now scans
`$PARACHUTE_HOME/app/uis/` for declared UIs, validates each meta.json,
mounts each bundle at its declared path under `/app/`, and serves the
dist/ contents with smart cache headers + SPA-routing fallback.

### Added

- `src/config.ts` — load + validate `$PARACHUTE_HOME/app/config.json`,
  with sensible defaults. Missing file is OK; malformed file fails fast.
  Honors `PARACHUTE_HOME` env var.
- `src/meta-schema.ts` — hand-rolled validator for per-UI meta.json.
  Required fields: `name` (pattern `^[a-z][a-z0-9-]*$`), `displayName`,
  `path` (pattern `^/app/[a-z0-9-]+$`). Optional: `tagline`, `version`,
  `iconUrl`, `scopes_required` (defaults to `["vault:*:read"]`),
  `vault_default`, `pwa` (default false), `pwa_service_worker` (required
  when `pwa: true`), `public` (default false). Exposes
  `InvalidMetaError` with a flat `details` list.
- `src/ui-registry.ts` — `scanUis()` scans the uis-dir, validates each
  meta.json + dist/index.html, resolves mount-path collisions
  deterministically (alphabetical-by-name wins, losers demoted to
  `status: "collision"`). Returns `{registered, skipped}`. The reserved
  path `/app/admin` is rejected for hosted UIs (admin SPA lands in
  Phase 1.2).
- `src/cache-headers.ts` — `cacheHeadersFor(filename, meta?)` returns
  smart `Cache-Control` headers per design doc section 18:
  index.html → `no-cache, no-store, must-revalidate`; content-hashed
  assets (matching `[a-f0-9]{8,}`) → `public, max-age=31536000,
  immutable`; non-hashed assets → `public, max-age=3600`; PWA service
  worker (when meta opts in) → `no-cache`.
- `src/http-server.ts` — Bun.serve loopback HTTP server on port 1946.
  Routes: `GET /healthz` + `GET /app/healthz` (open, returns UI counts),
  `GET /.parachute/info` + `/.parachute/config/schema` + `/.parachute/config`
  (open; no secrets in app config), and per-UI bundle serving with SPA
  fallback. Path-traversal-safe. HEAD requests supported. 405 on
  non-GET methods (Phase 1.2 opens up POST/PUT/DELETE for admin
  endpoints).
- `src/services-manifest.ts` + `src/self-register.ts` — mirrors runner's
  pattern exactly. Self-registers app's row into
  `~/.parachute/services.json` on `serve` boot. Best-effort: write
  failures are logged + swallowed. Existing operator-set ports are
  preserved across restarts. `extraFields` hook lets Phase 1.2 stamp the
  per-UI `uis` map without changing the signature.
- `src/__tests__/{config,meta-schema,ui-registry,cache-headers,http-server,self-register,serve,cli}.test.ts` —
  unit + integration coverage. 114 tests total (was 1).

### Changed

- `bin/parachute-app.ts` — `serve` verb now boots the real daemon (no
  more stub). Wires SIGINT/SIGTERM to graceful shutdown. Help text
  updated to reflect Phase 1.1 capabilities.
- `src/index.ts` — `serve()` and `runOnce()` implemented; the per-verb
  stubs for Phase 1.2 (`addUi`, `removeUi`, `listUis`, `reloadUi`) and
  Phase 1.3 (`setDevMode`) remain as documented placeholders. Re-exports
  the new modules.
- `.parachute/info` — version bumped to 0.1.0-rc.2.

### Verified

- `bun test` → 114 pass / 0 fail.
- `bun run typecheck` → clean.
- `bunx biome check .` → clean.
- Live smoke against `~/.parachute/app/uis/test-ui/`:
  - `/app/healthz` returns `{status:"ok",uis:1,skipped:0}`.
  - `/app/test-ui/` returns the index.html with
    `Cache-Control: no-cache, no-store, must-revalidate`.
  - `/app/test-ui/app.abc12345.js` returns `Cache-Control: public,
    max-age=31536000, immutable`.
  - `/app/test-ui/style.css` returns `Cache-Control: public,
    max-age=3600`.
  - `/app/test-ui/some/spa/route` falls through to index.html.
  - `~/.parachute/services.json` has the parachute-app row with
    `port: 19460`, `paths: ["/app","/.parachute"]`, `installDir`.

## [0.1.0-rc.1] - 2026-05-21

Initial scaffold per design doc. Module-protocol-compliant skeleton with stub bin and library entry — no UI hosting, no admin endpoints, no OAuth DCR yet. Those land in Phase 1.1+.

### Added

- `.parachute/module.json` — manifest declaring `port: 1946`, paths `["/app", "/.parachute"]`, health `/app/healthz`, scopes `app:read` + `app:admin`. No `kind` field (per hub#301 migration — `kind` is being dropped from the manifest validator).
- `.parachute/info` — module identity (name, displayName, tagline, version, capabilities).
- `.parachute/config/schema` — Draft-07 JSON Schema for `$PARACHUTE_HOME/app/config.json`: `hub_url`, `auto_register_oauth_clients`, `disabled`, `default_scope_required`, `dev_mode_allowed`.
- `bin/parachute-app.ts` — CLI with `--help` listing planned verbs by phase, `--version` printing from package.json, every subcommand stubbed to a phase-tagged not-yet-implemented message.
- `src/index.ts` — library surface: `VERSION`, `DEFAULT_PORT`, `DEFAULT_MOUNT`, plus stub functions (`serve`, `runOnce`, `addUi`, `removeUi`, `listUis`, `reloadUi`, `setDevMode`) each throwing a phase-tagged Error.
- `src/__tests__/scaffold.test.ts` — sanity test asserting `VERSION` matches `package.json#version`.
- `package.json` — `@openparachute/app@0.1.0-rc.1`, `bin: parachute-app → ./bin/parachute-app.ts`, scripts for `start` / `test` / `typecheck` / `lint`.
- `tsconfig.json`, `biome.json`, `.gitignore`, `LICENSE` (AGPL-3.0), `README.md` — standard repo scaffolding mirroring parachute-runner.

### Design

- [`2026-05-21-parachute-apps-design.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md)
