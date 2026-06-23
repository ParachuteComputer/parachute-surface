# Changelog

## [0.3.1] - 2026-06-23

### Added

- **Multi-audience OAuth — `VaultSurface.moduleAuth(opts)` (#133).** A surface can
  now hold a second, audience-scoped token (e.g. `agent:read` → `aud: agent`)
  alongside its vault token, so it can call another Parachute module's
  resource-server endpoints (the motivating case: subscribing to the agent
  daemon's live turn-events SSE). It must be a separate token because the hub's
  `inferAudience` lets a named-vault scope win — a token mixing `vault:…` +
  `agent:read` resolves to `aud: vault.<name>` (rejected by the agent), and the
  hub's refresh can't re-narrow — so `moduleAuth` runs its own authorize scoped
  to the module scope **alone**.

  `surface.moduleAuth({ scope: "agent:read" })` returns a `ModuleAuth` with
  `login()` / `handleCallback()` / `getAccessToken()` / `getToken()` / `logout()`
  — mirroring the vault token's lifecycle (cache + refresh-near-expiry). It
  **reuses** the surface's DCR client_id + discovery/refresh caches, and is
  **isolated** from the vault flow: the token is stored under a separate key
  (`storageScope`, default `"agent"`; a guard throws if it would alias the vault
  token), and the pending-flow `state` is namespaced by `flowKey` so a single
  shared OAuth callback routes correctly — `handleCallback()` returns `false`
  (declines without consuming) when the URL `state` belongs to another flow.

  Fully additive — the existing vault flow + `createVaultSurface` API are
  unchanged.

## [0.2.0] - 2026-06-02

### Added

- **Quick-start factory `createVaultSurface(...)` (surface-client design doc
  §5C / Phase 2).** One call replaces the ~20-line OAuth + `VaultClient` dance
  both adopters wrote by hand. It **auto-detects hosted vs standalone**: if a
  `parachute-mount` meta tag is present (the host-injected runtime-tenancy
  signal) it uses the hosted `getClientId()` path; otherwise it runs RFC 7591
  DCR (`discoverAuthServer` + `registerClient`) and seeds the client via
  `useClientId()`, caching the client_id in localStorage so it registers at
  most once per browser per (issuer, redirectUri). Force either path with
  `bootstrap: "hosted" | "dcr"`.

  Bakes the defaults both adopters chose by hand: `hubUrl` → the
  `parachute-hub` meta tag else `window.location.origin`; `redirectUri` →
  `${mount}/oauth/callback` (hosted) or `${origin}/oauth/callback`
  (standalone); `scope` → `"vault:read vault:write"`; `appName` → the tenant id
  (hosted) or a slug of `clientName` (standalone). `clientName` is the only
  required field (it's the DCR `client_name` shown on the hub consent screen).

  Returns a `VaultSurface` bundle: the configured `ParachuteOAuth` plus
  `login()` / `handleCallback()` / `getClient()` / `logout()`. `getClient()`
  hands back a `VaultClient` wired with refresh-on-401 that **re-reads** the
  latest stored token before refreshing (so a rotated refresh token isn't
  replayed). Framework-agnostic — no React. New subpath export
  `@openparachute/surface-client/create-vault-surface`. The brand-pin that
  notes-ui's `discovery.ts` shim carried (`client_name: "Parachute Notes"`)
  is now the factory's `clientName`.

## [0.1.0] - 2026-06-02

### Added

- **First-class standalone OAuth bootstrap (surface-client design doc
  Phase 1).** `ParachuteOAuth.useClientId(info)` seeds the driver with a
  client identity obtained out-of-band — the RFC 7591 Dynamic Client
  Registration path a *standalone* surface (served from GitHub Pages / any
  static host, with no Parachute surface-host in front of it) uses. With it,
  `beginFlow` / `handleCallback` / `refreshAccessToken` never call the
  hosted-only `/surface/<name>/oauth-client` endpoint. The README now leads
  with this standalone path; `getClientId()` remains the hosted bootstrap.
- **`examples/standalone-spa`** — a minimal, framework-free standalone surface
  demonstrating the full DCR bootstrap + OAuth dance + a vault query, all via
  `@openparachute/surface-client`.
- **`SURFACE_CLIENT_VERSION`** export (kept in sync with `package.json`).
  `APP_CLIENT_VERSION` is retained as a deprecated alias.

### Fixed

- **Docs truth.** README named the non-existent `@openparachute/app-client`
  throughout; corrected to `@openparachute/surface-client`. Documented the
  runtime-tenancy `<meta>`-tag contract + fallbacks and a typed-error → UI
  affordance guide.
- **Version drift.** The library version const had stalled at `0.1.0-rc.4`
  while `package.json` shipped `0.1.0`; reconciled to `0.1.0`.

- **Script-friendly `VaultClient` surface.** New entry points for code
  writing against a Parachute vault from Bun / Node / browser scripts
  without having to compose the canonical URL or carry the OAuth
  apparatus:

  - `VaultClient.fromHub({ hubOrigin, vaultName, token, tokenProvider })`
    — static factory composing `<hubOrigin>/vault/<name>` so scripts
    don't glue the pieces together. URL-encodes the vault name.
  - `tokenProvider: () => Promise<string> | string` option on the main
    constructor — called once per request, wins over `accessToken`
    when both are supplied. The script-side complement to `onAuthError`
    (which is for in-flight refresh, not external token rotation).
  - `createNotes(payloads)` — batch create via `POST /api/notes` with
    a `{notes: [...]}` envelope. Vault wraps in a transaction so
    partial batches roll back.
  - `findPath(from, to, { maxDepth? })` — graph BFS shortest path,
    `GET /api/find-path?source=&target=&max_depth=`. Returns
    `{ path: string[], relationships: string[] } | null`.
  - `deleteTag(name)` — `DELETE /api/tags/:name`. Surfaces vault's
    tag-in-use 409 as `VaultConflictError` (the `referenced_by` token
    list lives on `error.body`).
  - `VaultError` — new abstract base class. All concrete error
    classes now extend it; scripts can `catch (e instanceof
    VaultError)` to handle "any vault error" without enumerating.
  - `VaultPermissionError` (extends `VaultAuthError`) — thrown
    specifically on `403` so scripts can distinguish "wrong scope"
    from "dead token" (`401`). Back-compat: existing `instanceof
    VaultAuthError` checks still catch 403s.
  - `VaultServerError` (extends `VaultUnreachableError`) — thrown
    specifically on `5xx` responses. `VaultUnreachableError` is now
    the network-down case (`status: 0`). Back-compat: existing
    `instanceof VaultUnreachableError` checks still catch 5xx.
  - `FindPathResult` type exposed from the barrel.

  Motivates: ad-hoc scripts against a vault (the onboarding
  prompt's "scripted import" path) need an ergonomic client that
  doesn't require the full OAuth + reachability + auto-refresh
  apparatus. Same `VaultClient` class — script callers use the
  thinner surface, UI callers keep the full driver.

### Verified

- `bun test src/` → 153 pass / 0 fail across 8 test files (33 new
  cases in `vault-client-script.test.ts`).
- `bun run typecheck` clean.
- `bun run build` clean — `dist/vault-client.d.ts` exports
  `VaultError`, `VaultPermissionError`, `VaultServerError`,
  `createNotes`, `findPath`, `deleteTag`, `fromHub`.

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
