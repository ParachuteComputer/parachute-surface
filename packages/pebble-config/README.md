# @openparachute/pebble-config

A tiny hosted **Pebble watch config** surface for [parachute-surface][surface]. It
lets the [Pebble watch app][pebble] connect to a Parachute vault using the hub's
OAuth 2.1 + PKCE flow — so the watch holds a scoped, refreshable vault token
instead of a hand-pasted one.

[surface]: https://github.com/ParachuteComputer/parachute-surface
[pebble]: https://github.com/ParachuteComputer/parachute-pebble

## Why

The Pebble phone app opens a config webview. Today that's a paste-a-token screen.
A webview is a real browser in a secure context, so it can run the same OAuth
dance every other Parachute surface uses. This surface is the hosted page that
dance runs on.

## The flow

1. The Pebble app's embedded config page collects **only the hub origin**, then
   redirects the browser to this hosted page:

   ```
   <hub>/surface/pebble-config/?return_to=<encoded>&current=<encoded-json>
   ```

   - `return_to` — where to send the result. Defaults to `pebblejs://close#`
     when absent (closes the Pebble webview, handing the payload back).
   - `current` — optional URL-encoded JSON prefill:
     `{ hub, vault, quicklogs: [{ label, text }] }`.

2. The page runs the **hosted** OAuth bootstrap via
   [`@openparachute/surface-client`][client]'s `ParachuteOAuth`: it fetches its
   DCR-registered `client_id` from `GET /surface/pebble-config/oauth-client`
   (an endpoint the surface-host exposes), runs RFC 8414 discovery + PKCE, and
   requests a `vault:<vault>:write` scope for the chosen vault (default
   `default`). The OAuth callback lands back on this same page
   (`/surface/pebble-config/oauth/callback`, SPA-fallback-served), where the
   code→token exchange completes.

3. After auth it shows a **quick-logs editor** — a textarea, one
   `Label | note text` per line, prefilled from `current.quicklogs`.

4. **Save** navigates back to the Pebble app:

   ```
   return_to + encodeURIComponent(JSON.stringify(payload))
   ```

   where `payload` is:

   ```jsonc
   {
     "hub": "<this page's hub origin>",
     "vault": "<chosen vault, default 'default'>",
     "token": "<access_token>",
     "refresh_token": "<refresh_token, '' if none>",
     "token_endpoint": "<from RFC 8414 discovery>",
     "client_id": "<DCR client_id from /oauth-client>",
     "quicklogs": [{ "label": "...", "text": "..." }]
   }
   ```

   The watch persists this and uses `token` (rotating it via `refresh_token` +
   `token_endpoint` + `client_id` when it expires) to write captures into
   `<hub>/vault/<vault>/api/...`.

`return_to` and `current` are persisted in `sessionStorage` so they survive the
OAuth redirect round-trip.

[client]: https://www.npmjs.com/package/@openparachute/surface-client

## What's in the box

`dist/` is the built bundle — a single `index.html` + `main.js` (the
surface-client library inlined) + `style.css` + `icon.svg`. No PWA, no service
worker, no framework. Built with `Bun.build`; assets are referenced with
relative `./` URLs so the host's injected `<base href="/surface/pebble-config/">`
resolves them at whatever mount the operator runs.

## Install via parachute-surface

```
parachute-surface add @openparachute/pebble-config --name pebble-config --path /surface/pebble-config
```

## Develop

```
bun run build       # bundle → dist/
bun test            # pure-function unit tests (parsing, payload, escaping)
bun run typecheck
```

## License

AGPL-3.0.
