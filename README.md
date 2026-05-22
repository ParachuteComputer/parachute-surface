# @openparachute/app

Host module for custom Parachute UIs — drop a built bundle in and serve it under one origin.

**Status: Phase 1.1 — core UI hosting is live.** App scans `~/.parachute/app/uis/` for declared UIs, validates each `meta.json`, mounts each bundle at its declared path under `/app/`, and serves with smart cache headers + SPA-routing fallback. Admin endpoints + OAuth DCR land in Phase 1.2; dev mode in Phase 1.3.

## Design

The full design is in [`parachute.computer/design/2026-05-21-parachute-apps-design.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md). The shape, in one paragraph:

App is a small Bun HTTP service that supervises a directory of pre-built static UI bundles. Each bundle is a self-contained SPA living under `~/.parachute/app/uis/<name>/`, with a `dist/` (the bundle) and a `meta.json` (mount path, OAuth scopes, display props). App mounts each declared UI at its declared subpath under `/app/`, serves the bundle with SPA-routing fallback, and auto-registers each as an OAuth client of the hub on add. The unit (a UI bundle) stays explicitly separate from the host module.

## Phasing

- **Phase 1.0** (rc.1): module-protocol skeleton, stub bin, library surface.
- **Phase 1.1** (rc.2 — **this release**): real `serve` daemon, UI directory scanning, mount + SPA-fallback serving, smart cache headers, PWA opt-in, `/app/healthz`, self-registration.
- **Phase 1.2**: `add` / `remove` / `list` / `reload` CLI verbs, OAuth DCR registration against hub, `POST /app/add` + admin SPA at `/app/admin/`.
- **Phase 1.3**: `dev` mode with live reload for UI authors.
- **Phase 2+**: Notes migration to first canonical app, file-watcher discovery, npm-fetch shorthand, build-from-git. See design doc.

## CLI (planned)

```bash
parachute-app serve                                # daemon
parachute-app add <source> --name <name> --path /app/<name>
parachute-app remove <name>
parachute-app list
parachute-app reload <name>
parachute-app dev <name> [--off]
parachute-app --help
parachute-app --version
```

## Naming / canonical values

- **Bin:** `parachute-app`
- **npm:** `@openparachute/app`
- **Port:** `1946` (next slot in the canonical 1939–1949 Parachute range)
- **Mount paths:** `/app` (admin + per-UI mounts), `/.parachute` (module-protocol endpoints)

## License

AGPL-3.0.
