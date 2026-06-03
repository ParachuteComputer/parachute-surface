# Standalone surface example

A minimal, **framework-free** Parachute surface that runs the full standalone
bootstrap against any Parachute hub:

1. **Discover** the hub's authorization-server metadata (RFC 8414).
2. **Register** itself as a public OAuth client via Dynamic Client
   Registration (RFC 7591) — caching the `client_id` per (issuer, redirectUri)
   so it registers at most once per browser.
3. **Authorize** with the standard authorization-code + PKCE dance, driven by
   `ParachuteOAuth` (seeded with the DCR `client_id` via `useClientId`, so the
   hosted-only `/surface/<name>/oauth-client` endpoint is never touched).
4. **Query** the vault with `VaultClient`, refreshing the token on a 401.

This is the path an external developer takes when serving a custom surface
from GitHub Pages, Netlify, an S3 bucket, or `localhost`. There is no
Parachute surface-host in front of it, so it configures the hub URL + vault
name explicitly (the operator pastes the hub URL) rather than reading the
host-injected `<meta>` tenancy tags.

## Files

- [`app.ts`](./app.ts) — the entire surface in one file. Every line that talks
  to Parachute uses `@openparachute/surface-client`; nothing is hand-rolled.
- [`index.html`](./index.html) — the shell + the OAuth-callback handling.

## Running it

This is intentionally dependency-light reference code, not a built app. To run
it for real:

1. Bundle `app.ts` with any ESM bundler (esbuild / Vite / `bun build`),
   resolving `@openparachute/surface-client` from npm.
2. Serve `index.html` + the bundle over **HTTPS or `http://localhost`** —
   PKCE needs a secure context (`crypto.subtle`), so plain-HTTP LAN IPs throw
   `InsecureContextError`.
3. Open it, paste your hub URL, and sign in. The hub shows a consent screen
   for the DCR-registered client the first time (or auto-approves if your hub
   session cookie is present — "same-hub auto-trust").

The redirect URI registered via DCR is `${origin}/oauth/callback`. If you
serve under a sub-path (e.g. GitHub Pages project sites), adjust
`REDIRECT_URI` in `app.ts` to match your deployed base — the hub binds the
`client_id` to the exact redirect URI.
