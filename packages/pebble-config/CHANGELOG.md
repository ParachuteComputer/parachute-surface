# Changelog — @openparachute/pebble-config

## Unreleased

- **Fix (#81): authenticate via the standard runtime DCR flow.** The connect
  flow now self-registers a fresh OAuth client at runtime from the browser via
  RFC 7591 Dynamic Client Registration (`discoverAuthServer` + `registerClient`
  from `@openparachute/surface-client`) — the same path Notes / My Vault UI /
  Paraclaw use — with the redirect URI built from the page's OWN origin and the
  standard `/oauth/callback` (slash) path. Replaces the previous dependency on
  the host's add-time `GET /surface/pebble-config/oauth-client` record, whose
  `redirect_uris` were pinned to the daemon's loopback origin and used a
  divergent `oauth-callback` (dash) path — which the hub's (correct) exact-match
  redirect validation rejected for any remotely-served install. The returned
  `client_id` in the payload is now the runtime-registered id; the watch's
  refresh story is unchanged (hub's refresh path is identical for any approved
  public client).

## 0.1.0

Initial release.

- Hosted Pebble watch config surface mounted at `/surface/pebble-config`.
- Runs the hub's OAuth 2.1 + PKCE flow via `@openparachute/surface-client`
  (hosted bootstrap — `client_id` from `GET /surface/pebble-config/oauth-client`),
  requesting a `vault:<vault>:write` scope for the chosen vault.
- Reads `return_to` + `current` query params, persists them across the OAuth
  redirect round-trip in `sessionStorage`.
- Quick-logs editor (`Label | note text` per line), prefilled from
  `current.quicklogs`.
- Save returns `{ hub, vault, token, refresh_token, token_endpoint, client_id,
  quicklogs }` to the Pebble app via `return_to + encodeURIComponent(JSON…)`;
  `return_to` defaults to `pebblejs://close#`.
- Declares `required_schema` for `capture` / `capture/text` / `capture/voice`
  to keep tag-schema provisioning consistent with notes-ui.
- Tiny vanilla-TS bundle (no framework, no PWA), built with `Bun.build`.
