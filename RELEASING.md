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

**Order matters**: publish `app-client` BEFORE `app` since `app` depends on `app-client@workspace:*`. Bun's `workspace:*` resolves to the actual version at publish time.

**Don't run `npm publish` from the repo root without `--workspace`** — npm would try to publish `@openparachute/app-monorepo` (the workspace root). That's blocked by `private: true` as a safety net.

## RC vs stable

Pre-1.0, every code-touching publish bumps `rc.N`:
- `npm publish --workspace @openparachute/app --tag rc` ships to `@rc`
- `npm publish --workspace @openparachute/app --tag latest` promotes to `@latest` (only after Aaron explicitly says ready)

## Verifying

```bash
npm view @openparachute/app dist-tags --json
npm view @openparachute/app-client dist-tags --json
```
