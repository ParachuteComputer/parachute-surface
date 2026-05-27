# @openparachute/notes-ui

The Parachute Notes UI bundle, packaged for installation under [parachute-surface][surface].

[surface]: https://github.com/ParachuteComputer/parachute-surface

## What's in the box

`dist/` is the Vite-built SPA. The package ships nothing else of substance — no node entrypoint, no bin, no daemon. The bundle is mount-path-agnostic when built with `VITE_BASE_PATH=/surface/notes/` (or any other path under parachute-surface's `/surface/<name>/` convention) and consumes the runtime tenancy contract (`<meta name="parachute-mount">`, `<meta name="parachute-hub">`) at boot.

## Install via parachute-surface

```
parachute-surface add @openparachute/notes-ui --name notes --path /surface/notes
```

parachute-surface fetches this package from npm, unpacks `dist/`, and serves it under the declared mount path. OAuth DCR + hub-issued bearers + the standard scopes wiring all flow through parachute-surface's bootstrap. See [`parachute-patterns/patterns/runtime-tenancy-contract.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/runtime-tenancy-contract.md) for how the host hands runtime config to the bundle.

## History

The legacy module-shaped wrapper `@openparachute/notes` (in the now-archived `parachute-notes` repo) installed via `parachute install notes`. It shipped the same bundle during the notes migration arc but has been deprecated; hub redirects `/notes/*` → `/surface/notes/*` for backwards compat. See the [parachute-surface design doc §16][s16] for the migration arc.

[s16]: https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-surface-design.md

## Source

Notes' source — components, hooks, vault client, sync engine, PWA — lives in `src/`. Run the dev server with `bun run dev`; tests with `bunx vitest run`.
