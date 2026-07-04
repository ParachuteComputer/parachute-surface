# @openparachute/surface-server

The server kit for **backed surfaces** — a library a surface backend imports
inside `createBackend(ctx)`. Never a host object: the host
([`@openparachute/surface`](../surface-host)) injects the
`SurfaceHostContext`; this kit builds the trust machinery on top of it.

Part of the [Surface Runtime design](../../design/2026-06-10-surface-runtime-primitives.md)
(R4: P7–P9; R6 foundation: P10). Companion contract:
[`docs/contracts/backed-surface.md`](../../docs/contracts/backed-surface.md).

> **Bun required.** This package publishes raw TypeScript source (no compiled
> `dist/`) — it runs where backed surfaces run: inside the Bun-native surface
> host. Node consumers would need their own TS loader; that path is untested
> and unsupported.

## What's in the box

### P7 — `createSurfaceAuth`

`resolveActor(req)` with exactly three branches:

- **operator** — `Authorization: Bearer <hub JWT>`, validated against the
  hub's JWKS via `@openparachute/scope-guard`. v1 pins `aud=vault.<name>` +
  scope `vault:<name>:write` (the owner branch from the design's open
  questions; a per-surface audience is an issuance evolution).
- **audience** — `Authorization: Capability <token>` (programmatic) or the
  path-scoped session cookie set by the **entry route**
  `GET ${mount}/api/a/<token>` (verify → link-session → httpOnly
  `SameSite=Lax` cookie scoped to `${mount}/` → 302 to a clean URL — the raw
  token never lingers in history or logs).
- **anon** — neither presented. Presented-but-INVALID credentials are a 401
  refusal, never a silent downgrade to anon.

Plus: the `AudienceStore` (subjects / capabilities / sessions in the
per-surface state store; `passwordHash` is nullable v2 schema room only),
capability + single-use personal-link minting (email delivery is OPTIONAL
operator config per module-credential-ownership — links always render inline
for copy-paste without it), an Origin-check middleware (default-on for
cookie-authenticated mutations), and a fail-closed rate limiter keyed off the
hub-stamped `ctx.clientIp` (null IP on the public layer shares one collective
bucket — limited, never unlimited).

### P8 — `SurfaceAuthz`

`can(actor, note, action)` with the level→action table
(`view < comment < suggest < edit`; `manage_grants` / `manage_tags` /
`manage_path` are operator-only — tags are the sharing scope, so writing them
is privilege escalation). Grants are **vault-native**: notes tagged
`surface-acl/<surface>` with indexed metadata
(`subject_type, subject, resource_type, resource, level, expires_at`),
enforced from an in-memory cache fed by the vault's live-query SSE.
**Fail-closed on stream loss**: while degraded the store revalidates with a
single-flight one-shot query or denies — stale-allow never happens.
Revocation = delete the grant note.

`createSurfaceRouter` composes both into a deny-by-default gateway: every
route declares `access` (`public` / `audience` / `operator` /
`note`+action); undeclared paths 404; denied note reads are indistinguishable
from missing notes (no existence oracle).

### P9 — projections (one definition → REST + MCP)

Declare a **domain query** once; the kit derives both consumer faces:

```ts
const upcomingMeetings = defineProjection({
  name: "upcomingMeetings",
  params: { from: "date?" },
  query: (p) => ({
    tag: "meeting",
    metadata: { date: { gte: p.from ?? new Date().toISOString().slice(0, 10) } },
    includeContent: true, // vault list results omit content by default
  }),
  shape: (note) => ({
    title: note.metadata?.title,
    date: note.metadata?.date,
  }),
  describe: "Upcoming public meetings, soonest first.",
  access: "public", // default is "audience" — public is an explicit opt-in
});
```

- **REST**: `GET ${mount}/api/upcoming-meetings?from=2026-06-10` — emitted as
  a `SurfaceRoute`, so it rides the same gateway as everything else. Returns
  `{ projection, count, items: notes.map(shape) }`. Bad params → 400 with
  per-param issues, never a 500.
