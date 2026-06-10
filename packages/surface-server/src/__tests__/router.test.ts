import { describe, expect, test } from "bun:test";
import type { HubJwtClaims } from "@openparachute/scope-guard";
import { SESSION_COOKIE, createSurfaceAuth } from "../auth/surface-auth.ts";
import { GrantStore } from "../authz/grant-store.ts";
import { type SurfaceRoute, createSurfaceRouter } from "../authz/router.ts";
import { createSurfaceAuthz } from "../authz/surface-authz.ts";
import type { Note } from "../types.ts";
import { type TestCtx, deliverSnapshot, grantNote, makeTestCtx } from "./helpers.ts";

const MOUNT = "/surface/demo";
const ORIGIN = "https://hub.test";

const SECRET_NOTE: Note = {
  id: "n-secret",
  createdAt: "2026-06-10T00:00:00Z",
  content: "TOP-SECRET-CONTENT",
  tags: ["docs"],
  path: "docs/secret.md",
};

function operatorClaims(): HubJwtClaims {
  return {
    sub: "op",
    scopes: ["vault:default:write"],
    aud: "vault.default",
    jti: "j",
    clientId: undefined,
    vaultScope: [],
  };
}

async function makeWiring(
  opts: { routes?: SurfaceRoute[]; grants?: ReturnType<typeof grantNote>[] } = {},
) {
  const t = makeTestCtx({ mount: MOUNT });
  t.vault.notes.set(SECRET_NOTE.id, SECRET_NOTE);
  const auth = createSurfaceAuth(t.ctx, {
    validateHubJwt: async (token) => {
      if (token !== "valid-operator-jwt") throw new Error("bad token");
      return operatorClaims();
    },
  });
  const grants = new GrantStore(t.ctx);
  const ready = grants.start();
  deliverSnapshot(t.vault.subscriptions[0]!, opts.grants ?? []);
  await ready;
  const authz = createSurfaceAuthz(grants);
  const routes: SurfaceRoute[] = opts.routes ?? [
    {
      method: "GET",
      path: "/api/health",
      access: { kind: "public" },
      handler: () => Response.json({ ok: true }),
    },
    {
      method: "GET",
      path: "/api/doc/:id",
      access: { kind: "note", action: "read" },
      handler: (_req, { note }) => Response.json({ content: note?.content }),
    },
    {
      method: "POST",
      path: "/api/doc/:id",
      access: { kind: "note", action: "edit_content" },
      handler: () => Response.json({ saved: true }),
    },
    {
      method: "POST",
      path: "/api/grants",
      access: { kind: "operator" },
      handler: () => Response.json({ minted: true }),
    },
    {
      method: "GET",
      path: "/api/me",
      access: { kind: "audience" },
      handler: (_req, { actor }) => Response.json({ kind: actor.kind }),
    },
    {
      method: "GET",
      path: "/api/boom",
      access: { kind: "public" },
      handler: () => {
        throw new Error("kaboom with secrets: /etc/passwd");
      },
    },
  ];
  const router = createSurfaceRouter(t.ctx, auth, authz, { routes });
  return { t, auth, grants, authz, router };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers });
}

