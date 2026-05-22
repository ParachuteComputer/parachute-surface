# Changelog

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
  `iconUrl`, `scopes_required` (defaults to `["vault:read"]`),
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
