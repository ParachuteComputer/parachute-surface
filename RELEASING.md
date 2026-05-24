# Releasing

The `parachute-app` repo is a monorepo with two publishable packages:

- `@openparachute/app` — the host module (in `packages/app-host/`)
- `@openparachute/app-client` — the shared client library (in `packages/app-client/`)

The workspace root (`@openparachute/app-monorepo`) is intentionally `private: true` and should NEVER publish. The admin SPA (`web/admin/` → `@openparachute/app-admin-ui`) is also `private: true` — it's bundled into app-host's `dist/`, not separately published.

## Scope of this doc / CI

**Only `@openparachute/app` (app-host) has tag-triggered release CI today.** The workflow at [`.github/workflows/release.yml`](./.github/workflows/release.yml) publishes app-host on tag push.

`@openparachute/app-client` still publishes via the manual flow described in the [Manual publish (app-client + fallback)](#manual-publish-app-client--fallback) section below. Wiring app-client into tag-triggered CI is a follow-up — needs its own tag namespace (likely `client-v…`) so the two packages don't collide on a shared `vX.Y.Z` tag.

## Tag conventions (for `@openparachute/app`)

Per [parachute-patterns governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md):

| Tag shape | Example | npm `dist-tag` |
|---|---|---|
| `vX.Y.Z-rc.N` | `v0.2.0-rc.10` | `rc` |
| `vX.Y.Z` | `v0.2.0` | `latest` |

The workflow auto-detects rc vs stable from the tag string (`-rc.` substring).

## Release flow (`@openparachute/app`)

### For an rc bump (each code-touching PR merge)

After your PR merges to `main` with a bumped `rc.N` in `packages/app-host/package.json`:

```sh
git fetch && git checkout main && git pull --ff-only
VERSION="v$(bun -e "console.log(require('./packages/app-host/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-app/actions).

### Promoting an rc chain to stable

When the rc chain is ready to release:

1. Open a PR that drops the `-rc.N` suffix from `packages/app-host/package.json` (e.g. `0.2.0-rc.10` → `0.2.0`).
2. Reviewer + merge as usual.
3. Tag the merged commit with the bare version: `git tag v0.2.0 && git push origin v0.2.0`.
4. CI publishes with `dist-tag=latest`.

### Doc-only PRs

Per governance, doc-only PRs are EXEMPT from rc.N bumping — they merge without a version bump and get picked up by the next code-touching PR's rc bump (or by the stable promotion, whichever comes first). Don't fragment a release into many patch bumps mid-validation.

If you DO need to ship a doc-only fix outside an active rc chain, bump the next patch (`0.2.0` → `0.2.1`), tag, ship.

## One-time setup (operator)

Before the workflow can publish, this repo needs an **npm Trusted Publisher** rule for `@openparachute/app`:

1. Log into npmjs.com → package `@openparachute/app` → Settings → Trusted Publishers → "Add a new publisher" → choose **GitHub Actions**. Fill:
   - Organization: `ParachuteComputer`
   - Repository name: `parachute-app`
   - Workflow filename: `release.yml`
   - Environment name: (leave blank)

No `NPM_TOKEN` secret needed — the workflow uses OIDC.

## Verifying a release

```sh
npm view @openparachute/app@<version> dist.tarball
npm view @openparachute/app dist-tags
```

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path on npm (the strict 72-hour unpublish policy is for emergencies, not routine rollback). To roll back: cut a new patch from a known-good commit (e.g. `0.2.0` → `0.2.1` reverting the bad change), tag, and ship.

## Troubleshooting

- **Workflow doesn't trigger**: confirm the tag matches the workflow's `on.push.tags` pattern (`v[0-9]+.[0-9]+.[0-9]+` or `v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`).
- **`version mismatch` error in publish-npm**: `packages/app-host/package.json` version differs from the tag. Re-tag the correct commit.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are exactly `ParachuteComputer` / `parachute-app` / `release.yml`.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level. Verify the YAML.
- **`dist/admin/` missing in published tarball**: the workflow's `build app-host` step must run before `npm publish`. app-host has no `prepack`/`prepublishOnly` hook — the build is explicit in the workflow.

---

## Manual publish (app-client + fallback)

`@openparachute/app-client` still publishes manually until tag-triggered CI is wired for it.

**To publish a specific package:**

```bash
# From repo root
npm publish --workspace @openparachute/app-client --tag rc

# OR cd into the package
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
