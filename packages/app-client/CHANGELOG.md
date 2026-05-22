# Changelog

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
