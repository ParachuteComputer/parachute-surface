# @openparachute/docs-editor

**Docs** — the collaborative markdown editor, and the second reference
**backed surface** (R5 ∥ R6 in the
[Surface Runtime design](../../design/2026-06-10-surface-runtime-primitives.md);
woven-boulder is the projection-hard sibling, this is the
*reconciliation-hard* one: TipTap 3 + Yjs, markdown-canonical, capability
share links).

## What it demonstrates

| Primitive | Where |
|---|---|
| P10 — `SurfaceStateStore` + `createVaultReconciler` | `server/index.ts` (wiring), CRDT snapshots in `ctx.store`, external-edit-wins + `if_updated_at` writebacks |
| P11 — `@openparachute/doc-schema` | `server/codec.ts` (seed/serialize hooks) + `web/src/Editor.tsx` (the same schema's TipTap face) |
| P7 — `createSurfaceAuth` | capability + personal links (`/api/shares`), entry-URL → cookie session join |
| P8 — `SurfaceAuthz` + vault-native GrantStore | per-doc `view < comment < suggest < edit` grants, fail-closed SSE cache |
| Hocuspocus-under-Bun (design appendix) | `server/collab.ts` — engine class, manual pumping, idempotent disconnects |

## Shape

```
meta.json            audience: surface · server.capabilities: ["websocket"]
                     server.entry: server/index.bundle.js (the SELF-CONTAINED build artifact —
                     installs copy dist/ + server/ + meta.json, never node_modules)
server/index.ts      createBackend(ctx) — auth + grants + reconciler + collab + routes (source)
server/collab.ts     Hocuspocus engine ←pump← host WS handlers; ticket auth; readOnly enforcement
server/codec.ts      markdown ⇄ Y.Doc through @openparachute/doc-schema (ONE codec, both faces)
server/tickets.ts    single-use short-TTL WS tickets minted over the HTTP gateway
server/routes.ts     /api/me · /api/docs · /api/doc/:id · /api/collab/ticket · /api/shares
web/                 Vite + React + TipTap 3 (docSchemaExtensions + Collaboration + CollaborationCaret)
```

- **Markdown persistence ONLY** — vault notes stay plain portable
  markdown; the codec is `@openparachute/doc-schema`, both faces, one
  version.
- **Vault is source of truth; external edits WIN.** Writebacks send
  `if_updated_at` verbatim; a 409 fetches the winner and re-seeds the
  live doc atomically. Never `force`.
- **No owner-passthrough.** The operator authenticates per-request with a
  hub JWT; the audience is link-shaped (capability + personal links, no
  password accounts in v1).
- **documentName = note id**, one Y.Doc per note, fragment `"default"`.

## Install

**Requires hub ≥ 0.7.1** — this surface declares `audience: "surface"`
(backend-owned admission: the hub proxy passes visitors through and the
backend's own link auth decides), which older hubs reject at manifest
validation (the mount is silently dropped). Anonymous capability-link
invitees only work on a hub that ships the tier.

This package is `private: true` — it never publishes to npm. **The
distribution is the GitHub release tarball** attached by this repo's
release workflow on `docs-editor-v*` tags (layout: `package/` →
`meta.json` + `dist/` + `server/index.bundle.js`, the self-contained
install shape).

To install: Surface admin → **Add surface** → paste the release-tag URL:

```
https://github.com/ParachuteComputer/parachute-surface/releases/tag/docs-editor-v0.1.0
```

(substitute the version you want). The host resolves THAT release and
auto-selects its single tarball. Don't paste the bare
`ParachuteComputer/parachute-surface` shorthand — it resolves the repo's
**latest** release, which is usually a surface-host release, not a
docs-editor one. If a release ever carries several tarballs, disambiguate
with the exact asset name:
`ParachuteComputer/parachute-surface#docs-editor-surface-0.1.0.tgz` (the owner/repo shorthand with asset disambiguation), or the release asset's direct download URL.

## Editing flow

1. Operator signs in (hosted-mode hub OAuth), creates a doc (`POST
   /api/docs` → a vault note tagged `doc`), opens it.
2. Browser mints a single-use ticket (`POST /api/collab/ticket`) and
   connects `wss://…/surface/docs/ws` (hub WS bridge → host pump →
   Hocuspocus). Every doc opened on the connection re-authorizes against
   the GrantStore.
3. Operator shares: `POST /api/shares` mints a capability (or
   email-bound personal) link + a grant in one motion. The invitee's
   click exchanges the token for an httpOnly path-scoped cookie and lands
   in the app.
4. Edits converge via Yjs; the reconciler debounces canonical-markdown
   writebacks; agent/sync/Notes edits to the same note flow back in live
   over the vault's SSE watch — and win.

## Development

`bun run build` produces BOTH artifacts: the web bundle (`dist/`, via
Vite) and the server bundle (`server/index.bundle.js`, via
`bun build --target=bun`). **The host mounts the bundle named by
meta.json, not the TS sources** — after changing anything under
`server/`, re-run `bun run build` (or just `bun run build:server`)
before reloading the surface, or the daemon keeps serving the stale
backend. The bundle is gitignored (generated); the install-simulation
test (`server/__tests__/install-simulation.test.ts`) pins that it loads
and serves from a node_modules-free install dir.

Dependency floors: this package is **private** (the repo's
pebble-config precedent — plain semver ranges, resolved to workspace
copies in-monorepo). If it ever publishes, the `@openparachute/surface`
floor must rise to the version that ships the SurfaceSocket identity
contract (stable per-connection wrapper + `socketId` + `readyState`;
^0.3.2 or whatever release carries it) — `^0.3.0` admits published
hosts without it, and the collab WS wiring keys on that contract.

## Tests

`bun test packages/docs-editor/server/` (or `bun run test:docs-editor`
from the repo root): the reconciliation boundary through the BYTES,
grant enforcement, the capability join flow, the kit's public gateway
conformance suite, and a full collab-loop integration suite driving the
real engine through the host's WS contract (convergence, external-edit
wins, 409 → re-seed, read-only enforcement, double-disconnect
idempotency).

## Credential scope

The surface's vault credential must cover **two tags**:

- the working tag (`doc` by default, `working_tag` config) — read/write:
  doc list, seeds, and writebacks;
- `surface-acl/docs` — read/write: the vault-native GrantStore keeps one
  note per grant there (declared in meta.json `required_schema` so the
  requirement is visible at install time). Revocation = deleting the
  grant note.

## Hub-version requirement: the `surface` audience tier

meta.json declares `audience: "surface"` (hub ≥ 0.7.1): the hub proxy
admits visitors without a hub session and the backend's own auth
(capability/personal links, P7) is the gate — so anonymous invitees
clicking a share link land in the doc end to end. The v1 limitation
this replaced (`audience: "hub-users"` bounced anonymous invitees to
`/login` at the proxy before link auth could run) is gone on a current
hub. The flip is one-way for distribution: an OLDER hub's manifest
validation rejects unknown audiences and drops the mount — hence the
hub ≥ 0.7.1 floor in the Install section (the tier ships in the next
stable train; anyone installing the release artifact will be
post-train).

## Not built (v1)

Comments/suggestions (`#comments` overlay docs, propose-a-revision —
the `comment`/`suggest` grant levels stay in the backend schema for
forward-compat but behave as read-only, so the v1 share UI offers only
view/edit), audience password accounts, outbound email for personal
links (links render inline for copy-paste), offline/PWA. See the design
doc's §7 for the tracked shapes.

## License

AGPL-3.0
