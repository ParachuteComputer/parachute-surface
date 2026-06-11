# The Surface Runtime — primitives for backed surfaces

**Status:** design (2026-06-10). The build spec for the surface-evolution arc.
**Companion pattern:** [`parachute-patterns/patterns/backed-surface.md`](../../parachute-patterns/patterns/backed-surface.md) (the shape) — this doc is the *how*.
**Grounding:** 4-target research fan-out + a 5-lens engineering adjudication of
Prism (Benjamin's proving implementation — 13 reject / 15 modify / 12 keep
verdicts, every one on engineering merit per Aaron's direction: "check many of
his assumptions, take what worked, bring it through in the right way").

## What this is

The Surface module becomes **the runtime for all surfaces — static and
backed**. A surface package may ship a `server` entry; surface-host mounts it
**in-process** under that surface's namespace. One daemon, one port, one
hub-supervised process (the channel precedent: one module, many named
instances, per-instance credentials). The primitives below are the product;
two demos prove them across the design space:

- **woven-boulder** — public/anonymous, read-mostly, *projection-hard*: a live
  site over the Boulder-politics vault with named pass-through APIs and a
  domain-vocabulary MCP. No vault token anywhere near a browser.
- **the collaborative docs editor** — invited audience, collaborative-write,
  *reconciliation-hard*: TipTap + Yjs, markdown-canonical, capability share
  links.

## The decided trust architecture (adjudication headlines)

**1. No owner-passthrough — the hybrid.** Prism routes its owner through the
backend's full-vault proxy; the adjudication's core finding is that this
*forces* the credential design: a passthrough owner experience is only as wide
as the standing credential, which is why Prism had to mint year-long
`vault:default:write`. In our ecosystem the operator already has a first-class
browser path (surface-client hosted-mode hub OAuth → `/vault/<name>/api/*`,
15-min JWTs + rotating refresh). So:

- **Operator vault data path = direct.** Hub OAuth in the browser, exactly
  like every static surface. Zero backend involvement.
- **The backend serves only:** audience routes (deny-by-default gateway), the
  collab WebSocket, and operator *surface-domain* ops (grants, links, invites,
  surface config) — authenticated per-request by **hub JWT Bearer** validated
  via scope-guard (the backend is a resource server, like vault).
- The backend ships **no generic vault proxy**, holds **no operator session**,
  and its credential is minted at exactly the surface's working-tag scope.
- Consequence: audience-plane compromise concedes audience grants — never a
  vault credential. Backend-down degrades the audience, not the operator.

**2. Operator identity = hub, everywhere.** No app-plane owner row, no
magic-link bootstrap, no `COLLAB_TOKEN` side-channel (all three rejected —
shadow identity the boundary charter exists to prevent). The owner joins a
live collab session by presenting their hub JWT on the WS connect; one
**unified connection authorizer** serves HTTP and WS.

**3. Audience identity = the surface's, and v1 is link-shaped.** Audience
password accounts are *deferred*, not built: v1 ships **capability links**
(anonymous bearer of a grant id — Prism's HMAC core kept verbatim) plus
**personal links** (the same machinery bound to an email subject, single-use
exchange into a session; re-issue = the recovery flow). No password endpoints
in v1; the schema leaves room (nullable `password_hash`) so passwords/passkeys
are a v2 feature-add, not a migration.

**4. Capability transport hardened.** The raw token rides only the *entry*
URL: `GET /surface/<name>/a/<token>` verifies, creates a link-session, sets an
httpOnly `SameSite=Lax` cookie **path-scoped to `/surface/<name>/`**, and 302s
to a clean URL. Browsers thereafter use the cookie; programmatic clients use
`Authorization: Capability <token>`. No bearer lingering in history/logs.

**5. GrantStore is interface-first; the backing store is decided in R4
(Aaron, 2026-06-10: "let the build decide").** Two specced implementations
behind one `GrantStore` interface: (a) **vault-native** — grants + capability
metadata as vault notes tagged `surface-acl/<surface>` with indexed metadata
(`subject_type, subject, resource_type, resource, level, expires_at`),
SSE-fed in-memory enforcement cache (per-request resolution never round-trips
the vault; revocation = delete the note, propagates live) — inspectable,
synced, agent-visible, reinstall-surviving; (b) **app-side SQLite** (Prism's
shape) — private, simpler, invisible to governance. The adjudication leans
(a); R4 picks with real ergonomics in hand. Sessions/caches stay app-side
either way (operational, not knowledge).

**6. Levels are grant vocabulary; ACTIONS are enforcement vocabulary.** The
`view < comment < suggest < edit` ladder stays as the wire format (`own` is
never grantable — operator is an actor-plane fact). Enforcement happens via
`can(actor, note, action)` with an action enum (`read, comment, suggest,
edit_content, manage_grants, manage_tags, manage_path, …`) so future grant
kinds don't break rank-math call sites. Non-owner `path`/`tags` writes are
denied by the kit (tags are the sharing scope — writing them is privilege
escalation).

**7. Collab enforcement is structural, not semantic.** Validating a CRDT
update stream semantically is not a buildable guarantee. The buildable shape:
**privilege-decomposed Yjs docs** — `<noteId>` (write at edit+),
`<noteId>#comments` (write at comment+ — fixes Prism's dropped-comments
incoherence), and suggest as propose-a-revision (a writable fork doc + an
owner-side accept/merge API) in v1; per-actor overlay docs with
`Y.RelativePosition` anchoring is the tracked v2 for inline track-changes.

**8. Markdown-canonical, one codec.** HTML persistence rejected. A `doc-schema`
package exports the TipTap extension list AND the markdown codec
(`markdownToDoc`/`docToMarkdown` on prosemirror-markdown over the shared
schema) — schema and serialization versioned together, imported isomorphically
by browser and server (no happy-dom server-side; only JSON↔markdown needed).
The lossiness contract is explicit and test-pinned (headings/lists/tasks/code
survive; comment anchors ride W3C TextQuoteSelector metadata, not content).
`meta.server.format: "markdown" | "opaque"`; opaque formats (Excalidraw
scenes) must mark the note's format in metadata.

**9. The corrected reconciliation machine.** Keep Prism's load-bearing rules
(documentName = note id; vault-as-source-of-truth; external-edit-wins;
populated re-seed guard). Replace both bug paths: writebacks send
`if_updated_at` with the tracked `updatedAt` **string verbatim** (never
force-by-default); 409 → fetch winner → re-seed into the live Y.Doc in one
transaction; the **external-edit signal is the vault SSE subscription** on the
surface's working tag (not load-time comparison). Remaining failure windows
(deltas between external commit and re-seed) are documented properties of the
machine, written once.

**10. Trust signals come from the substrate.** Header-absence local-trust
rejected. The hub proxy stamps `X-Parachute-Layer` (loopback|tailnet|public,
from `layerOf`, fail-closed) + `X-Parachute-Client-IP` on forwarded requests,
**stripping inbound occurrences at the public edge**. Backends read
`ctx.layer`/`ctx.clientIp` — never raw headers; the kit ships no `isLocal()`.

**11. Isolation ladder (Workers rejected).** Bun Workers don't provide real
memory isolation and busy-loop termination is experimental — they're off the
ladder so nobody builds on isolation that doesn't exist. v1: in-process with
**non-optional host containment middleware** (per-request timeout ~30s
tunable, error boundary — a throwing backend 500s *that surface* only, no
stack leak; crash-loop counter → `backend-disabled` quarantine with the static
bundle still serving; hub supervisor crash-restart as the outer net). The
honest charter line stands: a malicious backend can still hard-kill the
daemon; the install trust act prices that. Tracked, demand-gated: per-surface
supervised process under the **hub** supervisor (never a second supervisor)
for surfaces declaring an isolation requirement.

**12. Audience exposure becomes real (fixes parachute-surface#88).**
`meta.json` `public: boolean` → `audience: 'public' | 'hub-users' |
'operator'` (default `hub-users`; boolean = legacy alias). Transported via
`uis{}` → hub `UiSubUnit`; **enforced at the hub proxy** before forwarding:
`public` passes (chrome strip off), `hub-users` requires a valid hub session
OR a hub-issued Bearer for the surface's scopes (the OR keeps installed PWAs
working), `operator` requires the first admin. Fail-closed.

**13. Security headers host-injected.** CSP (`script-src 'self'`-class) + the
full header set on every backed-surface response, host-injected with a
declared per-surface override in meta.json — the load-bearing same-origin
mitigation while public surfaces share the hub origin. Long-term tracked:
separate-origin hosting for public surfaces (cloudflared multi-hostname
supports it; tailnet funnel cannot — design when demanded). A
`SECURITY.template.md` scaffold ships with the kit (one-rule statement, actor
table generated from gateway conformance tests, secrets table, residual
risks).

## The primitives

### Host-side (surface-host)

**P1 — `meta.json` `server` block + entry contract.**
```jsonc
// .parachute/meta.json additions
"server": {
  "entry": "server/index.js",
  "format": "markdown",            // | "opaque"
  "capabilities": ["websocket"],   // declared, host-gated
  "timeoutMs": 30000               // containment override (bounded)
}
```
```ts
// the server entry's default export — framework-agnostic, no module side effects
export default function createBackend(ctx: SurfaceHostContext): SurfaceBackend;
interface SurfaceBackend {
  fetch(req: Request): Response | Promise<Response>;     // web-standard
  websocket?: BackendWebSocketHandlers;                  // iff capability declared
  shutdown?(): Promise<void>;                            // bounded (~5s), awaited on unmount
}
```

**P2 — `SurfaceHostContext` (the keystone injection).** Capability, never
secret:
```ts
interface SurfaceHostContext {
  vault: ScopedVaultClient;        // pre-authenticated, tag-scope-bound; NO token accessor
  store: SurfaceStateStore;        // per-surface SQLite namespace, deleted on removal
  subscribe: VaultSubscribe;       // SSE live-query bound to the surface credential
  layer(req: Request): 'loopback'|'tailnet'|'public';   // substrate-stamped
  clientIp(req: Request): string | null;
  config: SurfaceConfigAccess;     // the surface's own config (admin-editable)
  log: SurfaceLogger;              // flows to the supervisor log stream
  mount: string;                   // "/surface/<name>"
  shutdownSignal: AbortSignal;
}
```
`ScopedVaultClient` is built on surface-client's existing `fromHub` +
`tokenProvider` server path; the token-bearing closure lives host-side.
`force` is rejected unless constructed with explicit `allowForce` (the kit
never sets it).

**P3 — credential custody + renewal.** The credential connection's token
lands in surface-host's per-surface store (`.credential.json`, 0600 —
channels.json discipline), renewed host-side against the hub before expiry,
revoked in the removal cascade. Backends cannot read it.

**P4 — routing + WS multiplexing (structural containment).** The host
forwards exactly two namespaces to a backend: `${mount}/api/*` and
`${mount}/ws`. Static `dist/`, `/oauth-client`, the admin SPA, sibling
surfaces are unreachable from a backend's router *by construction*. Bun-native
WebSockets pump messages into the backend's handlers (Hocuspocus's
transport-agnostic mode — proven by Prism's own manual pumping).

**P5 — BackendSupervisor (mount lifecycle + fault containment).** Mount on
add/boot under try/catch (factory failure → status `backend-error`, bundle
still serves); per-request timeout + error boundary; crash-loop →
`backend-disabled` (503 + admin surfacing) until reload; real per-surface
health at last (replacing hardcoded `"active"`); dev-mode reload.

**P6 — host-injected security headers** (P13 above) + the audience gate
transport (P12 — enforcement is hub-side).

### Kit-side (`@openparachute/surface-server` — a library, not a host object)

**P7 — `createSurfaceAuth`**: `resolveActor()` (hub-JWT operator branch via
scope-guard · capability/link-session branch · anon), the AudienceStore
(subjects, sessions, personal links), capability mint/verify/exchange, Origin
middleware default-on for cookie mutations, rate-limit middleware (fail-closed
keying off `ctx.clientIp`).

**P8 — `SurfaceAuthz`**: `can(actor, note, action)`, the GrantStore
(vault-native notes + SSE-fed cache), level→action table, the deny-by-default
router with **conformance tests** (anon-sees-nothing, leak conditions,
path/tag locks) any surface can run against its own routes.

**P9 — projection layer** (the woven-boulder primitive): declare domain
queries once —
```ts
defineProjection({
  name: 'upcomingMeetings',
  params: { from: 'date?', body: 'string?' },
  query: (p) => ({ tag: 'meeting', meta: { date: { gte: p.from ?? today() } } }),
  shape: (note) => ({ title, date: note.metadata.date, summary, body }),
  describe: 'Upcoming public meetings, soonest first.',
})
```
→ the kit derives BOTH the REST endpoint (`GET ${mount}/api/upcoming-meetings`,
audience-gated) AND an **MCP tool** on a per-surface Streamable-HTTP endpoint
(`${mount}/api/mcp` — canonical per #104, since the host forwards only
`${mount}/api/*`; channel's per-instance MCP endpoints are the in-house
precedent). One definition, two projections: browsers and AI clients both get
the domain vocabulary instead of tags/notes/links.

**P10 — `SurfaceStateStore` + `createVaultReconciler`**: the derived-state
store and the corrected reconciliation state machine (§9), exposing only
`serialize`/`seed` hooks + conflict events to surface authors.

### Package-side

**P11 — `doc-schema`** (isomorphic schema + markdown codec, §8) — the docs
surface's foundation, reusable by any rich-text surface.

## Hub work items (small, all substrate-true)

- **H1 — WebSocket upgrade bridge**: verified *not supported today* (the proxy
  is fetch-based). Bun.serve first-class WS + manifest-declared capability,
  deny-by-default on the route table.
- **H2 — `X-Parachute-Layer` / `X-Parachute-Client-IP` stamping** (+ inbound
  strip at the public edge).
- **H3 — the per-UI audience gate** in proxy dispatch (P12; fixes #88).
- **H4 — Connections engine `kind: "credential"`** (the credential connection:
  operator-approved, tag-scoped, registered, renewable, revoked on teardown —
  also unblocks runner's vault_token flow).
- H5 — chrome-strip exclusion rides the audience gate (public → off).

## Build plan

| Phase | What | Repo |
|---|---|---|
| **R1** | Hub substrate: H1–H5 (each small; H4 is the design's only new engine surface) | hub |
| **R2** | surface-client Tier 1 (from the my-vault-ui graduation): `subscribe()` fetch-stream SSE, typed query builder, links typing, cold-seed + single-flight auth fixes | parachute-surface |
| **R3** | The runtime: P1–P6 in surface-host + the admin revamp (channel-quality add-flow, per-surface health/status, DCR lifecycle fixes, audience field) | parachute-surface |
| **R4** | The kit: P7–P9 (`@openparachute/surface-server`) | parachute-surface |
| **R5 ∥ R6** | **Both demos in parallel** (Aaron, 2026-06-10): **woven-boulder** (public projection site + domain MCP — exercises P1–P9, no CRDT) and **the collaborative docs editor** (P10–P11, with Benjamin) | new surface packages |

Sequencing logic: the runtime + kit (R3/R4) land first; the two demos then
run as parallel streams — woven-boulder carries the public-exposure/
projection/MCP risk, the docs editor carries the CRDT/reconciliation/WS risk,
and neither blocks the other.

## Open questions (tracked into the build)

- ~~Hocuspocus v4 under Bun via manual pumping~~ **RESOLVED (2026-06-10,
  sandboxed spike): HOCUSPOCUS-VIABLE, high confidence.** @hocuspocus/server
  4.1.1 runs under Bun 1.3.13 on Bun.serve NATIVE WebSockets with manual
  pumping, zero shims — convergence verified 7/7, y-protocols-direct fallback
  NOT needed. One upstream double-`onDisconnect` bug ⇒ hook logic must be
  idempotent. Wiring contract + bug details in the appendix
  ([Resolved: Hocuspocus under Bun](#resolved-hocuspocus-under-bun)).
- ~~prosemirror-markdown `[` escaping vs `[[wikilinks]]`~~ **RESOLVED
  (2026-06-10): the serializer rule ships in `packages/doc-schema`** —
  `[[...]]` spans survive `docToMarkdown` verbatim while ordinary bracket
  text keeps its escaping; test-pinned (wikilinks adjacent to `[links](...)`,
  literal brackets, aliases) in
  `packages/doc-schema/src/__tests__/wikilinks.test.ts`.
- `aud` claim for hub JWTs presented to surface backends (v1 accepts
  `aud=vault.<name>` + `vault:<name>:write` for the owner branch; cleaner
  per-surface audience is an issuance evolution).
- read_tags ⊇ write_tags credential split (tag-scoped-tokens "future
  evolution") — would let read-wide/write-narrow surfaces hold one credential.
- Separate-origin public surfaces (cloudflared can, tailnet funnel can't) —
  design when demanded.
- Email for personal links: per module-credential-ownership the surface owns
  its outbound-email credential (operator-configured, optional — links render
  inline for copy-paste without it).

## Appendix

### Resolved: Hocuspocus under Bun

**Verdict (sandboxed spike, 2026-06-10): HOCUSPOCUS-VIABLE, high
confidence.** `@hocuspocus/server@4.1.1` works under Bun 1.3.13 with
Bun.serve **native** WebSockets and manual pumping — zero shims, no
y-protocols-direct fallback needed.

**The wiring contract.** Use the Hocuspocus **engine class** (NOT `Server` —
never `listen()`):

- `hocuspocus.handleConnection(ws, request)` from Bun's `open` handler. The
  expected `WebSocketLike` is `{ send, close, readyState }` — Bun's
  `ServerWebSocket` satisfies it directly (and is named in the v4
  doc-comment).
- `conn.handleMessage(view)` from Bun's `message` handler, where `view` is an
  **exact-bounds `Uint8Array` view** over the incoming Buffer.
- `conn.handleClose({ code, reason })` from Bun's `close` handler.
- Document routing rides the message envelope: **one endpoint, all docs**.
- `getParameters` handles web-`Request` URLs, so token-in-query auth works.

Convergence verified **7/7**: initial sync · concurrent-edit CRDT
convergence · awareness propagation · disconnect → offline-edit → reconnect
catch-up · `onAuthenticate` rejection through the pumped path · multi-doc
isolation · debounced `onStoreDocument`.

**Upstream bug (affects Node/ws too, so Prism has it):** `onDisconnect`
fires **twice** per disconnect when the departing client had awareness
state — `Document.removeConnection` calls `removeAwarenessStates` *before*
`connections.delete`, the awareness broadcast hits the dying socket,
`send()` fails and re-enters `Connection.close()` while the connection is
still in the map. The upstream fix is a one-line reorder.

**R6 requirement:** all `onDisconnect`-hook logic (presence counters,
cleanup) MUST be idempotent — dedupe by socketId.