describe("deny-by-default routing", () => {
  test("undeclared path is 404; declared path with wrong method is 405", async () => {
    const { router } = await makeWiring();
    expect((await router.fetch(get(`${MOUNT}/api/undeclared`))).status).toBe(404);
    expect((await router.fetch(post(`${MOUNT}/api/health`))).status).toBe(405);
  });

  test("public route serves anon (rate limit still paid)", async () => {
    const { router } = await makeWiring();
    const res = await router.fetch(get(`${MOUNT}/api/health`));
    expect(res.status).toBe(200);
  });

  test("operator route: anon 401, audience 403, operator 200", async () => {
    const { router, auth } = await makeWiring();
    expect((await router.fetch(post(`${MOUNT}/api/grants`))).status).toBe(401);
    const cap = auth.mintCapability();
    expect(
      (
        await router.fetch(
          post(`${MOUNT}/api/grants`, { authorization: `Capability ${cap.token}` }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await router.fetch(
          post(`${MOUNT}/api/grants`, { authorization: "Bearer valid-operator-jwt" }),
        )
      ).status,
    ).toBe(200);
  });

  test("invalid bearer is 401, never anon-downgrade", async () => {
    const { router } = await makeWiring();
    const res = await router.fetch(get(`${MOUNT}/api/health`, { authorization: "Bearer forged" }));
    expect(res.status).toBe(401);
  });

  test("audience route: anon 401, any authenticated actor passes", async () => {
    const { router, auth } = await makeWiring();
    expect((await router.fetch(get(`${MOUNT}/api/me`))).status).toBe(401);
    const cap = auth.mintCapability();
    const res = await router.fetch(
      get(`${MOUNT}/api/me`, { authorization: `Capability ${cap.token}` }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "audience" });
  });
});

describe("note routes (no existence oracle)", () => {
  test("denied and missing are the SAME 404, and neither leaks content", async () => {
    const { router } = await makeWiring();
    const denied = await router.fetch(get(`${MOUNT}/api/doc/n-secret`));
    const missing = await router.fetch(get(`${MOUNT}/api/doc/n-nope`));
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });
});

describe("note routes with live grants", () => {
  async function wiredWithGrant(level: string) {
    const t = makeTestCtx({ mount: MOUNT });
    t.vault.notes.set(SECRET_NOTE.id, SECRET_NOTE);
    const auth = createSurfaceAuth(t.ctx, { validateHubJwt: async () => operatorClaims() });
    const cap = auth.mintCapability();
    const grants = new GrantStore(t.ctx);
    const ready = grants.start();
    deliverSnapshot(t.vault.subscriptions[0]!, [
      grantNote({
        id: "g1",
        subjectType: "capability",
        subject: cap.id,
        resourceType: "tag",
        resource: "docs",
        level,
      }),
    ]);
    await ready;
    const authz = createSurfaceAuthz(grants);
    const router = createSurfaceRouter(t.ctx, auth, authz, {
      routes: [
        {
          method: "GET",
          path: "/api/doc/:id",
          access: { kind: "note", action: "read" },
          handler: (_r, { note }) => Response.json({ content: note?.content }),
        },
        {
          method: "POST",
          path: "/api/doc/:id",
          access: { kind: "note", action: "edit_content" },
          handler: () => Response.json({ saved: true }),
        },
      ],
    });
    return { router, cap, t };
  }

  test("view grant: read 200, edit 404 (denied, indistinguishable from missing)", async () => {
    const { router, cap } = await wiredWithGrant("view");
    const read = await router.fetch(
      get(`${MOUNT}/api/doc/n-secret`, { authorization: `Capability ${cap.token}` }),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ content: "TOP-SECRET-CONTENT" });
    const edit = await router.fetch(
      post(`${MOUNT}/api/doc/n-secret`, { authorization: `Capability ${cap.token}` }),
    );
    expect(edit.status).toBe(404);
  });

  test("edit grant: both read and edit pass", async () => {
    const { router, cap } = await wiredWithGrant("edit");
    expect(
      (
        await router.fetch(
          get(`${MOUNT}/api/doc/n-secret`, { authorization: `Capability ${cap.token}` }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await router.fetch(
          post(`${MOUNT}/api/doc/n-secret`, { authorization: `Capability ${cap.token}` }),
        )
      ).status,
    ).toBe(200);
  });
});

describe("middleware composition", () => {
  test("entry route is handled before matching (302 + cookie)", async () => {
    const { router, auth } = await makeWiring();
    const cap = auth.mintCapability();
    const res = await router.fetch(get(cap.entryPath));
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain(SESSION_COOKIE);
  });

  test("cookie-authenticated mutation without Origin → 403; with same-origin Origin → through", async () => {
    const { router, auth } = await makeWiring();
    const cap = auth.mintCapability();
    const entry = await router.fetch(get(cap.entryPath));
    const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0]!;

    const noOrigin = await router.fetch(post(`${MOUNT}/api/grants`, { cookie }));
    expect(noOrigin.status).toBe(403);
    const body = (await noOrigin.json()) as { error: string };
    expect(body.error).toBe("origin_mismatch");

    const crossSite = await router.fetch(
      post(`${MOUNT}/api/grants`, { cookie, origin: "https://evil.example" }),
    );
    expect(crossSite.status).toBe(403);

    // Same-origin passes the CSRF gate (then fails authz — audience on an
    // operator route — proving the origin check ran first and separately).
    const sameOrigin = await router.fetch(
      post(`${MOUNT}/api/grants`, { cookie, origin: ORIGIN, host: "hub.test" }),
    );
    expect(sameOrigin.status).toBe(403);
    const sameOriginBody = (await sameOrigin.json()) as { error: string };
    expect(sameOriginBody.error).toBe("forbidden");
  });

  test("header-authenticated mutations skip the origin check (no cookie ambient)", async () => {
    const { router } = await makeWiring();
    const res = await router.fetch(
      post(`${MOUNT}/api/grants`, { authorization: "Bearer valid-operator-jwt" }),
    );
    expect(res.status).toBe(200);
  });

  test("rate limit: fail-closed 429 once the bucket drains", async () => {
    const t = makeTestCtx({ mount: MOUNT });
    const auth = createSurfaceAuth(t.ctx, { validateHubJwt: async () => operatorClaims() });
    const grants = new GrantStore(t.ctx);
    const authz = createSurfaceAuthz(grants);
    const router = createSurfaceRouter(t.ctx, auth, authz, {
      routes: [
        {
          method: "GET",
          path: "/api/health",
          access: { kind: "public" },
          handler: () => Response.json({ ok: true }),
        },
      ],
      rateLimit: { windowMs: 60_000, max: 2 },
    });
    // Unattributed public traffic shares one bucket.
    expect((await router.fetch(get(`${MOUNT}/api/health`))).status).toBe(200);
    expect((await router.fetch(get(`${MOUNT}/api/health`))).status).toBe(200);
    const limited = await router.fetch(get(`${MOUNT}/api/health`));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // A hub-attributed IP has its own bucket.
    const attributed = await router.fetch(
      get(`${MOUNT}/api/health`, {
        "x-parachute-client-ip": "9.9.9.9",
        "x-parachute-layer": "public",
      }),
    );
    expect(attributed.status).toBe(200);
  });

  test("a throwing handler is a generic 500 — no message, no stack", async () => {
    const { router, t } = await makeWiring();
    const res = await router.fetch(get(`${MOUNT}/api/boom`));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("kaboom");
    expect(text).not.toContain("/etc/passwd");
    expect(t.logs.errors.some((e) => e.includes("kaboom"))).toBe(true);
  });
});
