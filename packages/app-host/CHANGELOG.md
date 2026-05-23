# Changelog

This file tracks the workspace's two npm-publishable packages
side-by-side:

- `@openparachute/app` (host module, lives in `packages/app-host/`)
- `@openparachute/app-client` (shared client library, lives in `packages/app-client/`)

The admin SPA at `web/admin/` ships inside the host package as
`dist/admin/`; its version mirrors the host's version.

## [app 0.2.0-rc.6] - 2026-05-22

fix(app): restore `kind: "frontend"` in module.json (hub validator
requires it; the kind-removal awaits [hub#301](https://github.com/ParachuteComputer/parachute-hub/issues/301)
Phase A).

`.parachute/module.json` shipped at 0.2.0-rc.5 without a `kind` field
per the "kind doesn't matter" decision, but hub's manifest validator
in `parachute-hub/src/module-manifest.ts` still requires the field:

```
app: invalid module.json — .../parachute-app/.parachute/module.json:
"kind" must be "api" | "frontend" | "tool"
```

`parachute start app` rejects the install at boot, the bootstrap path
never runs, and no `notes-ui` is installed — `/app/notes` 404s. Until
hub#301 Phase A lands (relaxes `kind` to optional, defaults missing
to `"api"`), every app release must carry an explicit `kind`. App
serves UI bundles so `"frontend"` is the accurate value of the three
the validator permits.

## [app 0.2.0-rc.5] - 2026-05-22

fix(app): self-register uses `manifestName` as services.json row key
(matches hub install path; closes duplicate-port bug).

Hub installs modules under `manifest.manifestName` (`"parachute-app"`),
but the boot-time self-registration was writing under the short name
`"app"`. The two writes left services.json with two rows on the same
port, which trips hub's duplicate-port detector on re-read
(`duplicate port 1946 — claimed by both "parachute-app" and "app"`).

The row key is now sourced from `.parachute/module.json#manifestName`,
so the install path and the runtime path converge to one row. Mirrors
the fix landed in parachute-runner.

## [app 0.2.0-rc.1] + [app-client 0.1.0-rc.1] - 2026-05-21

