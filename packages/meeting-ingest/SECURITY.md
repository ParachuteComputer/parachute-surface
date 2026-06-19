# Security — Meeting Ingest

This surface accepts an external webhook and writes to the vault. Its trust
model is small and deliberate.

## Actors & routes

| Route | Access | Auth |
|---|---|---|
| `POST /api/webhook/fireflies` | public | HMAC-SHA256 of the raw body (`x-hub-signature`) against `fireflies_webhook_secret`, constant-time |
| `GET /api/me` | public | none (session probe for the config page) |
| `GET /api/config-status` | operator | hub JWT (scope-guard) |

All routes ride the kit's deny-by-default gateway (`createSurfaceRouter`):
rate limit → actor resolution → access enforcement → handler. Undeclared
paths under the api namespace are 404. The gateway conformance suite
(`server/__tests__/conformance.test.ts`) pins anon-sees-nothing on the
operator route and deny-by-default.

## Webhook authentication

- The webhook is **public** (the hub forwards it without a hub identity)
  and **opts out of the cookie-origin CSRF check** (`originCheck: false`) —
  it carries its own HMAC, not a cookie. CSRF doesn't apply to a
  credential-less, signature-authed endpoint.
- The signature is verified over the **raw request body bytes**, read once
  and reused for both the HMAC and the JSON parse — so the bytes that are
  hashed are exactly the bytes that are parsed.
- The compare is **constant-time** (`crypto.timingSafeEqual` over the
  decoded digests, with a length guard).
- **No secret configured → 503**, never an accepted unsigned delivery.
  Missing/invalid signature → 401.

## Secret handling (hard invariants)

- `fireflies_api_key` and `fireflies_webhook_secret` are read **only** from
  the per-surface config file (`<state>/meeting-ingest.config.json`), via
  `ctx.config`. They are never taken from the request.
- Secrets are **never logged** (no info/warn/error line includes them — a
  test asserts this), **never written to a note**, and **never returned in
  a response** (`/api/config-status` reports booleans only; a test asserts
  the values don't appear).
- The transcript body is **never logged at info level**.

## Vault effect

- The surface's **only** write is a single `ctx.vault.createNote(...)` for
  a fresh meeting. It never updates or deletes notes, never writes tags or
  paths, never force-writes.
- The vault credential is the surface's host-custodied capability
  (`scopes_required: ["vault:default:write"]`); the backend never sees the
  bearer.
- Dedup by `external_id` makes ingestion **idempotent** — retried webhook
  deliveries do not create duplicate notes.

## Reporting

Report security issues per the repository's root policy.
