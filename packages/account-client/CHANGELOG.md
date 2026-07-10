# Changelog — @openparachute/account-client

## 0.1.0

Initial release — the client half of the Parachute account/door contract
(Phase-2 breakdown §1, CONCEPT-2 §7), built against the SPEC ahead of the door
servers (Hub H2 / Cloud C3).

- `AccountClient` against one `doorOrigin` (Hub self-hosted or Cloud hosted):
  - `discoverCapabilities()` — `GET /.well-known/parachute-account` (memoized).
  - `getAccountToken()` — the cookie→account-token mint (`POST /account/token`,
    credentials-include + `__csrf` double-submit body field). Held **in memory
    only** (never localStorage — F6); silent re-mint on near-expiry and once
    reactively on a 401.
  - `listVaults()`, `createVault()` (returns a ready vault token, with an
    empty-`vault_token` → per-vault-mint fallback for the Hub caveat),
    `deleteVault()` (`{ confirm }` retype), `mintVaultToken()`.
  - `getAccount()`, `getPlan()` (→ `null` on the honest 404), `openBilling()`.
- Structured error hierarchy mirroring surface-client's `VaultError`:
  `AccountError` → `AccountAuthError`/`AccountPermissionError`,
  `AccountUnreachableError`/`AccountServerError`, `VaultLimitError`,
  `AccountBadRequestError`, `AccountNotFoundError`, `AccountConflictError`,
  `AccountHttpError`.
- Zero runtime dependencies; `tsc` build; `bun test`; tag-triggered OIDC
  publish (`account-v*`).
