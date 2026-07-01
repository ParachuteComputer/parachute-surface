# Changelog

This file tracks the workspace's two npm-publishable packages
side-by-side:

- `@openparachute/app` (host module, lives in `packages/app-host/`)
- `@openparachute/app-client` (shared client library, lives in `packages/app-client/`)

The admin SPA at `web/admin/` ships inside the host package as
`dist/admin/`; its version mirrors the host's version.

## [surface 0.3.7] - 2026-06-30

feat(surface-host): **Surface Git Transport Phase 1 — `#surface` discovery
(vault declares).** surface-host now discovers surfaces from the vault and
registers them with the hub, realizing "the vault declares; the hub
authenticates; surface-host serves."

- **New:** `src/surface-discovery.ts` — on boot, query the vault for
  `tag:surface` (with a custodied read credential), parse each `#surface` note
  into a `{ name, mount, mode, source.ref, scopes }` declaration, and register
  each with the hub over `POST /admin/surfaces` (operator-authed) so its bare
  repo is provisioned + the `/git/<name>` transport gates provisioning on it.
  A surface thus exists — ready to receive a `git push` — the moment its note
  does, before the first push. Best-effort, fire-and-forget: a missing read
  credential / operator token / unreachable vault / malformed note logs + skips,
  never blocks startup (mirrors the credential-renewal + redirect-self-heal boot
  sweeps). Boot-only in Phase 1; periodic re-scan / live-query is Phase 1b.
