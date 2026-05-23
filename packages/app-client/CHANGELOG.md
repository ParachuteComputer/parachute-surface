# Changelog

## [0.1.0-rc.4] - 2026-05-23

### Added

- `getMountBase()`, `getTenantId()`, `getHubOrigin()`, `getVaultUrl()`
  — runtime tenancy helpers for apps. Reads the meta tags injected by
  parachute-app's host (producer side: `@openparachute/app` rc.8, the
  parachute-app#21 ship). Closes
  [parachute-app#22](https://github.com/ParachuteComputer/parachute-app/issues/22).
  The canonical consumer pattern for apps that need to know their
  mount path, hub origin, or bound vault — apps depend on
  `@openparachute/app-client` and don't write meta-tag parsing code
  themselves.

  | Helper | Reads | Returns |
  |---|---|---|
  | `getMountBase()` | `parachute-mount` | mount path without trailing slash (`/app/notes`) or null |
  | `getTenantId()` | `parachute-mount` | last segment of `/app/<slug>` (`notes`) or null |
  | `getHubOrigin()` | `parachute-hub` | hub origin (`http://127.0.0.1:1939`) or null |
  | `getVaultUrl()` | `parachute-vault` (+ optional `parachute-vault-origin`) | full vault URL or null |

  Design choices:

  - **All helpers return `null` on missing tags.** Callers decide the
    default — apps migrating from notes-ui's regex detection fall
    back to `/notes`; new apps may prefer to throw at app boot.
  - **`getMountBase()` + `getTenantId()` both exposed** even though
    one derives from the other — different call sites want
    different shapes (React Router basename vs storage keys vs log
    lines).
  - **`getVaultUrl()` returns a fully-qualified URL when possible.**
    Joins `window.location.origin` (same-origin, today) or
    `parachute-vault-origin` (cross-origin, forward-compat for
    cloud) with the vault path. Falls back to path-only when no
    origin is resolvable (SSR).
  - **No producer-side coupling.** This module reads meta tags and
    nothing else; it does not import from `@openparachute/app` or
    `app-host`. The contract is the tag shape, not a shared type.

  Notes-ui's `packages/notes-ui/src/lib/base-url.ts` (the regex
  consumer from [notes#159](https://github.com/ParachuteComputer/parachute-notes/pull/159))
  migrates to `getMountBase()` in a follow-up PR; this PR just
  ships the library helpers.

  Exported from both the barrel (`@openparachute/app-client`) and a
  new subpath (`@openparachute/app-client/mount`) for tree-shake
  friendliness.

### Verified

- `bun test src/` → 119 pass / 0 fail across 7 test files (29 new
  cases in `mount.test.ts`).
- `bun run typecheck` clean.

## [0.1.0-rc.3] - 2026-05-22

feat(app-client): lift `VaultClient.request` / `requestWithRetry` /
`requestCursorWithRetry` from `private` to `protected` for
subclass-based extension (closes
[app#9](https://github.com/ParachuteComputer/parachute-app/issues/9)).

Backwards-compatible visibility relaxation: existing consumers that
only call the public methods see no change. New consumers can now
subclass `VaultClient` to add domain-specific endpoints without
re-implementing the auth/refresh/error-classification loop:

```ts
class NotesVaultClient extends VaultClient {
  async linkAttachment(noteId: string, attachment: AttachmentRef) {
    return this.request("POST", `/notes/${noteId}/attachments`, attachment);
  }
}
```

Notes' planned adoption (design doc section 16 Phase 1) saves ~200
lines of vendored request loop and ensures future error-handling
fixes in app-client propagate automatically.

Three methods touched (visibility-only — zero behavior change):

| Method | Before | After |
|---|---|---|
| `request<T>(path, init?)` | `private` | `protected` |
| `requestWithRetry<T>(path, init, allowRetry)` | `private` | `protected` |
| `requestCursorWithRetry(path, allowRetry)` | `private` | `protected` |

Each gains a one-line JSDoc explaining the subclass-extension intent.
Private instance fields (`baseUrl`, `token`, `fetchImpl`, etc.) stay
private — subclasses extend behavior via the protected request
methods, not by touching connection state directly.

### Verified

Test counts unchanged from `0.1.0-rc.2` (90 pass / 0 fail — no
behavior change to test). Typecheck clean. Build clean.

## [0.1.0-rc.1] - 2026-05-21

Initial release. Lands as part of [parachute-app Phase 2.0](https://github.com/ParachuteComputer/parachute-app/pull/4)
alongside `@openparachute/app` 0.2.0-rc.1.

`@openparachute/app-client` is the shared browser-side library for
apps hosted under [`parachute-app`](https://github.com/ParachuteComputer/parachute-app).
Mirrors the role `@openparachute/scope-guard` plays for resource-server
JWT validation: one well-tested implementation so each hosted app
doesn't re-roll OAuth + vault REST + token storage from scratch.

### Public surface

| Module | Surface |
|---|---|
| `oauth` | `ParachuteOAuth` driver class — PKCE + same-hub auto-trust |
| `vault-client` | `VaultClient` REST client with auto-refresh on 401/403 + structured errors |
| `token-storage` | `loadToken` / `saveToken` / `clearToken` / `clearAllTokensForApp` |
| `sw-reload` | `reloadAfterServiceWorkerUpdate` — PWA-mode SW reload helper |
| `vault-id` | `vaultIdFromUrl` / `normalizeVaultUrl` — canonical URL ↔ storage-key mapping |

Both the barrel (`@openparachute/app-client`) and subpath imports
(`@openparachute/app-client/oauth`) resolve to the same modules.

### Extracted from

The implementation is the canonical pattern in
`parachute-notes/src/lib/vault/` (notes#148, notes#149, notes#150)
lifted into a standalone library. Notes' migration to app-client
(design doc section 16 Phase 1) is the planned first downstream
consumer.

### Verified

- `bun test src/` → 80 pass / 0 fail across 6 test files (vault-id,
  token-storage, discovery, oauth, vault-client, sw-reload).
- `bun run typecheck` clean.
- `bun run build` emits ESM + .d.ts + sourcemaps to `dist/`.
