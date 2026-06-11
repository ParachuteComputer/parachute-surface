# Security — Docs (docs-editor)

Filled from the kit's [`SECURITY.template.md`](../surface-server/SECURITY.template.md)
(spec §13). The Docs surface is the reference *invited, collaborative-write*
backed surface; this file states its trust posture as built (v1).

## The one rule

No actor without an explicit grant ever reads or alters a doc — and a
denied doc is byte-indistinguishable from a missing one, on the HTTP plane
and the WS plane, for every actor **including the operator** (notes outside
the working tag are refused identically to nonexistent ones).

## Threat-model summary

- **Assets:** note content under the working tag (`doc`), the backend's
  tag-scoped vault-write credential, live CRDT state (Y.Doc snapshots in
  the surface state store), grant notes under `surface-acl/docs`.
- **Actors:** anonymous internet (the surface declares `audience:
  "surface"` — the hub proxy passes visitors through), link-holding
  invitees (shareable capability links, single-use email-bound personal
  links), the hub-identified operator.
- **Entry points:** the HTTP gateway (`/api/me`, `/api/docs`,
  `/api/doc/:id`, `/api/collab/ticket`, `/api/shares`, the capability
  entry `/api/a/<token>`) and the collab WebSocket (`/surface/docs/ws`,
  ticket-authenticated).
- **Out of scope (substrate, inherited):** host containment (per-request
  timeout, error boundary, crash-loop quarantine), host-injected security
  headers/CSP, hub session auth and OAuth issuance, vault authentication.

## Credential posture

| Credential | Scope | Custody | Revocation |
|---|---|---|---|
| Hub-minted vault credential (`ctx.vault`) | Read/write on the working tag (`doc`) **and** `surface-acl/docs` only — declared in meta.json `required_schema`; never the whole vault | Injected by the host via `SurfaceHostContext`; the backend never serializes it | Hub credential revocation / surface uninstall |
| Per-surface token-signing secret (32 random bytes) | Signs capability/personal-link tokens for THIS surface only | Surface state store (`ctx.store`, SQLite) — deleted with the surface, never in the vault | Delete the surface (or the `auth/secret` record); all outstanding links die |

The operator authenticates **per-request** with a hub JWT — no
owner-passthrough credential exists in the backend.

## Audience plane

- Declared tier: `surface` — backend-owned admission. Share links must
  work for invitees with no hub identity, so the backend's own link auth
  is the gate.
- Hub-proxy gate: passes visitors through to the surface (the tier's
  contract); hub sessions/Bearers still resolve to the operator actor.
- Backend admission: hub JWT → operator; capability/personal link →
  entry exchange → httpOnly path-scoped cookie session; everyone else is
  `anon` and sees nothing (deny-by-default router).
- Minimum hub version: **0.7.1** (older hubs reject the `surface`
  audience at manifest validation and drop the mount).

## Working scope

Every note-kind read and write resolves through the working-tag resolver
(`doc`, `working_tag` config): missing and untagged notes produce the
byte-identical `not_found` for every actor, operator included. Enforced at
HTTP note reads, share minting, and WS `onAuthenticate`. Out-of-scope
notes are refused outright because the tag-scoped reconciler does not
track them — admitting them would silently drop collab edits on the next
vault snapshot (the edit-loss class the refusal exists to prevent).
Grant records live in `surface-acl/docs`; revocation = deleting the grant
note, which also terminates live WS sessions for the revoked subject.

## Actor table

Pinned by the kit's gateway conformance suite
(`@openparachute/surface-server/conformance`, registered in
`server/__tests__/`) plus the surface's own suites.

| Actor | Can | Cannot | Pinned by |
|---|---|---|---|
| anonymous | `GET /api/me` (sees `{kind:"anon"}`), exchange a valid entry token | List, read, or edit any doc; reach any undeclared route | `conformance: anon-sees-nothing — …`, `conformance: deny-by-default — …` |
| link-holder (view) | Read granted docs over REST + WS | Edit (engine-structural readOnly on the WS), read ungranted or missing docs (same 404, no existence oracle), mutate via cookie without a same-origin `Origin` header, touch tags/paths | `conformance: actor[N] allowed/denied — …`, `conformance: cookie mutation without same-origin Origin is refused — …` |
| link-holder (edit) | Collaboratively edit granted docs via the WS (the ONLY content-write path) | Mint shares, create docs, edit via REST, reach docs beyond its grants | grant-enforcement + collab-loop suites |
| operator (hub JWT) | Create docs, read/edit any doc *in the working tag*, mint + revoke shares | Read or edit notes **outside** the working tag (refused as `not_found`) | `doc read refuses notes OUTSIDE the working tag — even for the operator` |

`comment`/`suggest` grant levels exist in the schema but behave as
read-only in v1 (forward-compat, not reachable privilege).

## Secrets table

| Secret | Born | Lives | Travels | Dies |
|---|---|---|---|---|
| Capability token (`cap_<id>.<sig>`) | Share mint (`POST /api/shares`) | **Not stored** — verified by HMAC recompute against the signing secret; only the mint record (id, expiry, revocation state) persists in `ctx.store` | Entry URL once (302 strips it from `Location`), or `Authorization: Capability` | Revocation (grant-note delete), expiry |
| Personal-link token (`lnk_<id>.<sig>`) | Share mint (email-bound) | Same as capability — mint record only, single-use exchange state | Entry URL once | Single-use exchange, revocation, expiry |
| Session cookie | Entry-token exchange | Session record in `ctx.store`; cookie is httpOnly, `SameSite=Lax`, path-scoped to the surface mount | Cookie header, same origin only | Session expiry/revocation; surface delete |
| Collab WS ticket | `POST /api/collab/ticket` (full gateway actor resolution) | In-memory only (restart invalidates) | The Hocuspocus `token` field, once | Single-use redeem; 60s TTL |
| Hub JWT (operator) | Hub OAuth | Never persisted by the backend; per-request `Authorization` | HTTP only — **never crosses the WS** (tickets exist for exactly this) | Hub token lifetime |

## Residual risks

- **Capability links are bearer instruments.** Anyone holding the URL is
  the audience. v1 ships no outbound email — links render inline for the
  operator to deliver over a channel they trust; that channel's
  confidentiality bounds the link's.
- **Live-session revocation sweep is fail-open on transient vault
  errors** (deliberate: a vault blip shouldn't kill every live editing
  session). The HTTP plane stays fail-closed; the next successful sweep
  or reconnect re-enforces, so the exposure is a bounded window of an
  already-granted live session continuing.
- **In-process backend (isolation ladder v1).** The host's containment
  bounds accidents, not a hostile build of this package — the install
  trust act prices that (host charter, design §11). Install from the
  release tarball this repo's workflow builds and validates.

## Reporting

Report vulnerabilities privately to the maintainer at
**ag@unforced.org** (do not open a public issue with exploit details).
You should receive an acknowledgment within a few days.
