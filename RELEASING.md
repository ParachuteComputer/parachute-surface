# Releasing

The `parachute-app` repo is a monorepo with two publishable packages:

- `@openparachute/app` — the host module (in `packages/app-host/`)
- `@openparachute/app-client` — the shared client library (in `packages/app-client/`)

The workspace root (`@openparachute/app-monorepo`) is intentionally `private: true` and should NEVER publish. The admin SPA (`web/admin/` → `@openparachute/app-admin-ui`) is also `private: true` — it's bundled into app-host's `dist/`, not separately published.

## Publish workflow

**To publish a specific package:**

```bash
# From repo root
npm publish --workspace @openparachute/app-client --tag rc
npm publish --workspace @openparachute/app --tag rc

# OR cd into the package
cd packages/app-client && npm publish --tag rc
cd packages/app-host && npm publish --tag rc
```

**Order matters**: publish `app-client` BEFORE `app` since `app` depends on `app-client`. Each consumer's `package.json` carries a concrete semver (e.g. `^0.1.0-rc.3`) — see the next section for why.

**Don't run `npm publish` from the repo root without `--workspace`** — npm would try to publish `@openparachute/app-monorepo` (the workspace root). That's blocked by `private: true` as a safety net.

## Workspace dependencies must be concrete in the published manifest

If a publishable package depends on a sibling workspace package, the dependency in its `package.json` MUST be a concrete semver (e.g. `"^0.1.0-rc.3"`) — NEVER `workspace:*` or `link:...`.

**Reason**: `npm publish` does NOT rewrite the `workspace:` protocol at publish time. (Bun's `bun publish` does, but we can't bind the publish workflow to a single tool.) `link:` is local-dev-only and always invalid in a published tarball. Either form leaks into the npm-served manifest and breaks every install:

```
error: Workspace dependency "@openparachute/app-client" not found
error: @openparachute/app-client@workspace:* failed to resolve
```

This bit us on `@openparachute/app@0.2.0-rc.3` and `@openparachute/notes-ui@0.1.0-rc.3` (2026-05-22).

**To bump a workspace sibling dep** (e.g. when app-client publishes a new rc):

1. Update the consumer's `package.json` to the new concrete version (e.g. `"^0.1.0-rc.4"`).
2. `bun install` to refresh the lockfile.
3. Run typecheck + tests locally.
4. Bump the consumer's own version + CHANGELOG entry referencing the dep bump.
5. Publish the consumer.

**Local dev still works** with concrete semver — Bun's workspace resolver finds the sibling package by name regardless of the version string (it falls back to the registry only when no matching sibling exists).

**Verify before publishing**:

```bash
cd packages/app-host && npm pack --dry-run
# scan the printed manifest's `dependencies` block — every entry must be a
# concrete semver. NO `workspace:` and NO `link:` strings.
```

If the dry-run shows `workspace:` or `link:`, fix the package.json before publishing.

## RC vs stable

Pre-1.0, every code-touching publish bumps `rc.N`:
- `npm publish --workspace @openparachute/app --tag rc` ships to `@rc`
- `npm publish --workspace @openparachute/app --tag latest` promotes to `@latest` (only after Aaron explicitly says ready)

## Verifying

```bash
npm view @openparachute/app dist-tags --json
npm view @openparachute/app-client dist-tags --json
```
