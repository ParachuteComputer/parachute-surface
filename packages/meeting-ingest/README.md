# @openparachute/meeting-ingest

**Meeting Ingest** — a backed Parachute surface that turns a meeting
provider's "Transcription complete" webhook into a `#meeting` note in your
vault, server-side. Connect Fireflies.ai once and every recorded meeting
files itself automatically.

Provider today: **Fireflies.ai**. The surface is structured so a second
provider (Read.ai) can be added later as `/api/webhook/readai` — one
webhook route per provider, sharing the transform + note write.

## What it does

When a meeting finishes transcribing, the provider POSTs a small webhook
(no transcript body). The surface:

1. **Verifies** the webhook's HMAC-SHA256 signature (`x-hub-signature`)
   against your shared secret — constant-time, over the raw body.
2. **Dedups** by `external_id` (`fireflies:<meetingId>`) so retried
   deliveries don't create duplicate notes.
3. **Fetches** the full transcript from the provider's GraphQL API
   (`Authorization: Bearer <api_key>`).
4. **Transforms** it into a portable-markdown `#meeting` note (title,
   metadata line, optional summary, then the speaker-attributed
   transcript).
5. **Writes** one note via the surface's bound vault credential.

## Shape

```
meta.json                  audience: surface · server.entry: server/index.bundle.js
server/index.ts            createBackend(ctx) — auth + router wiring
server/routes.ts           /api/me · /api/config-status · /api/webhook/:provider
server/transform.ts        MeetingTranscript → markdown body + note metadata
server/providers/types.ts  MeetingProvider interface (provider-agnostic)
server/providers/fireflies.ts  HMAC verify · event parse · GraphQL transcript fetch
web/                       a static operator setup/status page (no framework)
```

- **Webhook route is public + HMAC-authed.** `POST {mount}/api/webhook/fireflies`
  declares `access: { kind: "public" }` and `originCheck: false` — it's an
  external webhook carrying its own signature, not a cookie session.
- **Operator-only status.** `GET /api/config-status` (hub JWT) reports
  WHICH keys are set (booleans only) — never the secret values.
- **Markdown persistence only.** Notes are plain portable markdown; the
  structured handles ride note metadata (`source`, `external_id`,
  `held_on`, …).

## Operator setup (Fireflies.ai)

1. **Create a Fireflies API key** — Fireflies → Settings → Developer →
   API key.

2. **Write the surface config file** at
   `$PARACHUTE_HOME/surface/state/meeting-ingest.config.json`
   (default `~/.parachute/surface/state/meeting-ingest.config.json`).
   Choose a long random shared secret for the webhook:

   ```json
   {
     "fireflies_api_key": "<your Fireflies API key>",
     "fireflies_webhook_secret": "<a long random shared secret>",
     "tag": "meeting"
   }
   ```

   `tag` is optional (default `"meeting"`). **Lock the file down** —
   it holds secrets:

   ```sh
   chmod 600 ~/.parachute/surface/state/meeting-ingest.config.json
   ```

   The host re-reads this file per request, so an edit takes effect
   without a remount (the secrets are never cached in the backend).

3. **Set the Fireflies webhook** — Fireflies → Settings → Developer →
   Webhooks:
   - **URL:** `<your-hub-origin>/surface/meeting-ingest/api/webhook/fireflies`
   - **Secret:** the same value as `fireflies_webhook_secret` above.

4. **Install + restart.** Add the surface in the Surface admin (Add
   surface → release-tag URL), then `parachute restart surface`.

5. **Verify.** Open the surface page (`/surface/meeting-ingest/`) signed
   in as the operator — the status panel shows ✓ for the API key and
   webhook secret. Record a test meeting; when it finishes transcribing,
   a `#meeting` note appears in the vault.

### Responses (for debugging webhook delivery)

| Situation | Status |
|---|---|
| Ingested (new meeting) | `201 { ok, note_id }` |
| Already ingested (retry) | `200 { ok, deduped }` |
| Benign event (not transcription-complete / no meetingId) | `200 { ok, ignored }` |
| Missing / invalid signature | `401` |
| No webhook secret configured | `503 not_configured` |
| Transcript fetch failed (provider retries) | `502` |

## Install

This package is `private: true` — it never publishes to npm. The
distribution is the GitHub release tarball attached by this repo's release
workflow on `meeting-ingest-v*` tags (layout: `package/` → `meta.json` +
`dist/` + `server/index.bundle.js`, the self-contained install shape).

**Requires hub ≥ the surface-audience tier** (hub#651, releases after hub
0.7.0) — this surface declares `audience: "surface"` (the backend owns
admission; the hub passes the webhook through to the backend's HMAC
check). On an older hub, manifest validation drops the row and the mount
404s.

## Development

`bun run build` produces BOTH artifacts: the web bundle (`dist/`, via
Vite) and the server bundle (`server/index.bundle.js`, via
`bun build --target=bun`). The host mounts the bundle named by meta.json,
not the TS sources — after changing anything under `server/`, re-run
`bun run build` (or `bun run build:server`) before reloading the surface.
Both artifacts are gitignored (generated); `package.json#files` ships
them in the release tarball.

## Tests

`bun test packages/meeting-ingest/server/` (or `bun run test:meeting-ingest`
from the repo root): HMAC verification (valid / invalid / missing /
no-secret), payload classification, dedup idempotency, transcript-fetch
failure mapping, the full transcript → note transform, secret hygiene,
and the kit's public gateway conformance suite.

## Security

See [SECURITY.md](./SECURITY.md). In short: secrets live only in the
config file — never logged, never written to a note, never returned in a
response; the only vault effect is the single `createNote` on a fresh
meeting.