- **`#surface` note convention:** a note tagged `#surface` with metadata
  `{ mount, mode: dev|prod, source: { ref }, scopes: [...] }`; content is its
  identity (mirrors `#agent/thread`). The servable name derives from
  `metadata.name` → the `/surface/<name>` suffix of `mount` → the note's last
  path segment (first that matches the servable `NAME_PATTERN`). Git is the only
  transport; a GitHub mirror is a separate optional remote (design Decisions-locked #1).
- **`surface:write` declared** in `.parachute/module.json` `scopes.defines`
  (joining `surface:read` / `surface:admin`) — the push authority for the git
  transport.

### Changed

- **Build sandbox nits.** Dropped the cargo-culted `GIT_SSH_COMMAND` from
  `SANDBOX_ENV_ALLOWLIST` (the surface clone is HTTPS, never git-over-SSH);
  tightened the npm egress floor from `["registry.npmjs.org", "*.npmjs.org"]` to
  just `["registry.npmjs.org"]` (verified a real `bun install` still resolves
  metadata + tarballs from the single host under the kernel sandbox); and now
  `logger.warn` before swallowing an egress-proxy-startup probe fault (a silent
  swallow made a later "npm unreachable" failure baffling to diagnose).

Stable patch (per the surface-ships-stable convention — `@rc` tag is dead and
rc-first triggers the workspace caret-miss). `0.3.6` → `0.3.7`.

## [surface 0.3.6] - 2026-06-30

feat(surface-host): **Surface Git Transport Phase 0c — kernel build
confinement.** The git-pushed-source build now runs inside a KERNEL sandbox
(Seatbelt on macOS, bubblewrap on Linux) via `@anthropic-ai/sandbox-runtime`
(the same engine the agent uses), replacing Phase 0b's constrained subprocess
(Option A) as the DEFAULT `BuildRunner`. This is the hard gate before non-operator
writers (Phase 2): it closes the Option-A residual where a malicious-but-authorized
build could read absolute-path secrets (the vault read credential under
`~/.parachute/**`, the operator token, other surfaces' source) or write outside
its throwaway build dir (clobbering a sibling served bundle).

- **New:** `src/build-sandbox.ts` — `makeKernelSandboxRunner` / `defaultBuildRunner`.
  Reuses the agent's hard-won integration: the home-tree deny + scoped re-allow read
  model, the Linux `apply-seccomp` ENOENT re-bind, a bun-binary read-bind, and the
  engine env allowlist.
- **Confinement:** writes confined to the build dir + a throwaway build HOME; reads
  deny the home tree AND the real `$PARACHUTE_HOME`, re-allowing only the build dir +
  toolchain; egress restricted to the npm registry (`registry.npmjs.org`). Every
  Option-A protection (scrubbed env, process-group timeout, bounded output, non-root)
  still holds.
- **Fail-closed:** when the kernel sandbox is unavailable on the host, the build is
  REFUSED (never run unsandboxed) unless the operator explicitly sets
  `PARACHUTE_SURFACE_BUILD_ALLOW_UNSANDBOXED=1`, which degrades to Option A with a
  loud warning (only for a trusted, operator-only box).
- The `BuildRunner` seam is preserved — Option A (`constrainedSubprocessRunner`)
  remains the injectable fallback.
- Exact-pins `@anthropic-ai/sandbox-runtime@0.0.54` (matching the agent).

## [surface 0.3.3-rc.1] - 2026-06-30

fix(surface-host): `parachute-surface add`/`list`/etc. now authenticate to a
deployed daemon. The CLI presented the on-disk operator token
(`aud: "operator"`) directly to the daemon's admin endpoints, which require a
hub-issued `aud: "surface"` token — so every admin verb 401'd with
`hub JWT audience mismatch: expected "surface", got "operator"`.

### The fix

The CLI now exchanges the operator credential for a short-lived `surface:admin`
token at the hub's `POST /api/auth/mint-token` (new `src/cli-token.ts`), then
presents that. This follows the ecosystem capability-attenuation model — the
same path the admin SPA uses (session → mint → present): the operator token
holds `parachute:host:auth`, which may mint any requestable scope, and
`surface:admin` is requestable; `inferAudience` stamps the mint `aud:
"surface"`. The daemon's admin auth is unchanged — no widened audience, no
weakening: a caller with no operator token, or one lacking minting authority,
still can't reach the admin API.

When no operator token is present the CLI sends the request unauthenticated (the
daemon answers 401, as before). A mint *failure* (expired token, hub
unreachable, insufficient authority) prints an actionable message and exits
non-zero.

### Build — intra-monorepo deps pinned to `workspace:*`

The first cut of this fix (#146) was reverted (#148): bumping
`@openparachute/surface` to a prerelease (`0.3.3-rc.1`) tripped a caret-miss.
Sibling workspaces depended on `@openparachute/surface` (and on the already-rc
`surface-client`/`surface-server`) via caret ranges like `^0.3.1`, and a caret
range excludes prereleases — so the workspace silently resolved those siblings
from npm instead of the local source, producing two divergent copies and a
`SurfaceHostContext` type mismatch in `typecheck`.

Root-cause fix: every intra-monorepo dependency on a sibling workspace package
now uses `workspace:*` (matching `notes-ui`'s existing pin), so a prerelease
bump can never caret-miss again; bun substitutes the real version at
pack/publish time. External `@openparachute/*` packages (e.g. `scope-guard`,
published from another repo) keep their caret ranges. The lockfile is synced in
the same change.

Note: the npm `rc` dist-tag was stale at `0.2.2-rc.1` (behind `@latest` 0.3.2);
this rc resumes the chain at `0.3.3-rc.1`.

## [app 0.2.0-rc.13] - 2026-05-25

### Changed

- **app-admin SPA reskinned to the canonical Parachute design system (workstream B of the UX audit; app#35).** Replaces the bespoke `#1e6bb8` blue palette with the canonical sage `--accent: #4a7c59`, warm cream body bg, browser-default body type (was `15px`), 6px button radii (was `3px`), sentence-case muted table headers (was uppercase), the canonical inlined SVG brand mark + "Parachute" Instrument Serif wordmark + `app` chip (was `parachute-app · admin` lowercase-hyphenated), and dark-mode tokens. `Remove` → `Uninstall` per the canonical verb vocabulary. Status-badge primitive declared for future use. Back-compat aliases preserved on `.brand-tag` / `.btn-primary` / banner classes so nothing else breaks. The audit had this as "the single largest visual outlier in the ecosystem"; this rc closes the gap.
- **Migration checklist for the design-system propagation merged at parachute-patterns#95** (workstream A→J propagation tracking).

## [app 0.2.0-rc.7] - 2026-05-23

fix(app): SPA-fallback only for navigation requests — file-extension
asset misses (`.js`, `.css`, `.webmanifest`, etc.) now correctly return
404 instead of serving the SPA shell.

### The bug

`serveUiAsset` fell back to `dist/index.html` on every miss, including
requests for assets. The browser then tried to parse the HTML shell as
JS / a PWA manifest / etc., producing confusing errors that masked the
real cause (a missing or misnamed asset):

```
manifest.webmanifest: Manifest: Line: 1, column: 1, Syntax error.
<chunk>.js: Failed to load module script: Expected JavaScript-or-Wasm
  module, got "text/html"
```

Operators on notes-ui installs hit this when the PWA manifest was
missing or a code-split chunk failed to resolve.

### Fix

A file-extension heuristic now classifies each miss as either an asset
request (known static extensions: `.js`, `.mjs`, `.cjs`, `.css`,
`.json`, `.webmanifest`, `.map`, image / font / media types, `.wasm`,
`.txt`) or a navigation request (no extension, or `.html`). Asset
misses → 404 with body `"Not Found"`. Navigation misses → SPA shell
with no-cache headers, unchanged. The check fires at every SPA-fallback
point in `serveUiAsset` (the deletion-race fallback, the traversal-guard
fallback, and the primary miss branch) for defense in depth — a
traversal attempt with an asset-shaped suffix (`../etc/passwd.txt`) is
now 404'd instead of returning HTML.

The file-existence-→-serve happy path is unchanged; only the miss
branch is affected.

### Verified

| Suite | Before | After |
|---|---|---|
| `bun test packages/app-host/src/` | 359 / 0 | 367 / 0 |

Typecheck clean. The added tests cover: missing `.js` → 404, missing
`.webmanifest` → 404, missing `.css` → 404, missing route with no
extension → SPA shell, missing `.html` route → SPA shell, bare-segment
route → SPA shell, present `.js` asset still served (regression
guard), and the existing traversal test split into asset-shaped (now
404) vs no-extension (still SPA fallback).

## [app 0.2.0-rc.6] - 2026-05-22

fix(app): restore `kind: "frontend"` in module.json (hub validator
requires it; the kind-removal awaits [hub#301](https://github.com/ParachuteComputer/parachute-hub/issues/301)
Phase A).

`.parachute/module.json` shipped at 0.2.0-rc.5 without a `kind` field
per the "kind doesn't matter" decision, but hub's manifest validator
in `parachute-hub/src/module-manifest.ts` still requires the field
(`"kind" must be "api" | "frontend" | "tool"`). `parachute start app`
rejects the install at boot — bootstrap never runs, `/app/notes` 404s.

Until hub#301 Phase A lands (relaxes `kind` to optional, defaults
missing to `"api"`), every app release must carry an explicit `kind`.
App serves UI bundles so `"frontend"` is the accurate value of the
three the validator permits.

## [app 0.2.0-rc.4] - 2026-05-22

fix(app): resolve workspace deps in published manifest (`workspace:*`
→ `^0.1.0-rc.3`). Bumps `@openparachute/scope-guard` floor to
`^0.4.0-rc.1` to pick up hub#322 jti hardening at scope-guard's
matching rc.

### Root cause

The published tarball for `@openparachute/app@0.2.0-rc.3` carried
`"@openparachute/app-client": "workspace:*"` in its manifest. npm
does NOT rewrite `workspace:*` at publish time (Bun does, but the
publish path we use can't depend on Bun being the publisher).
Anyone installing `@openparachute/app@0.2.0-rc.3` from npm gets:

```
error: @openparachute/app-client@workspace:* failed to resolve
```

### Fix

`packages/app-host/package.json` now pins
`"@openparachute/app-client": "^0.1.0-rc.3"` as a concrete semver.
Local-dev workspace resolution still finds the sibling package
(Bun resolves `^0.1.0-rc.3` against the workspace before falling
back to the registry), so the dev loop is unchanged. The published
tarball now declares a real, resolvable npm dependency.

Same applies to scope-guard — bumped from `^0.3.0` to `^0.4.0-rc.1`
so app is hardened against the jti-replay vector hub#322 closed.

### Verified

- `npm pack --dry-run` from `packages/app-host/` — manifest
  dependencies block contains only concrete semver, no
  `workspace:` / `link:` strings.
- `bun install` from repo root — succeeds, lockfile updates.
- `bun run typecheck:all` — clean.
- `bun test` — all suites pass (no behavior change).

### RELEASING.md

The repo's `RELEASING.md` grows a new "Workspace dependencies"
section explaining the gotcha + the rule (concrete semver in any
package.json that gets published; never `workspace:*` or `link:`)
so this doesn't recur.

## [app-client 0.1.0-rc.3] - 2026-05-22

feat(app-client): lift `VaultClient.request` /
`requestWithRetry` / `requestCursorWithRetry` from `private` to
`protected` for subclass-based extension (closes
[app#9](https://github.com/ParachuteComputer/parachute-app/issues/9)).

Backwards-compatible visibility relaxation. New consumers (Notes is
the canonical downstream) can now subclass `VaultClient` to add
domain-specific endpoints without re-implementing the auth/refresh/
error-classification loop. Zero behavior change — test counts
unchanged. See `packages/app-client/CHANGELOG.md` for details.

## [app 0.2.0-rc.3] + [app-client 0.1.0-rc.2] - 2026-05-22

feat(app): Phase 3.0 — file watcher + auto-rebuild for dev mode
(closes the operator UX loop Phase 1.3 left half-open).

Phase 1.3 (`0.2.0-rc.1`) shipped dev mode with the manual `parachute-app
dev <name> --trigger` to broadcast reload. The operator still had to
hand-fire the trigger (or rebuild a watched `dist/`) after every edit.
Phase 3.0 wires a per-UI file watcher so any edit under the UI's
source tree (a) optionally re-runs an operator-declared `dev_build_cmd`
to produce a fresh bundle, then (b) broadcasts a `reload` event to
every connected SSE subscriber — no manual `--trigger` needed.

Reference: [design doc Section 18](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md#18-caching--reload-strategy).

### meta.json — three new optional fields — `@openparachute/app` 0.2.0-rc.3

```json
{
  "dev_watch_dir": "../src",
  "dev_build_cmd": "bun run build",
  "dev_debounce_ms": 250
}
```

- `dev_watch_dir` — path (relative to the UI's root dir) the watcher
  monitors recursively. Default: the UI's root dir; the watcher filter
  drops events inside `dist/`, `node_modules/`, and `.git/` so the
  build-output loop doesn't reload-thrash.
- `dev_build_cmd` — shell command run on each debounced batch via
  `Bun.spawn(["sh", "-c", cmd], { cwd: uiRootDir })`. Absent → the
  watcher broadcasts a reload directly (operator builds manually).
- `dev_debounce_ms` — debounce window for batched file events. Default
  250ms; floor 50ms. Build tools that touch many files in quick
  succession (esbuild, Vite, tsc --watch) produce one reload per
  quiet-window, not one per file.

The schema validator rejects empty strings, non-integer debounce, and
debounce values below the 50ms floor.

### `src/dev-watcher.ts` — new module — `@openparachute/app` 0.2.0-rc.3

`startWatcher({ name, uiRootDir, watchDir?, buildCmd?, debounceMs?,
spawnFn?, logger? })` arms a per-UI recursive file watcher using
`node:fs.watch(..., { recursive: true })` (works out-of-the-box on
macOS via FSEvents + Linux via inotify). The watcher:

- **Debounces** file events into one reload per quiet window.
- **Single-flights** the build per UI: if a build is already running
  when the next batch lands, marks `rerunPending` and re-runs once the
  current build finishes — never two builds in parallel for the same
  UI (that race is a reliable way to corrupt `dist/`).
- **Aborts hanging builds at 60s** via an `AbortController` wired into
  the spawn signal hook.
- **Falls through gracefully** on build failure: logs stdout/stderr
  (truncated to 4KB), does NOT broadcast reload, leaves the watch
  armed so the next edit retries.
- **Filters** events from `dist/`, `node_modules/`, and `.git/`, plus
  common editor turds (`.#foo`, `foo~`), to keep the watcher quiet on
  the build's own output.

`stopWatcher(name)` cancels pending timers, aborts in-flight builds,
and closes the FSWatcher — idempotent. `stopAllWatchers()` is the
shutdown reaper wired into `serve().stop()` so a daemon SIGINT cleans
up FSEvents subscriptions.

### dev-routes wiring — `@openparachute/app` 0.2.0-rc.3

`POST /app/<name>/dev/enable` now arms the watcher with the UI's
`uiDir` + meta `dev_watch_dir` / `dev_build_cmd` / `dev_debounce_ms`,
and the response carries a `watcher` field surfacing the resolved
absolute watch dir, debounce, and build cmd (or a `warning` when the
watcher couldn't start — e.g. a missing `dev_watch_dir`). The
operator-facing flow becomes:

```
1. parachute-app dev gitcoin-brain
2. Edit ~/Gitcoin/gitcoin-brain-ui/src/something.tsx
3. apps detects change, runs `bun run build`, broadcasts reload
4. Browser tab refreshes automatically
```

`POST /app/<name>/dev/disable` tears down the watcher. The manual
`--trigger` still works as a fallback when an operator wants to
re-fire a reload without an actual file change.

The status / list endpoints (`GET /app/<name>/dev`, `GET
/app/dev/list`) now report watcher state per UI: `watching`,
`watchDir`, `debounceMs`, `buildCmd`, `building`. Admin SPA renders
"watching …/<dir>" sub-text on the Dev ON badge.

### CLI — `parachute-app` 0.2.0-rc.3

`parachute-app dev <name>` now prints the watcher state in the
post-enable summary — operator sees the resolved watch dir, debounce,
and (when configured) the build command on the same line they enabled
dev mode. `parachute-app dev list` adds a second line per UI showing
the watch dir + build command.

### Tests — 30 new

- `dev-watcher.test.ts` — 17 new tests covering: idempotent restart;
  debounce floor; default + custom watch dirs; rapid changes batched
  to one broadcast; dist/ + node_modules/ filtering; build success →
  reload; build failure → no reload; single-flight + rerun-pending;
  stopWatcher cancels pending timers; `watcherStatus` snapshot shape;
  integration with `broadcastReload`.
- `dev-routes.test.ts` — 5 new tests covering enable wiring,
  warning surfacing, disable teardown, status + list watcher reporting.
- `meta-schema.test.ts` — 8 new tests for the three new fields +
  schema-JSON surface.

Test counts: 355 host tests (was 325), 90 client tests unchanged.

## [app 0.2.0-rc.2] + [app-client 0.1.0-rc.2] - 2026-05-22

feat(app): Phase 2.1 — bootstrap default Notes UI on first boot +
auto-provision `required_schema` declarations on `add` (folds
[patterns#57](https://github.com/ParachuteComputer/parachute-patterns/issues/57)
Phase 2 + Notes migration Phase 1 — design doc Section 16).

This release completes the "friend-deploy" story: a fresh
`parachute-app serve` on a new install gets Notes for free, and apps
that declare `required_schema` get their vault tags seeded on install
without operator hand-holding.

### Bootstrap default Notes UI on first boot — `@openparachute/app` 0.2.0-rc.2

When `serve()` starts up with an empty `~/.parachute/app/uis/`, apps
now auto-installs each entry in `config.bootstrap_default_apps.apps`
via the same npm-fetch pipeline `parachute-app add` uses.

Default config: `{enabled: true, apps: ["@openparachute/notes-ui"]}`.
Operators who want a different default flip `enabled: false` or set
`apps: []`. Per design doc Section 16, Notes is the canonical first
app installed under parachute-app.

Skip conditions (any one triggers an early return):
- `config.bootstrap_default_apps.enabled === false`
- `config.bootstrap_default_apps.apps === []`
- `uis/` exists AND contains at least one non-dotfile entry (operator
  was here; bootstrap doesn't trample existing installs)

Failure modes are best-effort: if `bun add` 404s, the network is down,
or the package isn't published yet, the daemon logs a warning + the
operator can retry via `parachute-app add @openparachute/notes-ui`
once the underlying issue is fixed.

Surfaces shipped:
- `src/bootstrap.ts` — `maybeBootstrapDefaultApps()` orchestrator
- `src/index.ts` — `serve()` wires bootstrap after the initial scan;
  `ServeHandle.bootstrap` exposes the promise for tests
- `serve()` opts: `skipBootstrap: true` for CI/tests
- `src/admin-routes.ts` — `addUiInternal()` extracted from the HTTP
  handler so bootstrap can reuse the staging/meta-merge/DCR pipeline

### Auto-provision `required_schema` on `add` + manual endpoint — `@openparachute/app` 0.2.0-rc.2

When `POST /app/add` succeeds AND the UI's meta declares
`required_schema.tags` AND `config.auto_provision_required_schema`
(default `true`), app now calls `VaultClient.updateTag` against each
declared tag so vault has the schema row the app expects.

Also adds a manual re-trigger:
- `POST /app/<name>/provision-schema` (scope: `app:admin`)
- CLI: `parachute-app provision-schema <name>`
- Admin SPA: "Provision schema" button on the per-UI detail page

The provisioner is idempotent (vault's `PUT /api/tags/:name` upserts;
omitted keys preserve), best-effort (per-tag errors log + record but
never unwind the install), and surfaces a structured per-tag summary
in the response (`provisioned`, `errors`, `skipReason`, `vaultUrl`).

Which vault?
- `meta.vault_default` set → provision against `<hub_url>/vault/<name>`
- Unset → skip with reason (vault-agnostic apps don't know which
  vault to seed; the operator runs `provision-schema` against each
  manually).

Bug-fix folded in: the on-disk meta.json projection in the `add`
write step now preserves `required_schema`. Phase 2.0 added the meta
field but the write step dropped it; a `reload` would have lost the
declaration. Caught while wiring Phase 2.1 integration tests.

Surfaces shipped:
- `src/provision-schema.ts` — `provisionSchemaForUi()` helper
- `src/admin-routes.ts` — `POST /app/<name>/provision-schema` handler
  + post-add auto-trigger hook in `addUiInternal()`
- `bin/parachute-app.ts` — `provision-schema <name>` verb
- `web/admin/src/lib/api.ts` — `provisionSchema(name)` helper
- `web/admin/src/routes/UiInfo.tsx` — "Provision schema" button +
  inline result rendering

### Config schema additions — `@openparachute/app` 0.2.0-rc.2

`.parachute/config/schema` grows two new fields:

- `bootstrap_default_apps: {enabled: bool, apps: string[]}` — default
  `{enabled: true, apps: ["@openparachute/notes-ui"]}`
- `auto_provision_required_schema: bool` — default `true`

Both have explicit per-field validation + clone-on-load (nested
defaults are mutation-safe).

### `@openparachute/app-client` 0.1.0-rc.2 — `VaultClient.updateTag` + `getTag`

Two new methods on `VaultClient`:

- `updateTag(name, payload)` — `PUT /api/tags/:name` upsert. Vault's
  contract: omitted keys preserve prior values, explicit `null`
  clears, `fields` is merge-on-write. Idempotent.
- `getTag(name)` — single tag-identity read; returns `null` on 404
  so provisioning callers can branch "missing → create" without
  try/catch noise.

Also adds the `TagUpsertPayload`, `TagRecord`, `TagFieldSchema` types
mirroring vault's wire format (see `parachute-vault/src/config.ts`).

### Verified

| Suite | Before (0.2.0-rc.1) | After (0.2.0-rc.2) |
|---|---|---|
| `bun test packages/app-host/src/` | 281 / 0 | 314 / 0 |
| `bun test packages/app-client/src/` | 81 / 0 | 90 / 0 |
| `cd web/admin && bun run test` | 40 / 0 | 43 / 0 |

Typecheck clean. Build clean. Biome clean.

### Dependencies

This release depends on `@openparachute/notes-ui` being publishable
on npm for the bootstrap default to actually pull a real package
(today the published name doesn't yet exist; bootstrap will warn +
continue until it does, which is the intended best-effort behavior).
The Notes migration arc (design doc Section 16, Phase 1) lands
`@openparachute/notes-ui` as the publish target; once that ships,
`parachute-app serve` from scratch ends with Notes mounted at
`/app/notes/` on first boot.

---

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
