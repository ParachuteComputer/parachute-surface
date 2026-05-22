# @openparachute/app

Host module for custom Parachute UIs — drop a built bundle in and serve it under one origin.

**Status: Phase 1.0 scaffolding — not yet functional.** The module-protocol skeleton, stub bin, and library surface ship; no UI hosting, no admin endpoints, no OAuth DCR yet. Those land in Phase 1.1+.

## Design

The full design is in [`parachute.computer/design/2026-05-21-parachute-apps-design.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md). The shape, in one paragraph:

App is a small Bun HTTP service that supervises a directory of pre-built static UI bundles. Each bundle is a self-contained SPA living under `~/.parachute/app/uis/<name>/`, with a `dist/` (the bundle) and a `meta.json` (mount path, OAuth scopes, display props). App mounts each declared UI at its declared subpath under `/app/`, serves the bundle with SPA-routing fallback, and auto-registers each as an OAuth client of the hub on add. The unit (a UI bundle) stays explicitly separate from the host module.

## Phasing

- **Phase 1.0** (rc.1 — **this release**): module-protocol skeleton, stub bin, library surface. Nothing functional yet.
- **Phase 1.1**: real `serve` daemon, UI directory scanning, mount + SPA-fallback serving, `/app/healthz`.
- **Phase 1.2**: `add` / `remove` / `list` / `reload` CLI verbs, OAuth DCR registration against hub, `.parachute/config[/schema]` admin endpoints.
- **Phase 1.3**: `dev` mode with live reload for UI authors.
- **Phase 2+**: Notes migration to first canonical app, PWA mode (service worker), per-UI metadata polish. See design doc.

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
