# @openparachute/surface-server

The server kit for **backed surfaces** — a library a surface backend imports
inside `createBackend(ctx)`. Never a host object: the host
([`@openparachute/surface`](../surface-host)) injects the
`SurfaceHostContext`; this kit builds the trust machinery on top of it.

Part of the [Surface Runtime design](../../design/2026-06-10-surface-runtime-primitives.md)
(R4: P7–P9). Companion pattern: `parachute-patterns/patterns/backed-surface.md`.

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

- **Entry + MCP paths live under `/api/`.** The design names
  `${mount}/a/<token>` and `${mount}/mcp`, but the host forwards exactly
  `${mount}/api/*` and `${mount}/ws` to a backend — so the kit emits
  `${mount}/api/a/<token>` and serves `${mount}/api/mcp` (both short forms
  are also accepted/declared, and become live if the host ever forwards
  them).
- **Credential scope:** the surface's working-tag credential must include
  `surface-acl/<surface>` so the GrantStore can read/write grant notes —
  declare it in the surface's `required_schema` / tag scope at install time.
- **`manage_tags` / `manage_path` never reach the audience.** Tags are the
  sharing scope; granting tag writes would be privilege escalation. The kit
  denies them for every non-operator actor.
- **Trust signals come from the substrate.** Use `ctx.layer(req)` /
  `ctx.clientIp(req)`, never raw headers; the kit ships no `isLocal()`.