- **MCP**: a tool named `upcoming-meetings` on the per-surface
  Streamable-HTTP endpoint `POST ${mount}/api/mcp` (stateless — no
  initialize handshake required, restarts never strand a client). `describe`
  is the tool description and the params declaration **compiles to the tool's
  `inputSchema`**, so the two faces cannot drift. Connect a Claude session
  with:

  ```bash
  claude mcp add --transport http my-surface <origin>/surface/<name>/api/mcp
  ```

The MCP endpoint rides the **same actor resolution**: `tools/list` shows only
the projections the caller's access clears (anon sees exactly the public
slice), and calling a denied tool returns the identical error as a
nonexistent one — no existence oracle. Browsers and AI clients both get
domain vocabulary; raw tags/notes/links never ride out — the only data that
leaves a projection is what `shape` returns.

Param specs are `'string' | 'number' | 'boolean' | 'date'` with a `?` suffix
for optional (`date` values stay ISO strings). Validation is strict both
ways: unknown params refuse, dates must actually parse.

#### `defineTool` — the WRITE face (same `/api/mcp`)

A projection only ever queries. `defineTool` is its write-capable sibling:
the handler receives `{ params, actor, ctx }` and MAY mutate via
`ctx.vault.createNote/updateNote/deleteNote`. Tools ride the **same**
`POST ${mount}/api/mcp` endpoint as projections — `tools/list` shows both
(only those the actor may call), `tools/call` dispatches to whichever owns
the name.

```ts
const sendFeedback = defineTool({
  name: "sendFeedback", // MCP tool `send-feedback`
  params: { body: "string", email: "string?" },
  describe: "Leave feedback — writes a feedback note to the vault.",
  access: "public", // REQUIRED — there is no default (see below)
  handler: async ({ params, ctx }) => {
    const note = await ctx.vault.createNote({
      content: params.body,
      tags: ["feedback"],
      ...(params.email ? { metadata: { email: params.email } } : {}),
    });
    return { ok: true, id: note.id }; // serialized as the tool result
  },
});

// Add to the SAME endpoint — either field on createSurfaceProjections …
const surface = createSurfaceProjections(ctx, {
  projections: [upcomingMeetings],
  tools: [sendFeedback],
});
// … or the createSurfaceTools convenience (co-hosts projections too):
const writes = createSurfaceTools(ctx, { tools: [sendFeedback] });
// then spread surface.routes / writes.routes into createSurfaceRouter.
```

- **`access` is REQUIRED — no default.** Unlike `defineProjection` (which
  defaults to `audience`), `defineTool` makes `access` mandatory and throws
  if it's omitted. A write tool with no access bar is a worse footgun than
  a leaky read: a read leak shows data, a write footgun lets the wrong
  actor mutate the vault. `public` is expressible, but it's an explicit
  world-writable opt-in (e.g. an anonymous feedback drop), never implicit.
  Deny-by-default is enforced identically to the router/projections.
- **Actor-gating + no-existence-oracle carry over exactly.** A denied/anon
  actor never sees the tool in `tools/list`; a denied `tools/call` returns
  the identical `unknown tool: <name>` error as a nonexistent one — there
  is no differential message betraying that a tool exists. The visibility
  map is unified across projections and tools, so neither face leaks the
  other's hidden entries.
- **Host-custodied write boundary.** Handlers write through `ctx.vault`
  (the `ScopedVaultClient`), which already rejects `force: true` host-side;
  the kit adds no second force path. A handler that throws (including the
  wrapper's `force` rejection) is a generic in-band tool error — the real
  error to the surface log, never out the wire.
- Tool names share one kebab space with projections (a collision throws at
  build). Tools are MCP-only — no REST face: a write REST endpoint would
  need its own CSRF/idempotency contract, and `tools/call` is the
  canonical agent write path.

### P10 — `createVaultReconciler` (+ the `SurfaceStateStore` substrate)

The corrected reconciliation machine (design §9) between a surface's live
Y.Docs and their backing vault notes — the collaborative-editing foundation.
The host's per-surface `SurfaceStateStore` (`ctx.store`, SQLite, deleted on
surface removal) is the persistence substrate; the machine's internals
(state layout, queues, debounce, version tracking) stay private. Surface
authors see exactly two hooks and the conflict events:

