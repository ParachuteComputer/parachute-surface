# Changelog

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
