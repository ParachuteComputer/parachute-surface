> Moved from parachute-patterns/patterns/runtime-tenancy-contract.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Runtime tenancy contract

> Hosts that serve tenants (parachute-surface serving hosted UIs, future
> tenancy contexts) inject structured environment metadata into the
> tenant's runtime. Tenants READ from explicit metadata rather than
> guessing from URL patterns or filesystem layout. Same architectural
> shape across every host↔tenant relationship in Parachute. Third side
> of the triad with [`module-surfaces.md`](./module-surfaces.md) (what
> backend modules expose) and
> [`surface-bundle-shape.md`](./surface-bundle-shape.md) (what frontend app
> bundles ship).

## The convention (TL;DR)

The host injects, the tenant reads. For HTML tenants — the current
canonical case, parachute-surface serving SPA bundles — the contract is
meta tags plus a `<base>` element in the served HTML:

```html
<head>
  <base href="/surface/<name>/">                              <!-- browser URL resolution -->
  <meta name="parachute-mount" content="/surface/<name>">     <!-- runtime code reads this -->
  <meta name="parachute-hub" content="https://...">       <!-- hub origin for OAuth discovery -->
  <meta name="parachute-vault" content="/vault/<name>">   <!-- when operator's session is vault-bound -->
  <meta name="parachute-vault-origin" content="https://..."> <!-- cloud / cross-origin vault only -->
</head>
```

There is **no** `parachute-tenant-id` meta tag — the tenant's logical id is
*derived* from the mount path (`getTenantId()` takes the last segment of
`/surface/<name>`), not injected separately. The host injects the mount; the
id falls out of it.

Tenants consume via `@openparachute/surface-client`:

```ts
import {
  getMountBase,   // mount path (React Router basename), trailing slash stripped
  getHubOrigin,   // hub origin for OAuth discovery
  getVaultUrl,    // fully-qualified vault URL (origin + path), ready for fetch()
  getTenantId,    // logical tenant id, derived from the mount path
} from '@openparachute/surface-client';
```

