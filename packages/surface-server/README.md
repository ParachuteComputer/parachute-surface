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

## Wiring

```ts
import type { SurfaceBackend, SurfaceHostContext } from "@openparachute/surface";
import {
  createSurfaceAuth,
  createSurfaceAuthz,
  createSurfaceRouter,
  GrantStore,
} from "@openparachute/surface-server";

export default async function createBackend(ctx: SurfaceHostContext): Promise<SurfaceBackend> {
  const auth = createSurfaceAuth(ctx);
  const grants = new GrantStore(ctx);
  await grants.start(); // live grant cache — fail-closed
  const authz = createSurfaceAuthz(grants);

  const router = createSurfaceRouter(ctx, auth, authz, {
    routes: [
      { method: "GET", path: "/api/health", access: { kind: "public" }, handler: () => Response.json({ ok: true }) },
      {
        method: "GET",
        path: "/api/doc/:id",
        access: { kind: "note", action: "read" },
        handler: (_req, { note }) => Response.json({ id: note?.id, content: note?.content }),
      },
      {
        method: "POST",
        path: "/api/share",
        access: { kind: "operator" },
        handler: async (req) => {
          const { noteId, level } = await req.json();
          const cap = auth.mintCapability();
          await grants.createGrant({ subject: `cap:${cap.id}`, resourceType: "note", resource: noteId, level });
          return Response.json({ url: cap.entryPath });
        },
      },
    ],
  });

  return { fetch: router.fetch, shutdown: async () => grants.stop() };
}
```

**Credential scope note:** the surface's working-tag credential must include
`surface-acl/<surface>` so the GrantStore can read/write grant notes —
declare it in the surface's `required_schema` / tag scope at install time.
