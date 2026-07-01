# @openparachute/surface

**Surface is the UI host module for [Parachute](https://parachute.computer).** It serves bundled reference surfaces over a vault and hosts your own custom surfaces — each as a self-contained static SPA, all under one origin, all wired to the hub's identity.

**[Notes](./packages/notes-ui) is bundled and auto-installed today.** Calendar, tasks, and other reference surfaces land alongside it as the set grows. Bring your own surface too: drop a built bundle in (or point at an npm package), and Surface mounts it, registers it as an OAuth client of the hub, and serves it.

> A *surface* is any UI that talks to a vault — a daily-capture inbox, a project dashboard, a graph explorer. Surface is the host that runs them. To build one, reach for [`@openparachute/surface-client`](./packages/surface-client) (browser auth + typed vault client) and [`@openparachute/surface-render`](./packages/surface-render) (note rendering); you don't hand-roll OAuth or the vault REST layer.

Surface aligns with its sibling modules (naming, brand, ports, OAuth scopes, the module protocol) per [**parachute-patterns**](https://github.com/ParachuteComputer/parachute-patterns) — the single source of truth for ecosystem conventions and the new-module adoption checklist.

## Quick start

Surface is a Parachute module — install and run it through the [hub](https://github.com/ParachuteComputer/parachute-hub) (the `parachute` CLI / portal). The hub fronts every module on one origin and supervises its process.

```bash
# Once vault + hub are installed (see parachute-vault / parachute-hub):
parachute install surface
parachute start surface
```

That installs `@openparachute/surface`, runs `parachute-surface serve`, and bootstraps **Notes** on first boot. Reach it at:

```
<hub-origin>/surface/admin/      # the admin SPA — install/manage surfaces
<hub-origin>/surface/notes/      # the bundled Notes surface
<hub-origin>/surface/<name>/     # any surface you've added
```

Locally, `<hub-origin>` is the hub on port 1939 (e.g. `http://127.0.0.1:1939/surface/admin/`). The surface daemon itself listens on **1946** behind the hub's reverse proxy.

### Run it directly (development)

```bash
git clone https://github.com/ParachuteComputer/parachute-surface
cd parachute-surface
bun install
bun run build                 # build the admin SPA + bundled surfaces
parachute-surface serve       # daemon on :1946
```

`serve` reads `$PARACHUTE_HOME/surface/config.json` (or built-in defaults), scans `$PARACHUTE_HOME/surface/uis/` for declared surfaces — each subdir needs a `meta.json` + `dist/index.html` — and mounts each at its declared path under `/surface/<name>/`. The admin endpoints and admin SPA at `/surface/admin/` are served by the same daemon.

## How it works

Surface is a small Bun HTTP service that supervises a directory of pre-built static surface bundles. Each bundle is a self-contained SPA living under `~/.parachute/surface/uis/<name>/`, with a `dist/` (the built bundle) and a `meta.json` (mount path, OAuth scopes, display props). Surface mounts each declared surface at its subpath under `/surface/`, serves the bundle with smart cache headers + SPA-routing fallback, and auto-registers each as an OAuth client of the hub when it's added. The unit (a surface bundle) stays explicitly separate from the host module.

```
hub :1939  ──/surface/*──▶  parachute-surface :1946
                              ├── /surface/admin/    admin SPA (install/manage surfaces)
                              ├── /surface/notes/    bundled Notes surface  ──▶ vault
                              └── /surface/<name>/   your surface           ──▶ vault
```

Surfaces reach vault data directly in the browser via hub OAuth (PKCE) — no vault token ever touches the host module for static surfaces. A *backed* surface (one that ships a `server` entry) is mounted in-process and gets a standing tag-scoped vault credential that Surface custodies (0600) and renews; the token never reaches a browser. See [`design/2026-06-10-surface-runtime-primitives.md`](./design/2026-06-10-surface-runtime-primitives.md).

## Declaring a surface in the vault (`#surface`)

A surface can be **declared in the vault and shipped by a `git push`** — the [Surface Git Transport](https://parachute.computer/design/2026-06-30-surface-git-transport/). The vault *declares*, the hub *authenticates + transports*, Surface *builds + serves*:

1. **Declare.** Write a note tagged `#surface` (an agent via MCP, or a human). Its metadata declares the surface; the content is its identity (mirrors an agent's `#agent/thread`):

   ```yaml
   #surface  "Surfaces/gitcoin-brain"
   metadata:
     mount: /surface/gitcoin-brain     # → the served path; also fixes the name
     mode: prod                        # dev | prod
     source:
       ref: main                       # optional pointer, informational
     scopes: [vault:default:read]      # what the surface's backend may read
   ```

   The **name** is the one key the hub registry + git endpoint agree on. It's resolved from `metadata.name` → the `/surface/<name>` suffix of `mount` → the note's last path segment (first that matches the servable pattern `^[a-z][a-z0-9-]*$`).

2. **Discover.** On boot Surface queries the vault for `tag:surface` (with its custodied read credential) and registers each declared surface with the hub (`POST /admin/surfaces`), which provisions a per-surface bare git repo. The surface exists — ready to receive a push — the moment its note does.

3. **Push.** `git push <hub>/git/<name>` (authenticated by a hub-issued `surface:<name>:write` token). The hub notifies Surface, which pulls the source, **builds it in a kernel sandbox**, and serves the result at `/surface/<name>`. Git is the only transport; a GitHub mirror is a separate optional remote.

Discovery is best-effort and boot-time in Phase 1 (a missing credential or unreachable vault just logs + skips). See the [design doc](https://parachute.computer/design/2026-06-30-surface-git-transport/) for the full model.

## CLI

The `parachute-surface` verbs are a thin HTTP client over the running daemon's admin endpoints — `parachute-surface serve` must be running locally, and admin calls authenticate with the on-disk operator token (`~/.parachute/operator.token`, or `PARACHUTE_HUB_TOKEN`).

```bash
parachute-surface serve                          # start the daemon (:1946)
parachute-surface add <source> [flags]           # register a surface
                                                 #   <source>: local path OR npm spec (@scope/pkg[@version])
                                                 #   --name <n> --path /surface/<n> [--display <d>] [--scopes <s1,s2>] [--force]
parachute-surface remove <name>                  # unregister a surface + revoke its OAuth client
parachute-surface list                           # list installed surfaces with status + OAuth state
parachute-surface reload <name>                  # refresh a surface's bundle (no daemon restart)
parachute-surface provision-schema <name>        # re-trigger required_schema auto-provisioning for <name>
parachute-surface dev <name> [--off|--trigger]   # toggle dev mode (no-cache + live reload) for <name>
parachute-surface dev list                       # list surfaces currently in dev mode
parachute-surface --help, -h                     # full usage
parachute-surface --version, -v                  # print version
```

A second instance of one package can run under its own name + mount (instance-per-vault) via `add --instance-name <n> --mount-path /surface/<n>`.

### Environment

```
PARACHUTE_APP_URL     Override the daemon URL (default http://127.0.0.1:1946).
PARACHUTE_HUB_TOKEN   Operator bearer for admin-endpoint auth.
                      Falls back to ~/.parachute/operator.token.
PARACHUTE_HOME        Ecosystem root (default ~/.parachute). State lands at $PARACHUTE_HOME/surface/.

PARACHUTE_SURFACE_BUILD_ALLOW_UNSANDBOXED
                      Escape hatch for git-pushed builds. A pushed surface's source
                      is COMPILED inside a kernel sandbox (Seatbelt/bubblewrap). If
                      that sandbox is unavailable on the host the build is REFUSED
                      (fail-closed). Set to "1" to allow an UNSANDBOXED build instead
                      — only on a trusted, operator-only box (it can read absolute-
                      path files this user can read and reach any host).
```

## State on disk — `~/.parachute/surface/`

```
~/.parachute/surface/
  config.json              # daemon config (or built-in defaults)
  uis/                     # one subdir per installed surface
    notes/
      dist/index.html      # the built bundle
      meta.json            # mount path, OAuth scopes, display props
    <name>/
      dist/
      meta.json
```

`~/.parachute/` is the ecosystem root shared with sibling modules (`vault`, `scribe`, `hub`); everything Surface owns is scoped under `~/.parachute/surface/`. Override the root with `PARACHUTE_HOME`.

## Module identity

| | |
|---|---|
| **npm** | `@openparachute/surface` |
| **Bin** | `parachute-surface` |
| **Short name** | `surface` (`parachute install surface`) |
| **Port** | `1946` (in the canonical 1939–1949 Parachute range) |
| **Mount paths** | `/surface` (admin + per-surface mounts), `/.parachute` (module-protocol endpoints) |
| **Health** | `/surface/healthz` |
| **Admin UI** | `/surface/admin/` |
| **OAuth scopes** | `surface:read`, `surface:admin` |
| **Focus** | `core` (committed-core module) |

The canonical manifest is [`packages/surface-host/.parachute/module.json`](./packages/surface-host/.parachute/module.json).

## Packages

This is a workspace. The host module and the surface-building libraries live side by side:

| Package | Role |
|---|---|
| [`surface-host`](./packages/surface-host) | `@openparachute/surface` — the host module (this README's subject) |
| [`surface-client`](./packages/surface-client) | `@openparachute/surface-client` — browser OAuth + typed vault REST client for building a surface |
| [`surface-render`](./packages/surface-render) | `@openparachute/surface-render` — note rendering components |
| [`surface-server`](./packages/surface-server) | `@openparachute/surface-server` — server kit for backed surfaces |
| [`notes-ui`](./packages/notes-ui) | `@openparachute/notes-ui` — the bundled Notes surface |
| `doc-schema` · `docs-editor` · `pebble-config` | additional reference surfaces / building blocks |

The admin SPA source is in [`web/admin/`](./web/admin) (`@openparachute/surface-admin-ui`), built into `dist/admin/` and served at `/surface/admin/`.

## Building your own surface

A surface is a static SPA — origin-free, hub-fronted. Don't re-implement OAuth, the vault client, token storage, or note rendering: import the packages.

```ts
import { ParachuteOAuth, VaultClient } from "@openparachute/surface-client";
import { NoteRenderer } from "@openparachute/surface-render";
```

Then `parachute-surface add ./dist --name my-surface --path /surface/my-surface` (local) or `parachute-surface add @scope/my-surface` (npm). See [`packages/surface-client/README.md`](./packages/surface-client/README.md) for the auth + data layer and the [surface-runtime design doc](./design/2026-06-10-surface-runtime-primitives.md) for backed surfaces.

## License

AGPL-3.0.
