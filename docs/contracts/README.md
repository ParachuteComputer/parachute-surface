# Surface-enforced contracts

Contract docs the Surface module enforces. These moved here verbatim from `parachute-patterns/patterns/` (2026-07-04, patterns-archive decision: the patterns repo archives; each live-cited contract doc moves to the repo that enforces it).

| Contract | Governs |
|---|---|
| [`runtime-tenancy-contract.md`](./runtime-tenancy-contract.md) | Host↔tenant runtime metadata: surface-host injects `<base href>` + `parachute-*` meta tags into every served `index.html`; tenant bundles read them via `@openparachute/surface-client` instead of guessing from URL patterns. |
| [`backed-surface.md`](./backed-surface.md) | Surfaces that ship a backend (`@openparachute/surface-server`): the in-process runtime shape, the operator/audience trust geometry, the per-surface scoped credential, and the markdown-canonical content contract. |

The hub-enforced contracts (module protocol, manifest shape, OAuth scopes, design system, and friends) live at [`parachute-hub/docs/contracts/`](https://github.com/ParachuteComputer/parachute-hub/blob/main/docs/contracts/README.md).

Note: the docs are verbatim copies (plus a provenance header). Relative links to patterns that did **not** move (e.g. `./module-surfaces.md`, `./surface-bundle-shape.md`, `./tag-scoped-tokens.md`) point at the parachute-patterns archive; hub-enforced targets (e.g. `./hub-module-boundary.md`, `./module-protocol.md`) now live in `parachute-hub/docs/contracts/`.
