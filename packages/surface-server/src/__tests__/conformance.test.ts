/**
 * The kit's own example wiring, tested with the PUBLIC conformance suite
 * (design P8: "conformance tests any surface can run against its own
 * routes" — so the kit eats its own product feature).
 *
 * Includes a POSITIVE CONTROL: a deliberately leaky backend must make the
 * suite FAIL — a conformance suite that can't catch a planted leak proves
 * nothing by passing.
 */

import { describe, expect, test } from "bun:test";
import type { HubJwtClaims } from "@openparachute/scope-guard";
import { type SurfaceAuth, createSurfaceAuth } from "../auth/surface-auth.ts";
import { GrantStore } from "../authz/grant-store.ts";
import { type SurfaceRouter, createSurfaceRouter } from "../authz/router.ts";
import { createSurfaceAuthz } from "../authz/surface-authz.ts";
import { type ConformanceCase, gatewayConformanceCases } from "../conformance.ts";
import type { Note } from "../types.ts";
import { deliverSnapshot, grantNote, makeTestCtx } from "./helpers.ts";

const MOUNT = "/surface/demo";

const SECRET_NOTE: Note = {
  id: "n-secret",
  createdAt: "2026-06-10T00:00:00Z",
  content: "THE-PLANTED-SECRET-MARKER",
  tags: ["docs"],
  path: "docs/secret.md",
};

const OUTSIDE_NOTE: Note = {
  id: "n-outside",
  createdAt: "2026-06-10T00:00:00Z",
  content: "OUTSIDE-SCOPE-MARKER",
  tags: ["private"],
  path: "private/outside.md",
};

/** The example wiring — what the README shows, end to end. */
async function exampleBackend(): Promise<{
  router: SurfaceRouter;
  auth: SurfaceAuth;
  capToken: string;
  entryToken: string;
}> {
  const t = makeTestCtx({ mount: MOUNT });
  t.vault.notes.set(SECRET_NOTE.id, SECRET_NOTE);
  t.vault.notes.set(OUTSIDE_NOTE.id, OUTSIDE_NOTE);
  const auth = createSurfaceAuth(t.ctx, {
    validateHubJwt: async (): Promise<HubJwtClaims> => {
      throw new Error("no operator in this fixture");
    },
  });
  // A view-level capability locked to tag `docs`.
  const cap = auth.mintCapability();
  // A separate capability used only for the entry-hygiene case.
  const entryCap = auth.mintCapability();
  const grants = new GrantStore(t.ctx);
  const ready = grants.start();
  deliverSnapshot(t.vault.subscriptions[0]!, [
    grantNote({
      id: "g1",
      subjectType: "capability",
      subject: cap.id,
      resourceType: "tag",
      resource: "docs",
      level: "view",
    }),
  ]);
  await ready;
  const authz = createSurfaceAuthz(grants);
  const router = createSurfaceRouter(t.ctx, auth, authz, {
    routes: [
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
        handler: (_req, { note }) => Response.json({ id: note?.id, content: note?.content }),
      },
      {
        method: "POST",
        path: "/api/doc/:id",
        access: { kind: "note", action: "edit_content" },
        handler: () => Response.json({ saved: true }),
      },
      {
        method: "POST",
        path: "/api/echo",
        access: { kind: "audience" },
        handler: () => Response.json({ ok: true }),
      },
    ],
    rateLimit: { windowMs: 60_000, max: 10_000 }, // roomy: the suite makes many calls
  });
  return { router, auth, capToken: cap.token, entryToken: entryCap.token };
}