```ts
import { createVaultReconciler } from "@openparachute/surface-server";
import { docToMarkdown, markdownToDocJSON, schema } from "@openparachute/doc-schema";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";

const reconciler = createVaultReconciler(ctx, {
  tag: "doc", // the surface's working tag — also the SSE watch scope
  hooks: {
    seed(doc, note) {
      /* REPLACE the doc's content from note.content (markdown).
         ALWAYS doc-schema's exported schema — node/mark names persist
         inside Y.Docs, so an ad-hoc schema corrupts every doc it touches. */
    },
    serialize(doc) {
      /* derive canonical markdown — doc-schema's docToMarkdown, never
         an ad-hoc serializer (schema + codec version together). */
    },
  },
});
await reconciler.start(); // resolves on the first SSE snapshot
reconciler.on((ev) => {
  /* "external-edit" | "writeback-conflict" | "note-removed" | … */
});
// documentName = note id (e.g. Hocuspocus onLoadDocument):
const doc = await reconciler.load(noteId, engineDoc);
// shutdown(): await reconciler.stop()  — flushes + persists everything
```

The rules it enforces (Prism's load-bearing rules kept, both bug paths
replaced — see the module doc for the full contract and the documented
failure windows):

- **Vault-as-source-of-truth, external-edit-WINS** — the external-edit
  signal is the vault's live-query SSE on the working tag, not load-time
  comparison.
- **Writebacks send `if_updated_at` with the tracked `updatedAt` string
  VERBATIM** — versions are opaque strings, equality is the only operation,
  and no `force` flag ever rides a reconciler writeback (test-pinned).
- **409 → fetch the winner → re-seed into the live Y.Doc in ONE
  transaction** — connected clients observe a single atomic swap, never a
  torn intermediate state.
- **Populated re-seed guard** — a doc that already carries CRDT state is
  never seeded over on load (the classic double-seed bug).
- **Fail-closed on stream loss** — while degraded the machine revalidates
  before the next writeback instead of assuming no external edits; it never
  writes blind.

One operational warning for collab engines: Hocuspocus's `onDisconnect`
fires **twice** when the departing client had awareness state (upstream bug,
recorded in the design appendix) — any disconnect-driven cleanup around this
machine (presence counters, `unload()` calls) must be idempotent, deduped by
socketId. Version anchor: the Hocuspocus-under-Bun spike was verified on
**Bun 1.3.13 + @hocuspocus/server 4.1.1** — on a Bun (or Hocuspocus)
upgrade, re-verify the manual-pumping contract and that double-`onDisconnect`
behavior before trusting disconnect-driven cleanup.

### Conformance suite (public export)

```ts
import { test } from "bun:test";
import { gatewayConformanceCases } from "@openparachute/surface-server/conformance";

for (const c of gatewayConformanceCases({ fetch: backend.fetch, mount, ... })) {
  test(c.name, () => c.run());
}
```

Pins anon-sees-nothing, deny-by-default, leak conditions, path/tag locks,
entry-redirect hygiene, and the cookie-mutation origin check — against YOUR
routes. The kit runs the same suite against its own example wiring.

### SECURITY.md template (spec §13)

Every backed surface should ship a `SECURITY.md`. The kit packs a scaffold —
[`SECURITY.template.md`](./SECURITY.template.md) (in the published tarball at
the package root) — covering the one-rule statement, threat-model summary,
credential posture, audience plane, working-scope statement, an actor table
that cites your conformance-suite case names as evidence, a secrets table,
residual risks, and the report channel. Copy it to your surface package root,
fill the placeholders with your real answers. The docs-editor's
[`SECURITY.md`](../docs-editor/SECURITY.md) is the filled reference.

## From `createBackend(ctx)` to a gated, projected backend

