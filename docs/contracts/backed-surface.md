> Moved from parachute-patterns/patterns/backed-surface.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Backed surfaces

> Shape decided 2026-06-09/10 (Aaron: "Surface can just be made more
> flexible"); **solidified 2026-06-11** — two conforming implementations
> ship: [woven-boulder](https://github.com/Unforced-Dev/WovenBoulder)
> (public, projection-hard) and the collaborative docs editor
> (`parachute-surface/packages/docs-editor` — invited, reconciliation-hard).
> Both run the kit's conformance suite. The proving prior art is Benjamin's
> [Prism](https://github.com/omniharmonic/prism) (Benjamin is on the
> Parachute team; Prism is the team's reference for the trust geometry).

> A **backed surface** is a surface that ships a **backend** alongside its
> bundle — server logic that holds a scoped vault credential and projects
> vault content through **its own narrow API** and **its own audience
> identity**, so the audience never touches hub OAuth and the operator's
> vault never faces the public.

## The shape: Surface is the runtime

Backed surfaces are NOT separate modules. **The Surface module is the runtime
for all surfaces — static and backed.** A surface package may ship, next to
its `dist/` bundle and `meta.json`, a **server entry**; surface-host mounts
it **in-process** under the surface's own namespace
(`/surface/<name>/api/*`, plus WebSocket upgrades for collab). One daemon,
one port, one supervised process — exactly as today.

This is the **channel precedent**: channel is one module hosting many named
channels, each with per-instance config and per-instance credentials
(channels.json). Surface is one module hosting many named surfaces — a
backed one adds routes and a credential; the *instance* model, install flow
("add a surface"), discovery, and branding are unchanged.

**Anti-patterns, named:**
- *One module per backed surface* — proliferates daemons/ports/installs for
  what is an instance-of-Surface, and makes "anyone can install a surface
  into their vault" a module-publishing exercise instead of an add-surface
  click.
- *surface-host spawning child processes* — recreates the second-supervisor
  model retired in Phase 5b. In-process mounting is not process-spawning;
  the hub still supervises exactly one surface process.

**The trust statement for in-process backends:** adding a backed surface
executes its server code inside the surface daemon — the same trust act as
installing any module (it already runs code on your machine, per the
[boundary charter](./hub-module-boundary.md)'s trust statement). The
operator installs deliberately. Workers were evaluated and REJECTED for
isolation (no real memory isolation; experimental termination); the tracked
escalation is a per-surface supervised process under the *hub* supervisor —
see Open questions.

## The trust geometry

| Plane | Identity | Owner |
|---|---|---|
| **Operator** — adds the surface, grants its credential, configures it | hub session / hub OAuth | the hub (charter substrate) |
| **Audience** — readers, collaborators, link-holders | the surface's OWN auth | the surface backend (its domain) |

The audience plane is the *feature*: blog readers, doc collaborators, and
clients are not hub users and never should be. Prism's three-actor
vocabulary is the reference:

1. **Signed-in audience user** — the surface's own accounts (invite-only,
   its own sessions; httpOnly cookies, revocable server-side). *(v2 —
   v1 ships only capability + personal links; no password endpoints.)*
2. **Capability link** — an HMAC-signed bearer of a *grant id*: scoped to a
   resource (note or tag), at a level (`view < comment < suggest < edit`),
   expiring, instantly revocable by deleting the grant (no secret rotation).
   "Anyone with the link," done safely.
3. **Anonymous** — explicit tier, empty grants.

Authentication never implies authorization: every request resolves an actor,
then an effective level, *before* any vault call. The host (or a shared
`surface-server` kit) provides these primitives so each backed surface
doesn't hand-roll them; audience **state** (accounts, grants, sessions) is
per-surface, not shared.

## The credential

Each backed surface holds **one** per-instance vault credential, held by the
surface daemon's config store (per-surface, like channel's per-channel
tokens) — never a hand-minted token in an `.env`:

- provisioned as a **credential connection**
  ([design: H4 in the runtime spec](../../parachute-surface/design/2026-06-10-surface-runtime-primitives.md)): operator-
  approved from the surface admin, hub-minted, **registered** in the token
  registry (the registered-mint rule — unregistered long-lived tokens are
  unrevocable by construction), auto-renewing, revoked when the surface is
  removed (lifecycle symmetry);
- **tag-scoped** ([tag-scoped-tokens](./tag-scoped-tokens.md)): a publishing
  surface holds read scoped to its publication tags; a docs surface holds
  read/write scoped to its working tags. Even a fully compromised backend
  reaches only what was meant for it;
- the narrowest verb that works — `read` unless the surface writes.

## The API: the hybrid — operator direct, backend serves the audience

The 2026-06-10 adjudication's central finding: Prism's owner-passthrough
proxy *forces* the credential design (a passthrough owner experience is only
as wide as the standing credential — which is why Prism had to mint year-long
unscoped `vault:write`). Our operators already have a first-class browser
path: surface-client hosted-mode hub OAuth, direct to `/vault/<name>/api/*`.
So:

- **Operator vault data path = direct** (hub OAuth, like every static
  surface — zero backend involvement).
- **The backend serves only**: audience routes, the collab WebSocket, and
  operator *surface-domain* ops (grants/links/invites/config) — the operator
  authenticates to those per-request with a **hub JWT Bearer** the backend
  validates via scope-guard, like any resource server. No owner-passthrough,
  no operator session in the backend, ever.

Audience gateway rules:

- **deny-by-default**: unmatched routes 403, always;
- **path and tag writes are privilege escalation** for non-owners — tags are
  the sharing scope, so a collaborator rewriting tags rewrites their own
  grant. Locked above the grantable levels;
- the vault query narrows first (tag-scoped credential), the app-level ACL
  decides — layered guards, neither alone;
- levels (`view < comment < suggest < edit`) are the grant vocabulary;
  **actions** are the enforcement vocabulary (`can(actor, note, action)`).
  `own` is never grantable — operator is an actor-plane fact, not a grant.

Consequence of the hybrid: audience-plane compromise concedes audience
grants — never a vault credential. A backend outage degrades the audience,
not the operator.

**Share-grants: interface-first, vault-native preferred.** The GrantStore
is an interface with two specced backings — vault-native (grants as notes,
tagged per-surface with indexed metadata: inspectable, synced, agent-visible,
reinstall-surviving, with a host-held SSE-fed enforcement cache) and
app-side SQLite. The adjudication leans vault-native; the build confirms
with real ergonomics in hand (Aaron, 2026-06-10: "let the build decide").
Sessions and caches stay app-side either way (operational state, not
knowledge).

## Content contract

A backed surface that transforms content MUST declare its canonical
persisted format — and the default is **markdown-canonical**: vaults are
markdown; every other consumer (Notes, MCP agents, github-sync, scribe)
assumes it. Prism's central interop hazard is the cautionary tale: collab
editing silently migrated notes to HTML via three coexisting converters. We
paid for this lesson once already (the Obsidian parser convergence). Persist
markdown from editor state; if genuinely impossible, mark the note's format
in metadata and accept degraded siblings.

**Multi-writer is the baseline assumption.** Vaults have agents, sync jobs,
and other surfaces writing concurrently. A backend holding derived state
(CRDT documents, caches) reconciles with **vault-as-source-of-truth** — on
load, an external vault edit *wins* and forces a re-seed (Prism's
reconciliation rule, kept). Never write back with `force: true` as policy;
use `if_updated_at` and re-seed on conflict. Vault live-query SSE is the
cheap external-edit signal.

## Transport, exposure, locality

- Public reachability rides the hub proxy + the surface module's exposure
  declarations — a surface never runs its own tunnel. Per-surface audience
  is **hub-proxy-enforced** (hub#648, the audience gate — fixed
  parachute-surface#88) with four tiers: `public`, `hub-users` (hub
  session / scoped Bearer; the default), `operator` (first-admin session
  only), and `surface` (hub#651 — pass-through; the backed surface owns
  admission end-to-end via `@openparachute/surface-server`'s
  deny-by-default auth; the tier for capability-link audiences, who are by
  design not hub users). Exposure
  layers are orthogonal: the proxy's row-level cloak still applies, so a
  `surface` mount on a loopback-only row stays unreachable from funnel.
  Version skew is fail-closed — a `surface`-audience row registered against
  a pre-#651 hub is dropped by manifest validation (mount 404s).
- The hub's identity **chrome strip is opted out** for audience-facing
  routes (`public` and `surface` tiers) — the audience are not hub users.
- Never infer "local = trusted" from forwarded-header *absence* (one
  misconfigured deployment silently grants owner). Local-trust signals come
  from the substrate (the hub proxy's layer classification), not inference.
- Same-origin caution: behind the hub proxy, an audience-facing surface
  rendering untrusted public content is same-origin with the hub admin. CSP
  on every backed-surface response (Prism ships `script-src 'self'`-class
  headers; match it), rigorous escaping; hub#643 (proxy-level default CSP)
  is the ecosystem backstop.

## Lifecycle + observability

Removing a backed surface tears down everything it provisioned: the
credential connection (registered jtis → revocation list), the DCR client,
its routes, its audience state. Backed surfaces report real per-surface
health (not hardcoded "active"); logs flow through the surface daemon to the
supervisor.

## When NOT to use this shape

If the audience is just the operator (and assigned hub users), a **static
surface** — origin-free SPA or hosted bundle, per-user hub OAuth, no
backend, no standing credential — is strictly simpler and safer. The backed
shape exists for *audiences beyond the hub's identity plane*; don't pay for
a backend and a credential you don't need.

## Related

[`hub-module-boundary.md`](./hub-module-boundary.md) ·
[`tag-scoped-tokens.md`](./tag-scoped-tokens.md) ·
[`module-protocol.md`](./module-protocol.md) ·
[`module-surfaces.md`](./module-surfaces.md) ·
[`surface-bundle-shape.md`](./surface-bundle-shape.md) ·
[`trust-gradient-isolation.md`](./trust-gradient-isolation.md)

## Settled decisions

Settled by the 2026-06-10 adjudication + the runtime design
([`parachute-surface/design/2026-06-10-surface-runtime-primitives.md`](../../parachute-surface/design/2026-06-10-surface-runtime-primitives.md)):
the server-entry contract (factory → web-standard fetch handler), the
audience kit as a library (`@openparachute/surface-server`), capability-link
transport (exchange-on-first-click into a path-scoped httpOnly cookie),
audience exposure as a hub-enforced four-tier `audience` field (hub#651
added `surface`), and the
isolation ladder — **Workers are rejected** (no real memory isolation): v1 is
in-process with non-optional host containment (timeout, error boundary,
crash-loop quarantine); the tracked escalation is a per-surface supervised
process under the *hub* supervisor for surfaces declaring an isolation
requirement. WebSocket upgrades **shipped** (hub#648: the Bun-native bridge,
capability-declared, deny-by-default; hub#655 added per-IP + total
connection caps). Hocuspocus-under-Bun verified live (engine class, manual
pumping — the docs editor runs it).

Still open: the wikilink-escaping serializer rule in the markdown codec,
per-surface `aud` claims for hub JWTs, the read/write tag-scope split on
credentials (the attenuation step both reference surfaces name in their
SECURITY.md), separate-origin hosting for public surfaces.
