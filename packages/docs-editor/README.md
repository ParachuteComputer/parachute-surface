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
meta.json            audience: hub-users · server.capabilities: ["websocket"]
server/index.ts      createBackend(ctx) — auth + grants + reconciler + collab + routes
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

## Tests

`bun test packages/docs-editor/server/` (or `bun run test:docs-editor`
from the repo root): the reconciliation boundary through the BYTES,
grant enforcement, the capability join flow, the kit's public gateway
conformance suite, and a full collab-loop integration suite driving the
real engine through the host's WS contract (convergence, external-edit
wins, 409 → re-seed, read-only enforcement, double-disconnect
idempotency).

## Not built (v1)

Comments/suggestions (`#comments` overlay docs, propose-a-revision),
audience password accounts, outbound email for personal links (links
render inline for copy-paste), offline/PWA. See the design doc's §7 for
the tracked shapes.

## License

AGPL-3.0
