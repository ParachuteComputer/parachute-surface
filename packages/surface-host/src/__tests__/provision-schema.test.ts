/**
 * Tests for `src/provision-schema.ts` — required_schema auto-provisioner
 * (Phase 2.1, re-based onto stored-credential custody in #112).
 *
 * Coverage:
 *   - UI declares required_schema + vault_default + stored credential →
 *     PUTs each tag to /vault/<name>/api/tags/<tag> with the CREDENTIAL
 *     bearer (the aud-mismatch class of #112 is structurally impossible:
 *     no operator token exists in this module anymore)
 *   - UI declares required_schema but no vault_default → skip with
 *     reason ("apps declaring required_schema must pin a vault")
 *   - UI has no required_schema → skip with reason
 *   - tokenProvider throws (no stored credential / expired /
 *     needs-operator) → skip with the resolver's reason, no vault call,
 *     never a throw out of provisionSchemaForUi
 *   - READ-scoped credential: vault 403 insufficient_scope → per-tag
 *     "lacks write scope" message (distinct from a raw 401)
 *   - rejected credential: vault 401 → per-tag "was rejected" message
 *   - Per-tag PUT failure logs warn + continues to next tag; result
 *     records errors
 *   - Idempotent: re-running against vault with same payload is a
 *     no-op at the call-shape level (vault PUT is idempotent)
 *   - field declaration with required:true round-trips through (type
 *     + description forwarded; required is meta-only)
 */

import { describe, expect, test } from "bun:test";

import { provisionSchemaForUi } from "../provision-schema.ts";
import type { RegisteredUi } from "../ui-registry.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

/** The stored vault credential the fake tokenProvider resolves. */
const CRED_TOKEN = "stored-vault-cred";
const credProvider = () => CRED_TOKEN;

function makeUi(overrides: Partial<RegisteredUi["meta"]> = {}): RegisteredUi {
  return {
    dirName: "notes",
    uiDir: "/tmp/notes",
    distDir: "/tmp/notes/dist",
    meta: {
      name: "notes",
      displayName: "Notes",
      path: "/surface/notes",
      scopes_required: ["vault:default:read", "vault:default:write"],
      pwa: false,
      audience: "hub-users" as const,
      public: false,
      vault_default: "default",
      required_schema: {
        tags: [
          {
            name: "capture",
            description: "Quick captures",
            fields: {
              source: { type: "string", required: true, description: "Origin" },
              createdAt: { type: "date" },
            },
          },
        ],
      },
      ...overrides,
    },
  };
}

type FakeCall = { url: string; method: string; body: string; bearer: string };

function makeFetch(
  calls: FakeCall[],
  responder: (url: string, init: RequestInit) => Response,
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: (init?.body as string) ?? "",
      bearer: headers.get("Authorization") ?? "",
    });
    return responder(url, init ?? {});
  }) as unknown as typeof fetch;
}

