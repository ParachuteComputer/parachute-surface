# Releasing

The `parachute-surface` repo is a monorepo with seven publishable packages, all shipped via [`.github/workflows/release.yml`](./.github/workflows/release.yml):

| Package | Path | Tag prefix |
|---|---|---|
| `@openparachute/surface` | `packages/surface-host/` | `v...` (e.g. `v0.2.0-rc.10`) |
| `@openparachute/surface-client` | `packages/surface-client/` | `client-v...` (e.g. `client-v0.1.0-rc.4`) |
| `@openparachute/account-client` | `packages/account-client/` | `account-v...` (e.g. `account-v0.1.0-rc.1`) |
| `@openparachute/surface-render` | `packages/surface-render/` | `render-v...` (e.g. `render-v0.1.0-rc.1`) |
| `@openparachute/notes-ui` | `packages/notes-ui/` | `notes-ui-v...` (e.g. `notes-ui-v0.1.4-rc.1`) |
| `@openparachute/doc-schema` | `packages/doc-schema/` | `doc-schema-v...` (e.g. `doc-schema-v0.1.0-rc.1`) |
| `@openparachute/surface-server` | `packages/surface-server/` | `server-v...` (e.g. `server-v0.1.0-rc.1`) |

The workspace root (`@openparachute/surface-monorepo`) is intentionally `private: true` and should NEVER publish. The admin SPA (`web/admin/` → `@openparachute/surface-admin-ui`) is also `private: true` — it's bundled into surface-host's `dist/`, not separately published.

All seven packages run on independent release cadences. Each tag pushes only the matching package.