The helpers read the meta tags and return typed values. They **never throw**:
a missing tag returns `null` and the caller chooses the fallback (this is
load-bearing for *standalone* surfaces, which have no host injecting the tags
— see the surface-client README's "Runtime-tenancy contract" section). Note
the exported reader is **`getVaultUrl`** (returns a fully-qualified URL so
`fetch(getVaultUrl())` works directly) — there is no `getVaultPath` export.

## Two-layer rationale

Why both `<base href>` AND meta tags:

- **`<base href>`** is load-bearing for the BROWSER's URL resolution.
  Without it, relative paths (assets, manifest, service-worker scope)
  resolve against the document's perceived directory, which fails for
  SPAs mounted at non-trailing-slash URLs. This is the browser's
  built-in mechanism; the host injects it so the bundle doesn't have
  to know its own mount at build time.
- **Meta tags** are for runtime CODE: React Router `basename`, OAuth
  callback URL construction, vault API base URL, tenant-id-aware
  storage keys. Strings the bundle reads at runtime; browser URL
  resolution doesn't help here.

Both layers serve the same architectural pattern at different
concerns — DOM-level URL resolution vs. JavaScript-level configuration.

## Why the contract exists — the constraint that produced it

Implicit conventions don't generalize. Notes-ui learned this when
shipped under parachute-surface: initially the bundle had `/notes/` baked
in via `VITE_BASE_PATH`, which broke when the operator chose a custom
mount (`parachute-surface add notes-ui --name my-notes` → `/surface/my-notes/`).

The first fix
([notes#159](https://github.com/ParachuteComputer/parachute-notes/pull/159))
was runtime mount detection via regex against `window.location.pathname`
matching the KNOWN Parachute mount patterns (`/surface/<name>` or `/notes`).
That worked for the immediate ship but required the bundle to know
Parachute's mount conventions — fragile, brittle to new conventions,
and demanded a bundle update every time the convention shifted.

Explicit metadata is the canonical answer: the host knows where it
mounted the tenant; let it say so directly. The tenant reads what the
host said, with no shared assumption about path shape.

## Examples and reference implementations

- **parachute-surface → hosted UIs** — primary case.
  [parachute-surface#21](https://github.com/ParachuteComputer/parachute-surface/issues/21)
  implements the producer side (meta-tag + `<base>` injection in the
  HTML response from the app-host HTTP server).
  [parachute-surface#22](https://github.com/ParachuteComputer/parachute-surface/issues/22)
  ships `@openparachute/surface-client` — the consumer-side library with
  typed helpers.
- **parachute-notes / notes-ui** — first canonical consumer.
  [notes#159](https://github.com/ParachuteComputer/parachute-notes/pull/159)
  shipped the interim regex-based runtime detection; the next iteration
  consumes `@openparachute/surface-client` and reads the injected meta tags
  directly. PWA service worker scope mismatch handling is tracked at
  [notes#160](https://github.com/ParachuteComputer/parachute-notes/issues/160).

## Future tenancy contexts (forward-looking)

The same shape recurs across Parachute:

- **Vault → MCP clients** — currently implicit via URL; could be
  explicit via the well-known doc surface.
- **Hub → modules** — already partially explicit via `parachute.json`
  and `module.json` manifest fields.
- **Future cloud platform → user-deployed workloads** — env vars,
  init records, mount paths injected by the platform.

When a new tenancy context emerges, follow this pattern: injection on
the host side, reading on the tenant side, an abstraction library
between them. The metadata mechanism varies (meta tags for HTML, env
vars for processes, init records for isolates); the architectural
shape is the same.

## Anti-patterns

- **Regex on `window.location.pathname`** to detect mount — works for
  known patterns, breaks for arbitrary mounts. Pattern docs explicitly
  DEPRECATE this for new code. The notes-ui regex was an interim
  during the 0.1.1 ship; it phases out as `@openparachute/surface-client`
  lands.
- **Bundling the mount at build time** — couples the bundle to one
  mount, breaks the operator-chooses-mount design. Apps MUST be
  mount-agnostic — see
  [`surface-bundle-shape.md`](./surface-bundle-shape.md)'s Mount-agnosticism
  section.
- **Asking the host via a custom HTTP endpoint** — adds latency, breaks
  offline-first SPAs, requires the tenant to be online to know its own
  mount. The HTML-time injection is the right surface: the tenant has
  what it needs the moment the document parses.

## What this looks like for the operator

A Parachute operator never thinks about this contract. They install an
app via `parachute-surface add @openparachute/notes-ui` (default mount
`/surface/notes/`) or `parachute-surface add @openparachute/notes-ui --name
my-notes` (custom mount `/surface/my-notes/`). The app works at either
mount with the same built bundle because the host injects mount-specific
metadata at HTML-serve time.

The contract is between the host and the tenant code; it's invisible to
the operator and to the human user of the resulting UI.

## Cross-references

- [`module-surfaces.md`](./module-surfaces.md) — backend module
  surfaces. The producer side of the host-as-module equation: every
  host that injects tenant runtime metadata is itself a module
  exposing the canonical surfaces.
- [`surface-bundle-shape.md`](./surface-bundle-shape.md) — what app bundles
  ship + the mount-agnosticism requirement that this contract makes
  possible.
- [`mount-path-convention.md`](./mount-path-convention.md) — sibling
  discussion of single-source mount declarations from the bundle's
  side.
- [`module-protocol.md`](./module-protocol.md) — the runtime contracts
  every backend module implements. Runtime-tenancy-contract is the
  symmetric "what the host gives the tenant."
- [`parachute-surface/packages/app-host/src/http-server.ts`](https://github.com/ParachuteComputer/parachute-surface/blob/main/packages/app-host/src/http-server.ts)
  — where the host implements the injection (per
  [parachute-surface#21](https://github.com/ParachuteComputer/parachute-surface/issues/21)).
- `parachute-surface/packages/surface-client/src/mount.ts` (forthcoming) —
  where the tenant-side helpers live (per
  [parachute-surface#22](https://github.com/ParachuteComputer/parachute-surface/issues/22)).

## History

- **2026-05-23** — Aaron's install loop revealed implicit-convention
  fragility; notes-ui shipped regex-based runtime detection as an
  interim
  ([notes#159](https://github.com/ParachuteComputer/parachute-notes/pull/159)).
- **2026-05-23** — This pattern doc codifies the explicit-injection
  contract.
  [parachute-surface#21](https://github.com/ParachuteComputer/parachute-surface/issues/21)
  and
  [parachute-surface#22](https://github.com/ParachuteComputer/parachute-surface/issues/22)
  implement the producer and consumer sides; closes
  [parachute-patterns#81](https://github.com/ParachuteComputer/parachute-patterns/issues/81).
- **Forthcoming** — Vault and Hub join the contract as their tenancy
  surfaces formalize (no specific issues yet; the pattern doc is the
  lighthouse).
