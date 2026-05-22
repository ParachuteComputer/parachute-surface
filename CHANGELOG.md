# Changelog

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