> **notes-ui migration history (2026-05-24)**: notes-ui moved here from `parachute-notes/packages/notes-ui` to consolidate "host module + reference apps" in one repo. parachute-notes is being archived (notes-daemon was already deprecated per its [DEPRECATED.md](https://github.com/ParachuteComputer/parachute-notes/blob/main/packages/notes-daemon/DEPRECATED.md)). See workspace `CLAUDE.md` for context.

## Tag conventions

Per [governance rule 2](https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md):

| Tag shape | Publishes | npm `dist-tag` |
|---|---|---|
| `vX.Y.Z-rc.N` | `@openparachute/surface` | `rc` |
| `vX.Y.Z` | `@openparachute/surface` | `latest` |
| `client-vX.Y.Z-rc.N` | `@openparachute/surface-client` | `rc` |
| `client-vX.Y.Z` | `@openparachute/surface-client` | `latest` |
| `account-vX.Y.Z-rc.N` | `@openparachute/account-client` | `rc` |
| `account-vX.Y.Z` | `@openparachute/account-client` | `latest` |
| `render-vX.Y.Z-rc.N` | `@openparachute/surface-render` | `rc` |
| `render-vX.Y.Z` | `@openparachute/surface-render` | `latest` |
| `notes-ui-vX.Y.Z-rc.N` | `@openparachute/notes-ui` | `rc` |
| `notes-ui-vX.Y.Z` | `@openparachute/notes-ui` | `latest` |
| `doc-schema-vX.Y.Z-rc.N` | `@openparachute/doc-schema` | `rc` |
| `doc-schema-vX.Y.Z` | `@openparachute/doc-schema` | `latest` |
| `server-vX.Y.Z-rc.N` | `@openparachute/surface-server` | `rc` |
| `server-vX.Y.Z` | `@openparachute/surface-server` | `latest` |

The workflow auto-detects rc vs stable from the `-rc.` substring; jobs gate by tag prefix via `startsWith(github.ref_name, '<prefix>-')`.

## Release flow

Per [governance rule 2 (updated 2026-05-24)](https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md), PRs do NOT bump version per-commit. Bump + tag together only when you intend to ship.

### Releasing `@openparachute/surface`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/surface-host/package.json (rc or drop -rc for stable), commit, push.
VERSION="v$(bun -e "console.log(require('./packages/surface-host/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-surface/actions). The surface-client publish job skips on these tags (it gates on the `client-` prefix).

### Releasing `@openparachute/surface-client`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/surface-client/package.json, commit, push.
VERSION="client-v$(bun -e "console.log(require('./packages/surface-client/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The other publish jobs skip on these tags. surface-client's `prepublishOnly` hook builds via `tsc` before packing.

### Releasing `@openparachute/account-client`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/account-client/package.json, commit, push.
VERSION="account-v$(bun -e "console.log(require('./packages/account-client/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The other publish jobs skip on these tags. account-client's `prepublishOnly` hook builds via `tsc` before packing. It is dependency-free (no workspace siblings), so there's no publish-order constraint.

### Releasing `@openparachute/surface-render`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/surface-render/package.json, commit, push.
VERSION="render-v$(bun -e "console.log(require('./packages/surface-render/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The other publish jobs skip on these tags. surface-render's `prepublishOnly` hook builds via `tsc` before packing. surface-render depends on `@openparachute/surface-client` (`workspace:^`), so if shipping both, publish surface-client FIRST.

### Releasing `@openparachute/notes-ui`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/notes-ui/package.json, commit, push.
VERSION="notes-ui-v$(bun -e "console.log(require('./packages/notes-ui/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The other publish jobs skip on these tags. notes-ui's `prepublishOnly` hook runs `tsc -b && vite build` to produce `dist/` before packing.

### Releasing `@openparachute/doc-schema`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/doc-schema/package.json, commit, push.
VERSION="doc-schema-v$(bun -e "console.log(require('./packages/doc-schema/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The other publish jobs skip on these tags. doc-schema's `prepublishOnly` hook builds via `tsc` before packing. Its serialization-affecting deps (prosemirror-markdown, prosemirror-model, markdown-it) are exact-pinned — see the package README before bumping them.

### Releasing `@openparachute/surface-server`

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/surface-server/package.json, commit, push.
VERSION="server-v$(bun -e "console.log(require('./packages/surface-server/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The other publish jobs skip on these tags. surface-server publishes raw TypeScript sources (no build step). It depends on `@openparachute/surface` and `@openparachute/surface-client` by concrete semver — if shipping those too, publish them FIRST.

### Releasing the docs-editor tarball (GitHub Release, not npm)

`@openparachute/docs-editor` is `private: true` and never publishes to npm — its distribution is an installable tarball attached to a GitHub Release (the WovenBoulder packaging pattern; see `release-docs-editor-tarball` in release.yml).

```sh
git fetch && git checkout main && git pull --ff-only
# Bump packages/docs-editor/package.json, commit, push.
VERSION="docs-editor-v$(bun -e "console.log(require('./packages/docs-editor/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI builds the web dist + the self-contained server bundle, packs `docs-editor-surface-<version>.tgz` in the installer layout (`package/` → `meta.json` + `dist/` + `server/index.bundle.js`), validates the layout (tar listing + the bundle's default-export factory loads standalone), creates the GitHub Release for the tag if none exists (rc tags are marked prerelease), and attaches the asset. No npm Trusted Publisher rule involved.

Operators install by pasting the release-tag URL into Surface admin → Add surface — see [packages/docs-editor/README.md](./packages/docs-editor/README.md#install) (requires hub ≥ 0.7.1).

### Promoting an rc chain to stable

Open a PR (or commit directly) that drops the `-rc.N` suffix from the relevant `package.json`, merge, then tag with the bare version (`vX.Y.Z` for app, `client-vX.Y.Z` for surface-client, `notes-ui-vX.Y.Z` for notes-ui). CI publishes with `dist-tag=latest`.

### Doc-only PRs

Per governance, doc-only PRs DO NOT bump version. They merge straight to main; changes get folded into whatever the next ship-driven version bump captures.

### Order matters when bumping both packages

`app` depends on `surface-client`. If you're shipping both, publish `surface-client` FIRST so the new version is on npm before app's tarball is built. App's `package.json` references surface-client by concrete semver (e.g. `^0.1.0-rc.4`); see the workspace-deps section below for why this matters.

## One-time setup (operator)

Before the workflow can publish, this repo needs **npm Trusted Publisher rules — one per published package**:

1. Log into npmjs.com → `@openparachute/surface` → Settings → Trusted Publishers → "Add a new publisher" → GitHub Actions:
   - Organization: `ParachuteComputer`
   - Repository name: `parachute-surface`
   - Workflow filename: `release.yml`
   - Environment name: (leave blank)
2. Same for `@openparachute/surface-client` — same workflow file.
3. Same for `@openparachute/account-client` — **new package, no rule exists yet.** Add a Trusted Publisher rule (org `ParachuteComputer`, repo `parachute-surface`, workflow `release.yml`, env blank) before the first `account-v...` tag is pushed, or the publish job will fail with 403.
4. Same for `@openparachute/surface-render` — **new package, no rule exists yet.** Add a Trusted Publisher rule (org `ParachuteComputer`, repo `parachute-surface`, workflow `release.yml`, env blank) before the first `render-v...` tag is pushed, or the publish job will fail with 403.
5. Same for `@openparachute/notes-ui` — **this rule may currently be configured against `parachute-notes` from before the migration** (notes-ui's prior home). Update it to point at `parachute-surface` per the values above. The publisher rule verifies `workflow_ref`, so a mismatched repo/workflow combo will fail with 403 on tag push.
6. Same for `@openparachute/doc-schema` — **new package, no rule exists yet.** Add a Trusted Publisher rule (org `ParachuteComputer`, repo `parachute-surface`, workflow `release.yml`, env blank) before the first `doc-schema-v...` tag is pushed.
7. Same for `@openparachute/surface-server` — **new package, no rule exists yet.** Same values, before the first `server-v...` tag is pushed.

All seven packages share the same `release.yml` file; npm OIDC verification keys on the workflow_ref claim, not the tag content.

No `NPM_TOKEN` secret needed — the workflow uses OIDC.

## Verifying a release

```sh
# app
npm view @openparachute/surface@<version> dist.tarball
npm view @openparachute/surface dist-tags

# surface-client
npm view @openparachute/surface-client@<version> dist.tarball
npm view @openparachute/surface-client dist-tags
```

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path on npm (the strict 72-hour unpublish policy is for emergencies, not routine rollback). To roll back: cut a new patch from a known-good commit (e.g. `0.2.0` → `0.2.1` reverting the bad change), tag, and ship.

## Troubleshooting

- **Workflow doesn't trigger**: confirm the tag matches one of the patterns (`v[0-9]+...` for app, `client-v[0-9]+...` for surface-client, `render-v[0-9]+...` for surface-render, `notes-ui-v[0-9]+...` for notes-ui).
- **`version mismatch` error**: the relevant `package.json` version differs from the tag. Re-tag the correct commit, or fix the version.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are `ParachuteComputer` / `parachute-surface` / `release.yml`.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level.
- **`dist/admin/` missing in published app tarball**: the workflow's explicit `build surface-host` step must run before publish (surface-host has no `prepack`).
- **Two publish jobs running for the same tag**: the `if:` gates filter by `startsWith(github.ref_name, 'client-')`. Verify the tag matches exactly one prefix.

---

## Manual publish (fallback)

If for some reason CI can't run (e.g. workflow file moved, OIDC misconfigured), the manual flow is:

```bash
# From repo root
npm publish --workspace @openparachute/surface --tag rc
npm publish --workspace @openparachute/surface-client --tag rc

# OR cd into the package
cd packages/surface-host && npm publish --tag rc
cd packages/surface-client && npm publish --tag rc
```

**Order matters when bumping both**: publish `surface-client` BEFORE `app` since `app` depends on `surface-client`. Each consumer's `package.json` carries a concrete semver (e.g. `^0.1.0-rc.4`) — see the next section for why.

**Don't run `npm publish` from the repo root without `--workspace`** — npm would try to publish `@openparachute/surface-monorepo` (the workspace root). That's blocked by `private: true` as a safety net.

### Workspace dependencies must be concrete in the published manifest

If a publishable package depends on a sibling workspace package, the dependency in its `package.json` MUST be a concrete semver (e.g. `"^0.1.0-rc.4"`) — NEVER `workspace:*` or `link:...`.

**Reason**: `npm publish` does NOT rewrite the `workspace:` protocol at publish time. (Bun's `bun publish` does, but we can't bind the publish workflow to a single tool.) `link:` is local-dev-only and always invalid in a published tarball. Either form leaks into the npm-served manifest and breaks every install:

```
error: Workspace dependency "@openparachute/surface-client" not found
error: @openparachute/surface-client@workspace:* failed to resolve
```

This bit us on `@openparachute/surface@0.2.0-rc.3` and `@openparachute/notes-ui@0.1.0-rc.3` (2026-05-22).

**To bump a workspace sibling dep** (e.g. when surface-client publishes a new rc):

1. Update the consumer's `package.json` to the new concrete version (e.g. `"^0.1.0-rc.5"`).
2. `bun install` to refresh the lockfile.
3. Run typecheck + tests locally.
4. Bump the consumer's own version + CHANGELOG entry referencing the dep bump.
5. Publish the consumer (or push the tag if surface-host).

**Local dev still works** with concrete semver — Bun's workspace resolver finds the sibling package by name regardless of the version string (it falls back to the registry only when no matching sibling exists).

**Verify before publishing**:

```bash
cd packages/surface-host && npm pack --dry-run
# scan the printed manifest's `dependencies` block — every entry must be a
# concrete semver. NO `workspace:` and NO `link:` strings.
```

If the dry-run shows `workspace:` or `link:`, fix the package.json before publishing.

### RC vs stable (manual flow)

Pre-1.0, every code-touching publish bumps `rc.N`:
- `npm publish --workspace @openparachute/surface-client --tag rc` ships to `@rc`
- `npm publish --workspace @openparachute/surface-client --tag latest` promotes to `@latest` (only after Aaron explicitly says ready)

### Verifying

```bash
npm view @openparachute/surface dist-tags --json
npm view @openparachute/surface-client dist-tags --json
```
