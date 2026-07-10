# @openparachute/account-client

Browser-side SDK for the **Parachute account/door contract** — the control
plane that sits above the per-vault data plane (`@openparachute/surface-client`).
One door answers at a `doorOrigin`: **Hub** (self-hosted) or **Cloud** (hosted).
Both speak the same `/account/*` wire contract; the SDK is door-agnostic and
reads a capability descriptor to know which features exist.

> Status: written against the SPEC (Phase-2 breakdown §1, CONCEPT-2 §7) ahead
> of the door servers (Hub H2 / Cloud C3). The methods, paths, headers, and
> bodies here ARE the contract those implementations must satisfy.

## Install

```sh
bun add @openparachute/account-client
```

Zero runtime dependencies. The app resolves the door origin (e.g. via
surface-client's `getHubOrigin()`) and passes it in — account-client stays
dependency-free so it never leaks a `workspace:` protocol into its manifest.

## Use

```ts
import { AccountClient } from "@openparachute/account-client";

const account = new AccountClient({
  doorOrigin: getHubOrigin() ?? window.location.origin,
  // The double-submit CSRF token for the mint, delivered out-of-band
  // (the CSRF cookie is HttpOnly). A string or an async getter.
  csrfToken: () => readCsrfToken(),
});

// 1. What can this door do?
const caps = await account.discoverCapabilities();
if (caps.features.vault_create) {
  /* show "New vault" */
}

// 2. Hold the account credential (in memory only; re-minted as needed).
await account.getAccountToken();

// 3. Drive the account.
const vaults = await account.listVaults();
const created = await account.createVault({ name: "field-notes" });
// created.vault_token lands the user IN the vault — no OAuth round-trip.

// 4. Per-vault token (the OAuth-redirect bypass).
const { vault_token } = await account.mintVaultToken("field-notes");

// 5. Capability-gated plan/billing.
const plan = await account.getPlan(); // null on a door without billing
if (caps.features.billing) {
  const { url } = await account.openBilling("checkout");
}
```

## The account credential (security)

`getAccountToken()` exchanges the same-origin session cookie for a short-TTL
account bearer (`POST /account/token`, cookie-authed + CSRF). That token is
**held in a private field and never written to `localStorage`** — a
non-negotiable invariant (an XSS foothold must not read account authority at
rest). The SDK silently re-mints on near-expiry and once reactively on a 401
while the cookie lives; when the cookie is gone the mint 401s and the caller
re-authenticates.

## Errors

Every failure is an `AccountError` subclass, mirroring surface-client's
`VaultError`. `catch (e instanceof AccountError)` catches anything the client
threw; branch on the concrete class (`AccountAuthError`,
`AccountPermissionError`, `VaultLimitError`, `AccountConflictError`,
`AccountNotFoundError`, `AccountBadRequestError`, `AccountUnreachableError`,
`AccountServerError`, `AccountHttpError`) or read `.code` for the door's
machine-readable reason (`vault_taken`, `vault_limit_reached`, …).

## License

AGPL-3.0