describe("provisionSchemaForUi", () => {
  test("happy path: PUTs each declared tag to vault with the stored credential", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(JSON.stringify({ name: "capture", description: "Quick captures" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await provisionSchemaForUi({
      ui: makeUi(),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual(["capture"]);
    expect(result.errors).toEqual([]);
    expect(result.skipReason).toBeUndefined();
    expect(result.vaultUrl).toBe("http://127.0.0.1:1939/vault/default");
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("http://127.0.0.1:1939/vault/default/api/tags/capture");
    // The bearer the vault sees IS the stored credential (#112).
    expect(calls[0]!.bearer).toBe(`Bearer ${CRED_TOKEN}`);
    // Body carries the description + translated fields.
    expect(calls[0]!.body).toContain("Quick captures");
    expect(calls[0]!.body).toContain('"source"');
    expect(calls[0]!.body).toContain('"type":"string"');
    // `required: true` from meta.json is NOT forwarded as a wire-level
    // flag — vault doesn't store it. Description IS forwarded.
    expect(calls[0]!.body).toContain('"description":"Origin"');
    expect(calls[0]!.body).not.toContain('"required"');
  });

  test("UI declares required_schema but no vault_default → skip", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(calls, () => new Response("nope", { status: 500 }));
    const result = await provisionSchemaForUi({
      ui: makeUi({ vault_default: undefined }),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipReason).toContain("vault_default");
    expect(calls.length).toBe(0);
  });

  test("UI has no required_schema → skip", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(calls, () => new Response("nope", { status: 500 }));
    const result = await provisionSchemaForUi({
      ui: makeUi({ required_schema: undefined }),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual([]);
    expect(result.skipReason).toContain("no required_schema");
    expect(calls.length).toBe(0);
  });

  test("required_schema with empty tags → skip", async () => {
    const result = await provisionSchemaForUi({
      ui: makeUi({ required_schema: { tags: [] } }),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual([]);
    expect(result.skipReason).toContain("no required_schema");
  });

  test("tokenProvider throws (no stored credential) → skip with reason, no vault call", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(calls, () => new Response("nope", { status: 500 }));
    const warns: string[] = [];
    const result = await provisionSchemaForUi({
      ui: makeUi(),
      hubUrl: "http://127.0.0.1:1939",
      // Same shape createCredentialTokenProvider throws when nothing is
      // stored for the surface's vault.
      tokenProvider: () => {
        throw new Error(
          'no vault credential provisioned for surface "notes" (vault "default") — approve a credential connection in the hub admin (Connections → surface)',
        );
      },
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: { log: () => {}, warn: (m: string) => warns.push(m), error: () => {} },
    });
    expect(result.provisioned).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipReason).toContain("no vault credential");
    expect(result.skipReason).toContain("approve a credential connection");
    expect(warns.length).toBe(1);
    expect(calls.length).toBe(0);
  });

  test("READ-scoped credential: vault 403 insufficient_scope → 'lacks write scope' per-tag error", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(
          JSON.stringify({
            error: "Forbidden",
            error_type: "insufficient_scope",
            message: "This endpoint requires the 'vault:write' scope (or 'vault:default:write').",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await provisionSchemaForUi({
      ui: makeUi({ required_schema: { tags: [{ name: "capture" }] } }),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.error).toContain("lacks write scope");
    expect(result.errors[0]!.error).toContain("insufficient_scope");
    expect(result.errors[0]!.error).toContain("write-scoped credential connection");
  });

  test("rejected credential: vault 401 → 'was rejected' per-tag error (re-approve)", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(
          JSON.stringify({ error: "Unauthorized", message: "token has been revoked" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await provisionSchemaForUi({
      ui: makeUi({ required_schema: { tags: [{ name: "capture" }] } }),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.error).toContain("was rejected");
    expect(result.errors[0]!.error).toContain("re-approve the credential connection");
  });

  test("per-tag PUT failure logs + continues to next tag", async () => {
    const calls: FakeCall[] = [];
    const ui = makeUi({
      required_schema: {
        tags: [
          { name: "will-fail", description: "broken" },
          { name: "will-succeed", description: "ok" },
        ],
      },
    });
    const fetchFn = makeFetch(calls, (url) => {
      if (url.includes("will-fail")) {
        // vault returns 403 with structured error_type
        return new Response(
          JSON.stringify({ error_type: "insufficient_scope", message: "need admin" }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ name: "will-succeed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const warns: string[] = [];
    const result = await provisionSchemaForUi({
      ui,
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: {
        log: () => {},
        warn: (m: string) => warns.push(m),
        error: () => {},
      },
    });
    expect(result.provisioned).toEqual(["will-succeed"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.tag).toBe("will-fail");
    expect(result.errors[0]!.error).toContain("insufficient_scope");
    expect(warns.some((w) => w.includes("will-fail"))).toBe(true);
    // Both PUTs were attempted.
    expect(calls.length).toBe(2);
  });

  test("idempotent: re-running produces same call shape", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(JSON.stringify({ name: "capture" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const ui = makeUi();
    const first = await provisionSchemaForUi({
      ui,
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    const second = await provisionSchemaForUi({
      ui,
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(first.provisioned).toEqual(second.provisioned);
    expect(calls.length).toBe(2);
    // Both calls have the same URL + body shape.
    expect(calls[0]!.url).toBe(calls[1]!.url);
    expect(calls[0]!.body).toBe(calls[1]!.body);
  });

  test("trailing slash on hub_url normalized", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(JSON.stringify({ name: "capture" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await provisionSchemaForUi({
      ui: makeUi(),
      hubUrl: "http://127.0.0.1:1939/",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:1939/vault/default/api/tags/capture");
  });

  test("tag with no description + no fields still PUTs (minimal payload)", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(JSON.stringify({ name: "x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const ui = makeUi({
      required_schema: { tags: [{ name: "minimal" }] },
    });
    const result = await provisionSchemaForUi({
      ui,
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(result.provisioned).toEqual(["minimal"]);
    expect(calls[0]!.body).toBe("{}");
  });

  test("URL-encodes vault name with spaces (paranoia)", async () => {
    const calls: FakeCall[] = [];
    const fetchFn = makeFetch(
      calls,
      () =>
        new Response(JSON.stringify({ name: "capture" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await provisionSchemaForUi({
      ui: makeUi({ vault_default: "weird name" }),
      hubUrl: "http://127.0.0.1:1939",
      tokenProvider: credProvider,
      fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      logger: silentLogger,
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:1939/vault/weird%20name/api/tags/capture");
  });
});
