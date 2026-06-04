# Changelog — @openparachute/pebble-config

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