The whole journey in one file. A surface package declares a `server` block in
its `.parachute/meta.json`; the host calls the default export once per mount
and forwards `${mount}/api/*` (+ `${mount}/ws`) to the returned `fetch`.

```ts
import type { SurfaceBackend, SurfaceHostContext } from "@openparachute/surface";
import {
  createSurfaceAuth,
  createSurfaceAuthz,
  createSurfaceProjections,
  createSurfaceRouter,
  defineProjection,
  GrantStore,
} from "@openparachute/surface-server";

export default async function createBackend(ctx: SurfaceHostContext): Promise<SurfaceBackend> {
  // 1. AUTH — who is calling? (hub JWT / capability link / anon)
  const auth = createSurfaceAuth(ctx);

  // 2. AUTHZ — what may they touch? (vault-native grants, live SSE cache)
  const grants = new GrantStore(ctx);
  await grants.start(); // resolves on the first snapshot — authz is ready
  const authz = createSurfaceAuthz(grants);

  // 3. PROJECTIONS — the domain vocabulary, declared once.
  const projections = createSurfaceProjections(ctx, {
    projections: [
      defineProjection({
        name: "upcomingMeetings",
        params: { from: "date?" },
        query: (p) => ({ tag: "meeting", metadata: { date: { gte: p.from ?? "2026-01-01" } } }),
        shape: (note) => ({ title: note.metadata?.title, date: note.metadata?.date }),
        describe: "Upcoming public meetings, soonest first.",
        access: "public",
      }),
    ],
  });

  // 4. THE GATEWAY — deny-by-default; every route declares its access.
  const router = createSurfaceRouter(ctx, auth, authz, {
    routes: [
      ...projections.routes, // REST faces + the MCP endpoint

      // A note-gated read: 404s identically for denied and missing.
      {
        method: "GET",
        path: "/api/doc/:id",
        access: { kind: "note", action: "read" },
        handler: (_req, { note }) => Response.json({ id: note?.id, content: note?.content }),
      },

      // An operator-only share flow: mint a capability link + its grant.
      {
        method: "POST",
        path: "/api/share",
        access: { kind: "operator" },
        handler: async (req) => {
          const { noteId, level } = (await req.json()) as { noteId: string; level: "view" };
          const cap = auth.mintCapability();
          await grants.createGrant({
            subject: `cap:${cap.id}`,
            resourceType: "note",
            resource: noteId,
            level,
          });
          return Response.json({ url: cap.entryPath }); // hand out ONCE
        },
      },
    ],
  });

  return { fetch: router.fetch, shutdown: async () => grants.stop() };
}
```

Then pin the trust architecture in your own test suite:

```ts
import { test } from "bun:test";
import { gatewayConformanceCases } from "@openparachute/surface-server/conformance";

for (const c of gatewayConformanceCases({
  fetch: (req) => backend.fetch(req),
  mount: "/surface/my-surface",
  protectedProbes: [{ path: "/api/doc/n-1", mustNotContain: ["a distinctive phrase"] }],
})) {
  test(c.name, () => c.run());
}
```

## Notes for surface authors

- **Entry + MCP paths live under `/api/`.** The host forwards exactly
  `${mount}/api/*` and `${mount}/ws` to a backend — so the kit emits
  `${mount}/api/a/<token>` and serves `${mount}/api/mcp`. `/api/mcp` is the
  CANONICAL (and only) MCP route (#104 — the spec was amended to name it;
  the bare `${mount}/mcp` route was dropped as dead code). The short entry
  form `${mount}/a/<token>` is still accepted when *parsing* entry URLs.
- **Credential scope:** the surface's working-tag credential must include
  `surface-acl/<surface>` so the GrantStore can read/write grant notes —
  declare it in the surface's `required_schema` / tag scope at install time.
- **`manage_tags` / `manage_path` never reach the audience.** Tags are the
  sharing scope; granting tag writes would be privilege escalation. The kit
  denies them for every non-operator actor.
- **Trust signals come from the substrate.** Use `ctx.layer(req)` /
  `ctx.clientIp(req)`, never raw headers; the kit ships no `isLocal()`.
