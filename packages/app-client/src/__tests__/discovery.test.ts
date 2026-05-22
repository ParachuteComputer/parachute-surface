/**
 * Tests for `discovery.ts` — AS metadata fetch + DCR registration.
 *
 * Coverage:
 *   - happy-path discovery
 *   - error surfaces (network, non-2xx, missing required field, missing S256)
 *   - happy-path DCR registration
 *   - DCR error surface
 *   - DCR sets credentials: "include" for same-hub auto-trust
 */

import { describe, expect, test } from "bun:test";

import { discoverAuthServer, registerClient } from "../discovery.ts";

function fetchOk(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function fetchFail(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

describe("discoverAuthServer", () => {
  const happy = {
    issuer: "http://hub.test",
    authorization_endpoint: "http://hub.test/oauth/authorize",
    token_endpoint: "http://hub.test/oauth/token",
    registration_endpoint: "http://hub.test/oauth/register",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["vault:read", "vault:write"],
  };

  test("happy path", async () => {
    const md = await discoverAuthServer("http://hub.test", fetchOk(happy));
    expect(md.issuer).toBe("http://hub.test");
    expect(md.token_endpoint).toContain("/oauth/token");
  });

  test("network failure surfaces explicit message", async () => {
    await expect(discoverAuthServer("http://hub.test", fetchFail())).rejects.toThrow(
      /Could not reach hub/,
    );
  });

  test("non-2xx surfaces explicit message", async () => {
    await expect(discoverAuthServer("http://hub.test", fetchOk(happy, 404))).rejects.toThrow(
      /Discovery failed \(404\)/,
    );
  });

  test("missing required field rejects", async () => {
    const bad = { ...happy, token_endpoint: undefined };
    await expect(discoverAuthServer("http://hub.test", fetchOk(bad))).rejects.toThrow(
      /missing token_endpoint/,
    );
  });

  test("missing S256 rejects", async () => {
    const bad = { ...happy, code_challenge_methods_supported: ["plain"] };
    await expect(discoverAuthServer("http://hub.test", fetchOk(bad))).rejects.toThrow(/S256 PKCE/);
  });

  test("trailing slash on issuer is normalized", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(happy), { status: 200 });
    }) as unknown as typeof fetch;
    await discoverAuthServer("http://hub.test/", fetchImpl);
    expect(capturedUrl).toBe("http://hub.test/.well-known/oauth-authorization-server");
  });
});

describe("registerClient", () => {
  test("happy path returns client_id", async () => {
    const reg = { client_id: "client_abc", client_name: "test", redirect_uris: ["http://x"] };
    const out = await registerClient(
      "http://hub.test/oauth/register",
      { clientName: "test", redirectUri: "http://x" },
      fetchOk(reg),
    );
    expect(out.client_id).toBe("client_abc");
  });

  test("non-2xx rejects with body in message", async () => {
    await expect(
      registerClient(
        "http://hub.test/oauth/register",
        { clientName: "test", redirectUri: "http://x" },
        fetchOk({ error: "denied" }, 403),
      ),
    ).rejects.toThrow(/Client registration failed \(403\)/);
  });

  test("missing client_id rejects", async () => {
    await expect(
      registerClient(
        "http://hub.test/oauth/register",
        { clientName: "test", redirectUri: "http://x" },
        fetchOk({ client_name: "no-id-here" }),
      ),
    ).rejects.toThrow(/missing client_id/);
  });

  test("sends credentials: include for same-hub auto-trust", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({ client_id: "c", client_name: "t", redirect_uris: ["x"] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await registerClient(
      "http://hub.test/oauth/register",
      { clientName: "t", redirectUri: "x" },
      fetchImpl,
    );
    expect(capturedInit?.credentials).toBe("include");
  });

  test("declares refresh_token grant in registration body", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response(
        JSON.stringify({ client_id: "c", client_name: "t", redirect_uris: ["x"] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await registerClient(
      "http://hub.test/oauth/register",
      { clientName: "t", redirectUri: "x" },
      fetchImpl,
    );
    expect(capturedBody).toContain("authorization_code");
    expect(capturedBody).toContain("refresh_token");
  });
});