feat(app): Phase 2.0 — extract `@openparachute/app-client` shared
library as a sub-package + add `required_schema` to meta.json
(folds [patterns#57](https://github.com/ParachuteComputer/parachute-patterns/issues/57)).

This is the monorepo-restructure release. The repo grows a workspace
shape with two publishable packages and a workspace-only admin SPA.
Each hosted app today re-implements OAuth + vault REST + token storage
from scratch (Notes did this; the Gitcoin Brain UI has its own); the
new `@openparachute/app-client` package extracts the canonical pattern.

Reference: [design doc 2026-05-21-parachute-apps-design.md](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md).

### Monorepo restructure

- `packages/app-host/` — the host module (formerly the entire repo).
  Bumped to `0.2.0-rc.1` (minor for the restructure).
- `packages/app-client/` — NEW shared library at `0.1.0-rc.1`.
- Root `package.json` becomes the workspace root (private
  `@openparachute/app-monorepo`). Workspaces: `packages/*` + `web/admin`.
- `web/admin/` (admin SPA) unchanged in shape; build output redirected
  to `packages/app-host/dist/admin/` so the daemon's `defaultAdminDir`
  still resolves correctly. Bumped to `0.2.0-rc.1` to mirror the host.

### `@openparachute/app-client` 0.1.0-rc.1 — public surface

Tree-shake-friendly subpath exports + a barrel:

| Subpath | Surface |
|---|---|
| `oauth` | `ParachuteOAuth` driver class (PKCE + same-hub auto-trust); `PendingApprovalError`, `RefreshHttpError`, `InsecureContextError` |
| `vault-client` | `VaultClient` REST client with auto-refresh on 401/403; `VaultAuthError` (carries `errorType` per notes#150), `VaultNotFoundError`, `VaultUnreachableError`, `VaultConflictError`, `VaultTargetExistsError`, `VaultUploadError` |
| `token-storage` | `loadToken` / `saveToken` / `clearToken` / `clearAllTokensForApp`; key format `parachute_token:<app-name>:<vault-scope>`; auto-prunes expired tokens that have no refresh_token |
| `sw-reload` | `reloadAfterServiceWorkerUpdate` (lifted from notes#148) |
| `vault-id` | `vaultIdFromUrl` + `normalizeVaultUrl` (notes#149 URL-drift fix) |

Notes-canonical implementation extracted with the following deltas:
- All paths handle the no-`window` / SSR case (token-storage falls back
  to a `NULL_STORAGE` shim; sessionStorage in `ParachuteOAuth` likewise).
- Cursor pagination (`queryNotesCursor`) reads `X-Next-Cursor` and
  preserves the cursor through the auth-retry path.
- `ParachuteOAuth.beginFlow` accepts a `vaultName` opt that adds the
  `vault=<name>` hint to `/oauth/authorize` for the multi-vault
  narrow-on-pick pattern Notes uses today.

### `@openparachute/app` 0.2.0-rc.1 — meta.json `required_schema`

Per patterns#57 ("Surfaces declare required vault schema"), `meta.json`
gains an optional `required_schema` field:

```json
{
  "required_schema": {
    "tags": [
      {
        "name": "capture",
        "description": "Quick captures",
        "fields": {
          "source": { "type": "string", "required": true },
          "createdAt": { "type": "date" }
        }
      }
    ]
  }
}
```

Phase 2.0 scope: **validate + surface in admin SPA**. Phase 2.1+ will
auto-provision missing tag-identity rows in vault via
`VaultClient.updateTag` at install time; that's tracked separately.

The admin SPA's modules table grows a per-row "Schema requirements"
expandable summary; the per-UI info page renders the full declaration.

### Verified

| Suite | Before | After |
|---|---|---|
| `bun test packages/app-host/src/` | 270 / 0 | 281 / 0 |
| `bun test packages/app-client/src/` | n/a | 80 / 0 |
| `cd web/admin && bun run test` | 31 / 0 | 40 / 0 |

Typecheck clean (`tsc --noEmit` across all three). Build clean
(`bun run build` from root builds app-client then app-host).

---

## [0.1.0-rc.4] - 2026-05-22

feat(app): Phase 1.3 — dev mode with SSE live-reload (closes Phase 1).

Phase 1.3 closes Phase 1 of parachute-app and resolves the recurring
"edit code, build, browser shows old" frustration tracked in
[parachute-notes#151](https://github.com/ParachuteComputer/parachute-notes/issues/151)
at the platform level. Adds operator-triggered dev mode: `parachute-app
dev <name>` flips a UI into a no-cache mode + injects an EventSource
shim into `index.html` that reloads the tab when the operator runs
`parachute-app dev <name> --trigger` after a rebuild. Reference:
[design doc section 18](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md#18-caching--reload-strategy).

### Added

- `src/dev-mode.ts` — process-local, in-memory dev-mode state. One Map
  for `name → { enabled, enabledAt, watchDir?, buildCmd? }`, one Map
  for `name → Set<DevReloadSubscriber>`. Exports `enableDevMode`,
  `disableDevMode`, `isDevMode`, `listDevMode`, `getDevMode`,
  `addSubscriber`, `removeSubscriber`, `broadcastReload`,
  `subscriberCount`, `closeAllSubscribers`, `resetDevMode`. Idempotent
  enable preserves `enabledAt`; disable closes every connected SSE
  stream so the next request resumes production cache headers cleanly.
- `src/dev-injection.ts` — HTML script-injection (string scan, no
  cheerio dep). Inserts `<script id="parachute-app-dev-reload">` just
  before `</head>`, with fallbacks (`before-script` → `after-body` →
  `append`) for unusual document structures. Idempotent via the marker
  id — re-rendering the same document doesn't duplicate the tag. The
  script body opens an EventSource against `/app/<name>/_dev/reload`
  and `window.location.reload()`s on `reload` events (200ms debounce).
- `src/dev-routes.ts` — Phase 1.3 HTTP endpoints:
  - `GET /app/<name>/_dev/reload` (UNAUTHENTICATED) — SSE stream;
    404 when the UI isn't in dev mode. Emits a `: connected` keepalive
    on accept; broadcasts `event: reload\ndata: {"timestamp": ...}` on
    trigger. Disconnects clean up via the stream's `cancel` hook.
  - `POST /app/<name>/dev/enable` (`app:admin`) — flip on. Honors
    `config.dev_mode_allowed: false` with 409.
  - `POST /app/<name>/dev/disable` (`app:admin`) — flip off + close
    every subscriber.
  - `POST /app/<name>/dev/trigger` (`app:admin`) — broadcast `reload`;
    409 when dev mode is off. Returns `{ notified: <count> }`.
  - `GET /app/<name>/dev` (`app:read`) — per-UI status.
  - `GET /app/dev/list` (`app:read`) — UIs currently in dev mode.
- `src/cache-headers.ts` — `cacheHeadersFor` takes a `devMode` boolean.
  When true, every response is `no-cache, no-store, must-revalidate` —
  overrides immutable on hashed assets AND `no-cache` on the PWA SW.
- `src/http-server.ts` — wires dev-routes ahead of admin routes; per-
  request `isDevMode(meta.name)` check feeds both the cache headers
  and the index.html injection. `serveFileWithHeaders` accepts a
  `devMode` parameter; when true + filename is `index.html`, it parses
  the body via `injectDevReloadScript` before responding. HEAD reports
  the injected byte length.
- `src/index.ts` — re-exports the dev-mode + dev-injection surface,
  exposes `routeDev` + `DevRoutesOpts`, replaces the Phase 1.3 stub
  `setDevMode` with a real wrapper.
- `bin/parachute-app.ts` — replaces the Phase 1.3 stub with four
  sub-verbs:
  - `parachute-app dev <name>` — enable (idempotent)
  - `parachute-app dev <name> --off` — disable
  - `parachute-app dev <name> --trigger` — broadcast reload
  - `parachute-app dev list` — show UIs currently in dev mode
  Help text reflects the full Phase 1.3 verb set.
- `web/admin/src/lib/api.ts` — typed helpers: `enableDevMode`,
  `disableDevMode`, `triggerReload`, `getDevModeStatus`, `listDevMode`.
- `web/admin/src/routes/Modules.tsx` — per-row "Dev" badge + "Enable
  dev" / "Disable dev" / "Trigger reload" buttons. Refreshes the
  dev-status map alongside the UI list.
- Tests:
  - `src/__tests__/dev-mode.test.ts` (15 tests) — state, subscribers,
    broadcast reaping.
  - `src/__tests__/dev-injection.test.ts` (10 tests) — happy path +
    idempotence + all three fallback branches + escape defense.
  - `src/__tests__/dev-routes.test.ts` (14 tests) — every endpoint +
    auth gates + SSE subscribe / broadcast / cancel.
  - `src/__tests__/dev-integration.test.ts` (10 tests) — full
    end-to-end via Bun.serve including script injection, no-cache
    override, SSE broadcast, dev-list, HEAD content-length.
  - `src/__tests__/cache-headers.test.ts` — extra coverage for the
    `devMode` parameter.
  - `src/__tests__/cli.test.ts` — refreshed for the new `dev` verbs.
  - `web/admin/src/routes/Modules.test.tsx` — updated to mock the
    `/app/dev/list` companion fetch + assert the new dev controls.

### Changed

- Bumped to `0.1.0-rc.4`. `.parachute/info` capabilities now include
  `dev-mode-sse`.
- HTTP server routing: dev-routes dispatcher fires ahead of admin-routes
  so the per-UI `_dev/reload` path doesn't race with the admin matcher.
- `cacheHeadersFor` signature gains a third `devMode = false` parameter
  (backwards-compatible — existing meta-less callers continue to work).
- Admin SPA's Modules table grew a "Dev" column; existing layout
  preserved.

### Verified

- `bun test src/` → 270 pass / 0 fail (was 213).
- `cd web/admin && bun run test` → 31 pass / 0 fail (was 21).
- `bun run typecheck` → clean (root + web/admin).
- `bunx biome check .` → clean.
- `bun run build` → `dist/admin/` populated.
- `bin/parachute-app.ts --version` → 0.1.0-rc.4.
- `bin/parachute-app.ts --help` → shows the four `dev` sub-verbs.

## [0.1.0-rc.3] - 2026-05-21

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
