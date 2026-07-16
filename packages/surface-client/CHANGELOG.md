# Changelog

## [0.3.6] - 2026-07-16

### Fixed — `queryNotesCursor` actually paginates (contract-drift brief §3)

`queryNotesCursor` was broken against both doors in three compounding ways;
pagination silently stopped after page 1 everywhere. Grounded against the
real wire contract (bun `parachute-vault/src/routes.ts:1383-1394,1729-1735`,
cloud `parachute-cloud/workers/vault/src/rest/notes.ts:256-268,379-383` +
`rest/parse.ts:50-53`):

- **Bootstrap gap** — the first call never sent `?cursor=` at all (only set
  the param `if (cursor)`, and page 1 has no cursor yet). Cursor mode is
  PRESENCE-based on both doors: an entirely-omitted `cursor` param gets the
  legacy bare-array shape forever, so the first call could never obtain a
  watermark. Fixed: every call now sets `cursor` (empty string on
  bootstrap).
- **Envelope not parsed** — once in cursor mode, both doors answer
  `{notes, next_cursor}`, not a bare array; the old code cast the whole body
  to `Note[]`, so `items` silently became a malformed non-array object.
  Fixed: the body is parsed as the envelope, with a defensive fallback to a
  bare array for a server that ignores `cursor` entirely.
- **Wrong cursor source** — the old code read `X-Next-Cursor`, a header the
  self-hosted bun vault never emits (only cloud mirrors the watermark into
  it, additively). Fixed: `next_cursor` is read from the body first; the
  header is now only a fallback for a response whose body omits it.
- **New client-side guard** — cursor pagination forces ascending
  `updated_at` order server-side, so `orderBy` or `sort: "desc"` alongside
  `cursor` always 400s (`INVALID_QUERY`) on both doors
  (`parachute-vault/core/src/notes.ts:1320-1338`). `queryNotesCursor` now
  throws that error client-side instead of spending a round trip on a
  combination that can never succeed.

**Termination contract**: `next_cursor` is never null or absent on the
wire — core's `queryNotesPaged` unconditionally encodes a watermark,
advancing it across rows and holding it at the prior value on an empty
page (`parachute-vault/core/src/notes.ts:1741-1748`; `QueryNotesPage`'s
`next_cursor` is a non-nullable `string`). So `nextCursor` is a resumable
"since last checked" watermark, not a finite-pagination end marker — stop
draining when a page comes back with `items.length === 0`, not when
`nextCursor` is falsy (it never will be). Always persist the last
`nextCursor` you saw as your resume point.

**Wire-visible**: `queryNotesCursor` requests now always carry a `cursor`
query param (previously omitted on the bootstrap call) and its response
parsing changed from "cast the body to `Note[]`" to "parse the
`{notes, next_cursor}` envelope" — the public input/output *types* are
unchanged (`{ items: Note[]; nextCursor?: string }`), but the runtime
behavior of this one broken-in-practice method changes for anyone who was
compensating for the old bugs. `queryNotes` (the non-cursor path) is
untouched — same request shape, same bare-array response, byte-compatible.

### Removed — stale `notes.parachute.computer` GitHub Pages deploy workflow

`.github/workflows/deploy-notes-ui.yml` deployed `notes-ui` to GitHub Pages
on every push to `main` touching `packages/notes-ui/**` or
`packages/surface-client/**`. `notes.parachute.computer` is now a 301
redirect worker on Cloudflare (`parachute-cloud/workers/notes-redirect`) —
the GitHub Pages target is DNS-shadowed and unreachable, so the workflow was
burning CI minutes deploying a bundle nothing can see. The `notes-ui`
package itself is untouched; only the dead deploy job is gone.

## [0.3.5] - 2026-07-16

### Added — write-attribution fields on `Note` / `NoteSummary` (vault#298)

The vault has carried write-attribution (`createdBy`/`createdVia`/`lastUpdatedBy`/
`lastUpdatedVia`) on note responses since vault#298; the public `Note` and
`NoteSummary` contracts didn't expose it yet, so consumers had no typed way to
read it. Strictly additive — all four fields are optional `string | null`, so
existing consumers and legacy notes (which carry `null`, predating attribution)
are unaffected.

- **`createdBy` / `createdVia`** — the principal + interface of the first write.
- **`lastUpdatedBy` / `lastUpdatedVia`** — the principal + interface of the most
  recent write.
- These are **factual provenance fields only** — a surface that wants to render
  a "human vs AI" distinction maps known principals to it separately; the
  contract makes no such inference.
- Compile-time contract fixture (`src/__tests__/vault-types.contract.test.ts`)
  asserts the barrel's `Note`/`NoteSummary` accept the fields (string, `null`,
  and omitted) and reject a wrong-typed value — wired into a new
  `tsconfig.test.json` so `tsc` actually checks it (the build config excludes
  `__tests__`), run from both this package's `typecheck` script and the root
  `typecheck:all`.

## [0.3.4] - 2026-07-05

### Changed — live-query is now WebSocket-only (no SSE; the fallback is polling)