function suiteFor(wiring: Awaited<ReturnType<typeof exampleBackend>>): ConformanceCase[] {
  return gatewayConformanceCases({
    fetch: (req) => wiring.router.fetch(req),
    mount: MOUNT,
    protectedProbes: [
      { path: "/api/doc/n-secret", mustNotContain: ["THE-PLANTED-SECRET-MARKER"] },
      { path: "/api/doc/n-outside", mustNotContain: ["OUTSIDE-SCOPE-MARKER"] },
      { method: "POST", path: "/api/echo" },
    ],
    actors: [
      {
        authorization: `Capability ${wiring.capToken}`,
        allowed: [{ path: "/api/doc/n-secret" }],
        denied: [
          // tag lock: the capability's grant is on `docs`; this note is `private`.
          { path: "/api/doc/n-outside", mustNotContain: ["OUTSIDE-SCOPE-MARKER"] },
          // level lock: view can't edit — and the denial must not leak.
          {
            method: "POST",
            path: "/api/doc/n-secret",
            mustNotContain: ["THE-PLANTED-SECRET-MARKER"],
          },
        ],
      },
    ],
    entryToken: wiring.entryToken,
    cookieMutationProbe: { method: "POST", path: "/api/echo" },
  });
}

describe("gateway conformance — the kit's own example wiring", async () => {
  const wiring = await exampleBackend();
  const cases = suiteFor(wiring);

  test("the suite generated the full case table", () => {
    // 3 anon + 1 deny-by-default + 1 allowed + 2 denied + 1 entry + 1 cookie-origin
    expect(cases.length).toBe(9);
  });

  for (const c of cases) {
    test(c.name, async () => {
      await c.run();
    });
  }
});

describe("conformance positive controls (the suite must catch planted leaks)", () => {
  test("a backend that serves anon reads FAILS anon-sees-nothing", async () => {
    const leaky = (_req: Request) =>
      Response.json({ content: "THE-PLANTED-SECRET-MARKER" }, { status: 200 });
    const cases = gatewayConformanceCases({
      fetch: leaky,
      mount: MOUNT,
      protectedProbes: [
        { path: "/api/doc/n-secret", mustNotContain: ["THE-PLANTED-SECRET-MARKER"] },
      ],
    });
    const anonCase = cases.find((c) => c.name.includes("anon-sees-nothing"));
    expect(anonCase).toBeDefined();
    await expect(anonCase!.run()).rejects.toThrow(/expected refusal/);
  });

  test("a backend that leaks content in a 404 body FAILS the no-leak pin", async () => {
    const leaky = (_req: Request) =>
      Response.json({ error: "not_found", debug: "THE-PLANTED-SECRET-MARKER" }, { status: 404 });
    const cases = gatewayConformanceCases({
      fetch: leaky,
      mount: MOUNT,
      protectedProbes: [
        { path: "/api/doc/n-secret", mustNotContain: ["THE-PLANTED-SECRET-MARKER"] },
      ],
    });
    const anonCase = cases.find((c) => c.name.includes("anon-sees-nothing"));
    await expect(anonCase!.run()).rejects.toThrow(/leaks marker/);
  });

  test("a backend whose entry reflects the token FAILS entry hygiene", async () => {
    const reflecting = (req: Request) => {
      const token = new URL(req.url).pathname.split("/").pop() ?? "";
      return new Response(null, {
        status: 302,
        headers: {
          location: `${MOUNT}/?t=${token}`,
          "set-cookie": `surface_session=x; Path=${MOUNT}/; HttpOnly; SameSite=Lax`,
        },
      });
    };
    const cases = gatewayConformanceCases({
      fetch: reflecting,
      mount: MOUNT,
      entryToken: "cap_abc.def",
    });
    const entryCase = cases.find((c) => c.name.includes("entry redirect"));
    await expect(entryCase!.run()).rejects.toThrow(/still carries the raw token/);
  });

  test("a backend that accepts cross-origin cookie mutations FAILS the origin pin", async () => {
    const trusting = (req: Request) => {
      if (new URL(req.url).pathname.includes("/api/a/")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `${MOUNT}/`,
            "set-cookie": `surface_session=x; Path=${MOUNT}/; HttpOnly; SameSite=Lax`,
          },
        });
      }
      return Response.json({ saved: true }, { status: 200 });
    };
    const cases = gatewayConformanceCases({
      fetch: trusting,
      mount: MOUNT,
      entryToken: "cap_abc.def",
      cookieMutationProbe: { method: "POST", path: "/api/echo" },
    });
    const originCase = cases.find((c) => c.name.includes("cookie mutation"));
    await expect(originCase!.run()).rejects.toThrow(/expected 403/);
  });
});
