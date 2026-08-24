# parachute-surface

L2 Surface — the UI host module (`@openparachute/surface`, daemon :1946 behind
the hub), the bundled Notes reference surface, the surface SDK, and the
build-and-serve end of git-push surface deploys. **Keep compatible:**
`@openparachute/surface-client` and `surface-render` have real users on npm.
The README and `docs/contracts/` explain how it works; this file is only traps.

- **notes-ui defaults to relative asset URLs** (`base: ""`), so one `dist/`
  serves at any mount (`/notes/`, `/surface/notes/`, renamed installs) via
  runtime `detectMountBase()`. A root-origin standalone deploy must build with
  `VITE_BASE_PATH=/`, or deep routes like `/oauth/callback` resolve assets
  relatively and 404. Full story: the comments in
  `packages/notes-ui/vite.config.ts`.
- **npm publishes are tag-prefix-driven CI** — one package per tag prefix
  (`v...` = surface-host, `client-v...`, `render-v...`, `notes-ui-v...`, ...);
  see [RELEASING.md](./RELEASING.md). The twice-bitten trap: sibling deps in a
  publishable `package.json` must be concrete semver — `workspace:*`/`link:`
  leak into the published manifest and break every install. Publish
  `surface-client` before its dependents.
- **Two test runners:** notes-ui and surface-render are vitest; the rest are
  `bun test`. Use the root `bun run test` / `bun run typecheck` scripts — a
  bare `bun test` from the root sweeps the vitest packages and is not the gate.
- **Test state isolation is unconditional.** Root and surface-host `bunfig.toml`
  load `packages/surface-host/src/test-preload.ts`, which replaces any inherited
  `PARACHUTE_HOME` with a fresh temp directory and clears inherited hub authority.
  Do not weaken this to "only when unset": an inherited value commonly names the
  operator's live install, and `serve()` immediately sweeps credentials. Default
  surface-host paths share `resolveParachuteHome()`, whose test-mode tripwire
  refuses the real `~/.parachute` fallback if the cwd-sensitive preload is missed.
