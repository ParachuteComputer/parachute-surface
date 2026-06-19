/**
 * The kit's PUBLIC gateway conformance suite wired against the meeting-mcp
 * backend.
 *
 * This surface's projections are all `access: "public"` (the end-user MCP
 * use case), so there are no anon-refused routes to list as protected
 * probes — but the suite still pins the invariants that matter here:
 * deny-by-default on undeclared api paths, and that a presented-but-invalid
 * credential is a 401 refusal (never a silent downgrade to anon).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { gatewayConformanceCases } from "@openparachute/surface-server/conformance";
import { MOUNT, type MadeBackend, ORIGIN, makeBackend } from "./helpers.ts";

const made: MadeBackend = await makeBackend();

afterAll(async () => {
  await made.backend.shutdown?.();
  made.controller.abort();
});

describe("kit gateway conformance", () => {
  const cases = gatewayConformanceCases({
    fetch: (req) => made.backend.fetch(req),
    mount: MOUNT,
    origin: ORIGIN,
    // No protected probes: every projection is public by design. The suite
    // still runs deny-by-default + the structural cases.
  });

  for (const c of cases) {
    test(c.name, async () => {
      await c.run();
    });
  }
});

describe("credential resolution", () => {
  test("an invalid bearer is a 401 refusal — never a downgrade to anon", async () => {
    const res = await made.backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/recent-meetings`, {
        headers: { authorization: "Bearer forged" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("an anon caller reaches a public projection (no credential needed)", async () => {
    const res = await made.backend.fetch(new Request(`${ORIGIN}${MOUNT}/api/recent-meetings`));
    expect(res.status).toBe(200);
  });

  test("an undeclared api path is a 404 (deny-by-default)", async () => {
    const res = await made.backend.fetch(new Request(`${ORIGIN}${MOUNT}/api/not-a-projection`));
    expect(res.status).toBe(404);
  });
});