Phase 2 of the SSE → Hibernatable-WebSockets migration (team-vault
`Decisions/2026-07-04-live-query-ws-hibernation`; wire contract
`parachute-cloud/workers/vault/docs/live-query-ws.md`). A held-open SSE stream
pins the per-vault Cloudflare Durable Object awake and bills duration; a
Hibernatable WebSocket lets an idle-but-open socket evict the DO → ~$0 idle.
**SSE is being retired, so the client no longer speaks it** — the model is
two-state: **WebSocket-or-polling**, where polling (the consumer's react-query
cadence) is the floor and a live socket is a fresher-than-polling augmentation
on top.

- **`VaultClient.subscribe()` is WebSocket-only** (`ws-transport.ts`). The
  previous fetch-stream SSE transport (`startSubscription` / `parseSSEStream`)
  is removed. `createLiveList`, the reconcilers, and consumers (notes-ui) are
  untouched — they sit above the transport seam.
- **Graceful degradation to polling (never an error, never a hang).** When WS
  can't be established — an old server without the binding, a WS-blocked
  network, or a drop — the subscription stays in a non-`live` status (so the
  consumer keeps polling) and runs a **capped-backoff reconnect in the
  background**, re-establishing the live augmentation the moment WS is reachable
  again. A runtime with no `WebSocket` signals "live unavailable" once and the
  consumer polls. Only a protocol bug (4400), a scope denial (4403), or
  exhausted auth stop the reconnect loop — and even those just leave the
  consumer on polling.
- **First-message auth handshake.** Browsers can't set headers on a WebSocket,
  so auth is the first frame (`{"type":"auth","token":"…"}`); the token is
  re-sent on the OPEN socket when it rotates (no reconnect, no re-snapshot).
- **Wire parity.** Payloads are byte-identical to what the SSE `data:` bodies
  carried (`upsert` / `remove`); the snapshot is chunked and accumulated until
  `done:true`, then emitted as the single `onSnapshot` the consumer expects.
- **Liveness.** Client-driven raw `"ping"` every ~30s, expecting `"pong"` (the
  DO's no-wake auto-response) or any frame within ~10s, else the socket is
  terminated and reconnected (fresh snapshot — the no-replay self-healing is
  preserved).
- **Close-code map:** 4400 protocol → terminal; 4401 unauthorized →
  refresh-once-then-reconnect; 4403 forbidden → terminal
  (`VaultPermissionError`); 4408 auth-timeout → reconnect.

BREAKING (pre-1.0, live-query API only): the `parseSSEStream`,
`startSubscription`, and `SSEEvent` exports are gone; `VaultClient.subscribe`'s
consumer surface (`onSnapshot`/`onUpsert`/`onRemove`/`onStatus`) is unchanged.

## [0.3.3-rc.1] - 2026-06-24

### Fixed

- **Token refresh is now single-flight ACROSS tabs (not just within one tab).**
  `refreshAccessToken`'s single-flight guard was per-tab only (an in-memory
  `refreshInFlight` map). Two browser tabs of the same surface each had their
  own guard, so both could POST the **same** stored refresh token: the hub
  rotates it for the winner, the loser replays the now-revoked token, the hub
  treats it as a stolen-token replay and **revokes the whole token family** →
  `invalid_grant` and a forced re-login across every tab.

  `refreshAccessToken` now serializes the exchange across tabs via the **Web
  Locks API** (lock name `parachute-refresh:<appName>:<vaultScope>`, scoped per
  surface AND per vault so unrelated refreshes never block each other). Once a
  tab holds the lock it **re-reads the persisted token**: if a sibling tab
  already rotated it (the stored refresh token differs, or the stored access
  token is now unexpired), the late tab **adopts the winner's freshly-stored
  token** and skips the network exchange entirely — no stale-token replay. Only
  when storage still shows the stale token does the actual token-endpoint
  exchange run.

  Where `navigator.locks` is unavailable (older browser, non-secure context,
  SSR) it **degrades gracefully** to the prior in-memory-only single-flight.
  The same-tab in-memory guard is retained as the fast path. Purely additive —
  no public-API changes; the `#139` terminal-`invalid_grant` recovery
  (clearToken + re-auth) is unchanged as the backstop.

## [0.3.2-rc.1] - 2026-06-23

### Fixed

- **Refresh-on-401 now RECOVERS from a terminal `invalid_grant` instead of
  looping.** The single-flight + cold-load refresh logic was correct, but the
  recovery path had a gap: when the hub returned `400 invalid_grant` for a
  **dead** refresh token (revoked, expired, or rotation-conflict / replay-
  detected), `refreshAccessToken` threw `RefreshHttpError` UNCAUGHT through
  `onAuthError`. The revoked token was left in storage, so every retry re-read
  and re-submitted the same dead token → an infinite "Token refresh failed
  (400) … try again" loop (observed in a real surface's session).

  Both the vault `onAuthError` seam (`getClient()`) and the `moduleAuth`
  `getAccessToken()` seam now wrap the refresh exchange: on a **terminal**
  failure (`400` + `invalid_grant` / revoked / expired / rotation-conflict)
  they **evict the dead token** (`oauth.clearToken(...)`) and return `null`.
  Returning null is already handled cleanly downstream — the `VaultClient` raises
  a `VaultAuthError` (no retry), and `getClient()` then returns `null`, so the
  surface falls to a fresh `login()` instead of spinning. **Non-terminal**
  failures (transient 5xx, network blips) still propagate unchanged, so a
  recoverable token is never thrown away.

  The single-flight guard and rotated-refresh persistence are unchanged. Purely
  additive to the public API — no signature changes.

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
