# Releasing

The `parachute-app` repo is a monorepo with two publishable packages, both shipped via [`.github/workflows/release.yml`](./.github/workflows/release.yml):

| Package | Path | Tag prefix |
|---|---|---|
| `@openparachute/app` | `packages/app-host/` | `v...` (e.g. `v0.2.0-rc.10`) |
| `@openparachute/app-client` | `packages/app-client/` | `client-v...` (e.g. `client-v0.1.0-rc.4`) |

The workspace root (`@openparachute/app-monorepo`) is intentionally `private: true` and should NEVER publish. The admin SPA (`web/admin/` → `@openparachute/app-admin-ui`) is also `private: true` — it's bundled into app-host's `dist/`, not separately published.

Both packages run on independent release cadences. Pushing `v0.2.0-rc.11` publishes app only; pushing `client-v0.1.0-rc.5` publishes app-client only.

## Tag conventions

Per [parachute-patterns governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md):

| Tag shape | Publishes | npm `dist-tag` |
|---|---|---|
| `vX.Y.Z-rc.N` | `@openparachute/app` | `rc` |
| `vX.Y.Z` | `@openparachute/app` | `latest` |
| `client-vX.Y.Z-rc.N` | `@openparachute/app-client` | `rc` |
| `client-vX.Y.Z` | `@openparachute/app-client` | `latest` |

The workflow auto-detects rc vs stable from the `-rc.` substring; jobs gate by tag prefix via `startsWith(github.ref_name, 'client-')`.

## Release flow

Per [governance rule 2 (updated 2026-05-24)](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md), PRs do NOT bump version per-commit. Bump + tag together only when you intend to ship.

### Releasing `@openparachute/app`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/app-host/package.json (rc or drop -rc for stable), commit, push.
VERSION="v$(bun -e "console.log(require('./packages/app-host/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-app/actions). The app-client publish job skips on these tags (it gates on the `client-` prefix).

### Releasing `@openparachute/app-client`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/app-client/package.json, commit, push.
VERSION="client-v$(bun -e "console.log(require('./packages/app-client/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The app publish job skips on these tags. app-client's `prepublishOnly` hook builds via `tsc` before packing.

### Promoting an rc chain to stable

Open a PR (or commit directly) that drops the `-rc.N` suffix from the relevant `package.json`, merge, then tag with the bare version (`vX.Y.Z` for app, `client-vX.Y.Z` for app-client). CI publishes with `dist-tag=latest`.

### Doc-only PRs

Per governance, doc-only PRs DO NOT bump version. They merge straight to main; changes get folded into whatever the next ship-driven version bump captures.

### Order matters when bumping both packages

`app` depends on `app-client`. If you're shipping both, publish `app-client` FIRST so the new version is on npm before app's tarball is built. App's `package.json` references app-client by concrete semver (e.g. `^0.1.0-rc.4`); see the workspace-deps section below for why this matters.

## One-time setup (operator)

Before the workflow can publish, this repo needs **npm Trusted Publisher rules — one per published package**:

1. Log into npmjs.com → `@openparachute/app` → Settings → Trusted Publishers → "Add a new publisher" → GitHub Actions:
   - Organization: `ParachuteComputer`
   - Repository name: `parachute-app`
   - Workflow filename: `release.yml`
   - Environment name: (leave blank)
2. Same for `@openparachute/app-client` — same workflow file, the publisher rule verifies workflow_ref not tag content. Both packages share `release.yml`.

No `NPM_TOKEN` secret needed — the workflow uses OIDC.

## Verifying a release

```sh
# app
npm view @openparachute/app@<version> dist.tarball
npm view @openparachute/app dist-tags

# app-client
npm view @openparachute/app-client@<version> dist.tarball
npm view @openparachute/app-client dist-tags
```

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path on npm (the strict 72-hour unpublish policy is for emergencies, not routine rollback). To roll back: cut a new patch from a known-good commit (e.g. `0.2.0` → `0.2.1` reverting the bad change), tag, and ship.

## Troubleshooting

- **Workflow doesn't trigger**: confirm the tag matches one of the patterns (`v[0-9]+...` for app, `client-v[0-9]+...` for app-client).
- **`version mismatch` error**: the relevant `package.json` version differs from the tag. Re-tag the correct commit, or fix the version.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are `ParachuteComputer` / `parachute-app` / `release.yml`.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level.
- **`dist/admin/` missing in published app tarball**: the workflow's explicit `build app-host` step must run before publish (app-host has no `prepack`).
- **Two publish jobs running for the same tag**: the `if:` gates filter by `startsWith(github.ref_name, 'client-')`. Verify the tag matches exactly one prefix.

---

## Manual publish (fallback)

If for some reason CI can't run (e.g. workflow file moved, OIDC misconfigured), the manual flow is:

```bash
# From repo root
npm publish --workspace @openparachute/app --tag rc
npm publish --workspace @openparachute/app-client --tag rc

# OR cd into the package
cd packages/app-host && npm publish --tag rc
cd packages/app-client && npm publish --tag rc
```

**Order matters when bumping both**: publish `app-client` BEFORE `app` since `app` depends on `app-client`. Each consumer's `package.json` carries a concrete semver (e.g. `^0.1.0-rc.4`) — see the next section for why.

**Don't run `npm publish` from the repo root without `--workspace`** — npm would try to publish `@openparachute/app-monorepo` (the workspace root). That's blocked by `private: true` as a safety net.

### Workspace dependencies must be concrete in the published manifest

If a publishable package depends on a sibling workspace package, the dependency in its `package.json` MUST be a concrete semver (e.g. `"^0.1.0-rc.4"`) — NEVER `workspace:*` or `link:...`.

**Reason**: `npm publish` does NOT rewrite the `workspace:` protocol at publish time. (Bun's `bun publish` does, but we can't bind the publish workflow to a single tool.) `link:` is local-dev-only and always invalid in a published tarball. Either form leaks into the npm-served manifest and breaks every install:

```
error: Workspace dependency "@openparachute/app-client" not found
error: @openparachute/app-client@workspace:* failed to resolve
```

This bit us on `@openparachute/app@0.2.0-rc.3` and `@openparachute/notes-ui@0.1.0-rc.3` (2026-05-22).

**To bump a workspace sibling dep** (e.g. when app-client publishes a new rc):

1. Update the consumer's `package.json` to the new concrete version (e.g. `"^0.1.0-rc.5"`).
2. `bun install` to refresh the lockfile.
3. Run typecheck + tests locally.
4. Bump the consumer's own version + CHANGELOG entry referencing the dep bump.
5. Publish the consumer (or push the tag if app-host).

**Local dev still works** with concrete semver — Bun's workspace resolver finds the sibling package by name regardless of the version string (it falls back to the registry only when no matching sibling exists).

**Verify before publishing**:

```bash
cd packages/app-host && npm pack --dry-run
# scan the printed manifest's `dependencies` block — every entry must be a
# concrete semver. NO `workspace:` and NO `link:` strings.
```

If the dry-run shows `workspace:` or `link:`, fix the package.json before publishing.

### RC vs stable (manual flow)

Pre-1.0, every code-touching publish bumps `rc.N`:
- `npm publish --workspace @openparachute/app-client --tag rc` ships to `@rc`
- `npm publish --workspace @openparachute/app-client --tag latest` promotes to `@latest` (only after Aaron explicitly says ready)

### Verifying

```bash
npm view @openparachute/app dist-tags --json
npm view @openparachute/app-client dist-tags --json
```
