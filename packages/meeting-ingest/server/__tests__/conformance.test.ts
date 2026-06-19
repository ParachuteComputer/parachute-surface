/**
 * The kit's PUBLIC gateway conformance suite wired against the meeting-ingest
 * backend — anon-sees-nothing on the operator route + deny-by-default on
 * undeclared paths.
 *
 * This surface has no audience/sharing routes (the webhook is public + HMAC,
 * the config status is operator-only), so the actor/entry/cookie cases don't
 * apply; the suite still pins the anon refusals and deny-by-default.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { gatewayConformanceCases } from "@openparachute/surface-server/conformance";
import { MOUNT, type MadeBackend, OPERATOR_JWT, ORIGIN, makeBackend } from "./helpers.ts";

const made: MadeBackend = await makeBackend({
  config: { fireflies_api_key: "k", fireflies_webhook_secret: "s" },
});

afterAll(async () => {
  await made.backend.shutdown?.();
  made.controller.abort();
});

describe("kit gateway conformance", () => {
  const cases = gatewayConformanceCases({
    fetch: (req) => made.backend.fetch(req),
    mount: MOUNT,
    origin: ORIGIN,
    protectedProbes: [
      // Operator-only — anon must be refused (401/403/404) and leak nothing.
      { path: "/api/config-status" },
    ],
  });

  for (const c of cases) {
    test(c.name, async () => {
      await c.run();
    });
  }
});

describe("operator branch", () => {
  test("an invalid bearer is a 401 refusal — never a downgrade to anon", async () => {
    const res = await made.backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/config-status`, {
        headers: { authorization: "Bearer forged" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("the operator bearer reaches the config-status route", async () => {
    const res = await made.backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/config-status`, {
        headers: { authorization: `Bearer ${OPERATOR_JWT}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      tag: string;
      providers: { provider: string; apiKeySet: boolean; webhookSecretSet: boolean }[];
    };
    expect(json.tag).toBe("meeting");
    const ff = json.providers.find((p) => p.provider === "fireflies");
    expect(ff?.apiKeySet).toBe(true);
    expect(ff?.webhookSecretSet).toBe(true);
  });

  test("config-status reports booleans only — never the secret values", async () => {
    const res = await made.backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/config-status`, {
        headers: { authorization: `Bearer ${OPERATOR_JWT}` },
      }),
    );
    const text = await res.text();
    expect(text).not.toContain('"k"');
    expect(text).not.toContain('"s"');
  });

  test("a public anon hits /api/me without a credential", async () => {
    const res = await made.backend.fetch(new Request(`${ORIGIN}${MOUNT}/api/me`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind?: string }).kind).toBe("anon");
  });
});
