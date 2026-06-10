# @openparachute/surface-client

Browser-side library for building a **custom surface** over a [Parachute](https://parachute.computer) vault — OAuth (PKCE + Dynamic Client Registration), a typed vault REST client, token storage, and runtime-tenancy helpers. Framework-agnostic core: no React, just `fetch` + types.

A surface is any UI that talks to a vault — a daily-capture inbox, a project dashboard, a graph explorer. Without this library you re-implement OAuth, the vault client, token storage, and the core types from scratch (the real-world adopter `my-vault-ui` hand-rolled ~1,300 lines of exactly that). With it, the auth + data layer is one `import`.

```ts
import {
  ParachuteOAuth,
  VaultClient,
  discoverAuthServer, registerClient,
  loadToken, saveToken, clearToken,
  getMountBase, getTenantId, getHubOrigin, getVaultUrl,
  vaultIdFromUrl, normalizeVaultUrl,
} from "@openparachute/surface-client";
```

| Module                        | Surface                                                                          |
|-------------------------------|----------------------------------------------------------------------------------|
| `oauth`                       | `ParachuteOAuth` driver class — PKCE + same-hub auto-trust                        |
| `discovery`                   | `discoverAuthServer` (RFC 8414) + `registerClient` (RFC 7591 DCR)                |
| `vault-client`                | `VaultClient` REST client with auto-refresh on 401 + a typed error hierarchy     |
| `subscribe`                   | `VaultClient.subscribe()` — live-query SSE (snapshot + upsert/remove, auto-reconnect) |
| `notes-query`                 | `NotesQuery` typed query builder — `buildNotesQuery` serializes to vault's exact wire grammar |
| `token-storage`               | `loadToken` / `saveToken` / `clearToken` / `clearAllTokensForApp`                |
| `mount`                       | runtime-tenancy readers — `getMountBase` / `getTenantId` / `getHubOrigin` / `getVaultUrl` |
| `sw-reload`                   | `reloadAfterServiceWorkerUpdate` — PWA-mode SW reload helper                      |
| `vault-id`                    | `vaultIdFromUrl` / `normalizeVaultUrl` — canonical URL ↔ storage-key mapping      |
| `vault-types`                 | core resource types — `Note`, `NoteSummary`, `NoteLink`, `NoteAttachment`, `TagRecord`, … |

Everything is re-exported from the barrel (`@openparachute/surface-client`) and also available on named subpaths (`@openparachute/surface-client/oauth`, `…/vault-client`, `…/mount`, …) for tree-shaking when you only need one piece.

---

## Quick start — `createVaultSurface` (the one-liner path)

For the common case, you don't wire OAuth + `VaultClient` by hand at all. `createVaultSurface` is a turnkey factory that **auto-detects** whether you're hosted or standalone (see "Two deployment shapes" below), bakes sane defaults, runs Dynamic Client Registration for you when standalone, and hands back a `VaultClient` already wired with refresh-on-401:

```ts
import { createVaultSurface } from "@openparachute/surface-client";

// One call. clientName is the only required field — it's shown on the hub
// consent screen the first time the operator approves your surface.
const surface = createVaultSurface({ clientName: "My Vault UI" });

// On your callback route (default redirect URI: `${origin}/oauth/callback`):
if (location.pathname === "/oauth/callback") {
  await surface.handleCallback();      // exchanges code → token, persists it
  location.replace("/");
}

// Anywhere: get a ready VaultClient, or null if not signed in.
const vault = surface.getClient();
if (vault) {
  const notes = await vault.queryNotes({ tag: "x" });
} else {
  await surface.login();               // DCR-registers (standalone) + redirects to consent
}
```

The factory figures out the deployment shape, hub URL, redirect URI, scopes, and app name. Override any of them:

```ts
const surface = createVaultSurface({
  clientName: "My Vault UI",
  hubUrl: "https://my-hub.example.com", // default: parachute-hub meta tag, else window.location.origin
  vaultName: "default",                  // default: "default"
  scope: "vault:read vault:write",       // default
  redirectUri: `${origin}/oauth/callback`, // default per deployment shape
  bootstrap: "auto",                     // "hosted" | "dcr" | "auto" (default: detect from parachute-mount meta tag)
});
```

The returned `VaultSurface` is `{ oauth, bootstrap, hubUrl, vaultName, login(), handleCallback(), getClient(), logout() }`. `oauth` is the underlying `ParachuteOAuth` if you need to drop down to the low-level dance. Everything below this section is that low-level layer — reach for it when the factory's defaults don't fit.

---

## Two deployment shapes — read this first

How a surface bootstraps OAuth depends on **where it runs**. This is the single most important thing to get right.

### Standalone surface (the default for an external developer)

You serve your surface from anywhere — GitHub Pages, Netlify, `localhost:5173`, an S3 bucket. There is **no Parachute host** in front of it. This is the shape the [build-a-custom-surface onboarding prompt](https://parachute.computer) targets, and the one [`examples/standalone-spa`](./examples/standalone-spa) demonstrates end to end.

A standalone surface bootstraps its OAuth client with **RFC 7591 Dynamic Client Registration (DCR)**: it discovers the hub's authorization-server metadata, registers itself as a public (PKCE-only, no-secret) client at runtime with its own URL as the redirect URI, then drives the standard authorization-code + PKCE dance. The operator approves it once on the hub consent screen (or it auto-approves if the operator's hub session cookie is present — "same-hub auto-trust").

```ts
import {
  discoverAuthServer,
  registerClient,
  ParachuteOAuth,
} from "@openparachute/surface-client";

const HUB_URL = "https://my-hub.example.com"; // the operator pastes / configures this
const REDIRECT_URI = `${window.location.origin}/oauth/callback`;

// 1. Discover the hub's authorization-server metadata (RFC 8414).
const metadata = await discoverAuthServer(HUB_URL);

// 2. Register as a public client (RFC 7591 DCR). Cache the client_id
//    (e.g. in localStorage keyed by issuer + redirectUri) so you register
//    at most once per browser per hub — re-register only if the redirect
//    URI changes, since the hub binds client_id to redirect_uri.
const { client_id } = await registerClient(metadata.registration_endpoint, {
  clientName: "My Vault UI", // shown on the hub consent screen
  redirectUri: REDIRECT_URI,
});

// 3. Drive the dance with ParachuteOAuth, supplying the DCR client_id.
const oauth = new ParachuteOAuth({ appName: "my-vault-ui", hubUrl: HUB_URL });
oauth.useClientId({ client_id, scopes: ["vault:read", "vault:write"] });

const { authorizeUrl } = await oauth.beginFlow({
  vaultName: "default",
  redirectUri: REDIRECT_URI,
});
window.location.assign(authorizeUrl);

// 4. On the callback page (REDIRECT_URI):
const url = new URL(window.location.href);
await oauth.handleCallback(
  url.searchParams.get("code")!,
  url.searchParams.get("state")!,
  "default", // the storage-key segment for this token
);

// 5. Read the token + build a VaultClient (see "Using the vault" below).
```

> **Why not `getClientId()`?** `ParachuteOAuth.getClientId()` fetches a **hosted-only** endpoint (`/surface/<name>/oauth-client`) that only exists when a Parachute surface-host is serving your bundle. A standalone surface has no such endpoint — it must self-register via DCR as above. `useClientId(...)` lets you hand `ParachuteOAuth` the DCR-registered client so `beginFlow` / `handleCallback` / `refreshAccessToken` work without ever touching the hosted endpoint.

### Hosted surface (bundled under a Parachute surface-host)

If your bundle is served by `@openparachute/surface` under `/surface/<name>/` (the way [`@openparachute/notes-ui`](https://www.npmjs.com/package/@openparachute/notes-ui) ships), the host injects runtime-tenancy `<meta>` tags and exposes a per-surface OAuth-client endpoint. In that case you let `ParachuteOAuth` fetch the client_id for you — no DCR needed:

```ts
const oauth = new ParachuteOAuth({
  appName: "my-app",                 // matches the surface's manifest `name`
  hubUrl: getHubOrigin() ?? window.location.origin,
});

// Boot — read our client_id from the host:
await oauth.getClientId();

const { authorizeUrl } = await oauth.beginFlow({
  vaultName: "default",
  // default redirectUri is `${origin}/surface/<name>/oauth/callback`
});
window.location.assign(authorizeUrl);
// …handleCallback as above.
```

`getClientId()` succeeds only when the host endpoint exists. If you're not sure which shape you're in, the presence of a `parachute-mount` meta tag (see below) is the signal: present → hosted; absent → standalone.

> Prefer the [`createVaultSurface(...)` quick-start](#quick-start--createvaultsurface-the-one-liner-path) above — it collapses both bootstraps into one call with automatic hosted-vs-standalone detection. The hand-wired paths in this section are the low-level escape hatch for when the factory's defaults don't fit.

---

## Runtime-tenancy contract (`<meta>` tags)

A **hosted** surface-host injects structured environment metadata into every served `index.html`, and the `mount` helpers read it. These tags are a **hosted-surface feature** — a standalone surface has no host to inject them, so the readers return `null` off-host (by design; they never throw). Configure your vault URL + hub origin explicitly instead (a paste-in screen or build-time config), as the standalone example does.

The canonical injected shape:

```html
<head>
  <base href="/surface/<name>/">
  <meta name="parachute-mount"  content="/surface/<name>">      <!-- mount path -->
  <meta name="parachute-hub"    content="https://hub.example">  <!-- hub origin for OAuth discovery -->
  <meta name="parachute-vault"  content="/vault/<name>">        <!-- when the session is vault-bound -->
  <meta name="parachute-vault-origin" content="https://vault.example"> <!-- cloud / cross-origin only -->
</head>
```

| Helper           | Reads                                                    | Returns when absent | Suggested fallback |
|------------------|---------------------------------------------------------|---------------------|--------------------|
| `getMountBase()` | `parachute-mount` (trailing slash stripped, bare `/` rejected) | `null`        | `/notes` (legacy) or app boot error |
| `getTenantId()`  | last segment of `parachute-mount` (`/surface/<slug>`)   | `null`              | a stable label for storage keys |
| `getHubOrigin()` | `parachute-hub`                                         | `null`              | `window.location.origin` |
| `getVaultUrl()`  | `parachute-vault` (+ `parachute-vault-origin` for cross-origin) | `null`       | an explicit, operator-entered vault URL |

> **`getVaultUrl`, not `getVaultPath`; tenant-id is derived, not a tag.** The code exports **`getVaultUrl`** (it returns a fully-qualified URL — origin + path — so `fetch(getVaultUrl())` works directly) and **`getTenantId`** derives the tenant id from the mount path. There is **no** `getVaultPath` export and **no** `parachute-tenant-id` meta tag. (The `runtime-tenancy-contract.md` pattern doc previously named those; the code is the source of truth and the pattern doc was reconciled to match in the same change that shipped this README.)

---

## Using the vault

Once you have a stored token, build a `VaultClient`. Wire `onAuthError` so a 401 transparently refreshes:

```ts
const stored = oauth.getToken("default");
if (stored) {
  const vault = new VaultClient({
    vaultUrl: stored.vault
      ? `${HUB_URL}/vault/${stored.vault}`
      : `${HUB_URL}/vault/default`,
    accessToken: stored.accessToken,
    onAuthError: async () => {
      if (!stored.refreshToken) return null;
      const { token } = await oauth.refreshAccessToken(stored.refreshToken, "default");
      return token.access_token;
    },
  });
  const notes = await vault.queryNotes({ tag: "x" });
}
```

For scripts (Bun / Node), `VaultClient.fromHub({ hubOrigin, vaultName, token })` composes the canonical URL for you.

### Typed queries — `NotesQuery`

`queryNotes`, `queryNotesCursor`, and `subscribe` accept a typed `NotesQuery` object alongside the raw `URLSearchParams | Record<string,string>` forms (which remain fully supported — existing callers are untouched). The typed shape covers vault's structured-query grammar so you don't memorize the wire spelling:

```ts
const notes = await vault.queryNotes({
  tag: ["#work", "#decision"],          // comma-joined into one param (vault's grammar)
  tagMatch: "any",                       // → tag_match
  expand: "subtypes",                    // | "namespace" | "both" | "exact"
  excludeTag: "#archived",               // → exclude_tag
  pathPrefix: "Work/",                   // → path_prefix
  metadata: {
    status: { in: ["in-progress", "in-review"] },  // operator query → meta[status][in][]
    priority: "now",                               // scalar = shorthand equality → meta[priority]
  },
  date: { field: "updated_at", from: "2026-06-01" }, // half-open: from inclusive, to exclusive
  orderBy: "updated_at",
  sort: "desc",
  limit: 50,
});
```

Notes on the mapping (all pinned by tests against vault's parser):

- **Metadata scalar vs operator object.** A scalar (`priority: "now"`) is shorthand equality — a JSON scan that works on *non-indexed* fields. An operator object (`{ eq, ne, gt, gte, lt, lte, in, not_in, exists }`) routes through the indexed column — vault 400s with `FIELD_NOT_INDEXED` if the field isn't declared in a tag schema.
- **`date`** serializes to the canonical bracket bridge (`meta[updated_at][gte]=…`), never the deprecated flat `date_field`/`date_from` params. Bounds are half-open: `from` inclusive, `to` exclusive.
- **`search` / `near` are deliberately not modeled** — they're separate query shapes (and invalid for subscriptions). Use the raw forms for them. Unknown keys with string values pass through verbatim, so mixing typed keys with a raw `"meta[...]"` param also works.
- `buildNotesQuery(q)` / `toNotesSearchParams(input)` are exported if you want the `URLSearchParams` yourself.

### Live queries — `subscribe()`

Any view that polls `queryNotes` on a timer can subscribe instead. `VaultClient.subscribe()` opens vault's live-query SSE endpoint (`GET /api/subscribe`): you get one `onSnapshot(notes)` with the complete matching set, then `onUpsert(note)` / `onRemove(id)` as notes enter, change, or leave the set.

```ts
const unsubscribe = vault.subscribe(
  { tag: "#channel-message", "meta[channel][eq]": "general" },
  {
    onSnapshot: (notes) => render(notes),      // replaces your whole set
    onUpsert:   (note)  => upsertRow(note),
    onRemove:   (id)    => dropRow(id),         // idempotent — ignore unknown ids
    onStatus:   (s)     => setLive(s === "open"), // connecting | open | reconnecting | closed
    onError:    (err)   => console.warn(err),
  },
);
// later: unsubscribe();
```

Things worth knowing:

- **Query grammar is the same as `queryNotes`** (same server-side parser), except `search`, `near`, and `cursor` aren't live-evaluable — `subscribe()` throws on them synchronously rather than letting the vault 400.
- **The bearer rides the `Authorization` header, not the URL.** The transport is a `fetch` stream with hand-parsed SSE frames, *not* `EventSource` — `EventSource` can't set headers, which would force the token into a `?key=` query param (proxy logs, browser history). This also makes `subscribe()` work server-side (Bun/Node) where `EventSource` may not exist.
- **Reconnects are self-correcting.** Vault has no event replay; on reconnect (capped exponential backoff) the client re-subscribes and the fresh `onSnapshot` *replaces* your set, reconciling anything missed while disconnected. Treat every snapshot as the new truth, not a delta.
- **Token expiry is handled.** A 401 on (re)connect drives the client's `onAuthError` refresh seam once and resubscribes with the fresh token. If refresh isn't possible, the subscription terminates: `onError(VaultAuthError)` then `onStatus("closed")` — without a `"closed"`, it's still retrying.
- **Stop it** via the returned unsubscribe function or an `AbortSignal` (`subscribe(query, handlers, { signal })`).

### Don't redeclare the core types

`Note`, `NoteSummary`, `NoteLink`, `NoteAttachment`, `TagRecord`, `TagUpsertPayload`, `UpdateNotePayload`, `CreateNotePayload`, `FindPathResult` (and more) are exported from the barrel and match vault's wire format byte-for-byte. Import them rather than hand-redeclaring — that drift is exactly what this package exists to kill.

---

## Error handling

`VaultClient` rejects with a typed error hierarchy so you can map failures to UI affordances without string-matching messages. All concrete errors extend the abstract `VaultError`, so `catch (e) { if (e instanceof VaultError) … }` catches any vault failure.

```
VaultError                         (abstract base — "any vault error")
├── VaultAuthError                 401 — token dead/missing → start the OAuth flow
│   └── VaultPermissionError       403 — token lacks the scope → ask for a broader grant
├── VaultNotFoundError             404 — note / tag / path doesn't exist
├── VaultConflictError             409 — optimistic-concurrency / tag-in-use (see error.body)
├── VaultTargetExistsError         409 — create-would-clobber an existing path
├── VaultUnreachableError          network down (status 0) → "can't reach your hub" + retry
│   └── VaultServerError           5xx — hub is up but erroring → retry / report
└── VaultUploadError               attachment upload failed
```

Recommended UI mapping:

| Catch                       | What happened                       | Affordance |
|-----------------------------|-------------------------------------|------------|
| `VaultPermissionError`      | authed but wrong scope              | "This needs more access" → re-run `beginFlow` with the broader scope |
| `VaultAuthError`            | token expired / revoked             | bounce to sign-in (`beginFlow`) |
| `VaultNotFoundError`        | resource gone                       | inline "not found", offer to create |
| `VaultConflictError`        | concurrent edit / tag in use        | reload + show the conflict; `error.body` carries `referenced_by` for tag-in-use |
| `VaultTargetExistsError`    | path collision on create            | prompt for a new path |
| `VaultServerError`          | hub erroring (5xx)                  | "something went wrong on the hub" + retry |
| `VaultUnreachableError`     | network down                        | "can't reach your hub" + retry |
| `VaultUploadError`          | upload failed                       | retry the upload |

Because `VaultPermissionError extends VaultAuthError` and `VaultServerError extends VaultUnreachableError`, **order your `instanceof` checks specific-before-general** (check `VaultPermissionError` before `VaultAuthError`).

`ParachuteOAuth` adds three OAuth-flow errors: `PendingApprovalError` (the hub registered the client but needs operator approval — carries `approveUrl` for a "approve in your hub" CTA), `RefreshHttpError` (the hub rejected a refresh token — distinct from a network failure), and `InsecureContextError` (PKCE can't run outside a secure context — serve over HTTPS or `localhost`).

---

## Examples

- [`examples/standalone-spa`](./examples/standalone-spa) — a minimal, framework-free standalone surface that runs the full DCR bootstrap, the OAuth dance, and a vault query. Copy it as a starting point for a custom surface served from GitHub Pages or any static host.

---

## License

AGPL-3.0.
