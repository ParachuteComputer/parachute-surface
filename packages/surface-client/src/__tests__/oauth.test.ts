/**
 * Tests for `ParachuteOAuth` — the OAuth driver class.
 *
 * The test suite drives the class end-to-end with mocked fetch +
 * sessionStorage + tokenStorage. No real browser/window assumed; the
 * class falls back to no-op storage when `window` is absent so this
 * runs cleanly under Bun's test runner.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { ParachuteOAuth, PendingApprovalError } from "../oauth.ts";
import type { ParachuteOAuthOpts } from "../oauth.ts";

// --- in-memory storage stubs ---

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  key(i: number): string | null {
    return Array.from(this.data.keys())[i] ?? null;
  }
  get length(): number {
    return this.data.size;
  }
}

// --- fetch stub: scriptable responder ---

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeFetch(routes: Record<string, Responder>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    for (const prefix of Object.keys(routes)) {
      if (url.startsWith(prefix)) {
        return await routes[prefix]!(url, init);
      }
    }
    throw new Error(`unmocked URL: ${url}`);
  }) as unknown as typeof fetch;
}

const HAPPY_METADATA = {
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

const HAPPY_CLIENT_INFO = {
  client_id: "client_abc",
  scopes: ["vault:read", "vault:write"],
  discovery_url: "http://hub.test/.well-known/oauth-authorization-server",
};

const HAPPY_TOKEN_RESPONSE = {
  access_token: "at_xyz",
  token_type: "bearer",
  scope: "vault:read vault:write",
  vault: "default",
  refresh_token: "rt_xyz",
  expires_in: 3600,
};

// --- shared opts factory ---

let sessionStorage: MemoryStorage;
let tokenStorage: MemoryStorage;

beforeEach(() => {
  sessionStorage = new MemoryStorage();
  tokenStorage = new MemoryStorage();
});

function makeOAuth(routes: Record<string, Responder>): ParachuteOAuth {
  const opts: ParachuteOAuthOpts = {
    appName: "notes",
    hubUrl: "http://hub.test",
    fetchImpl: makeFetch(routes),
    sessionStorage,
    tokenStorage,
    now: () => 1_000_000,
  };
  return new ParachuteOAuth(opts);
}

// --- tests ---

describe("getClientId", () => {
  test("fetches /surface/<name>/oauth-client + caches", async () => {
    let callCount = 0;
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () => {
        callCount++;
        return new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 });
      },
    });
    const a = await oauth.getClientId();
    const b = await oauth.getClientId();
    expect(a.client_id).toBe("client_abc");
    expect(b.client_id).toBe("client_abc");
    expect(callCount).toBe(1);
  });

  test("non-2xx throws explicit message", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () => new Response("not found", { status: 404 }),
    });
    await expect(oauth.getClientId()).rejects.toThrow(/oauth-client/);
  });

  test("missing client_id throws explicit message", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify({ scopes: [] }), { status: 200 }),
    });
    await expect(oauth.getClientId()).rejects.toThrow(/missing client_id/);
  });
});

describe("useClientId (standalone DCR bootstrap)", () => {
  test("seeds the cache so getClientId never fetches the hosted endpoint", async () => {
    let hostedCalls = 0;
    const oauth = makeOAuth({
      // If the hosted endpoint is ever hit, count it — it must not be.
      "http://hub.test/surface/notes/oauth-client": () => {
        hostedCalls++;
        return new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 });
      },
    });
    const info = oauth.useClientId({ client_id: "dcr_client", scopes: ["vault:read"] });
    expect(info.client_id).toBe("dcr_client");
    const resolved = await oauth.getClientId();
    expect(resolved.client_id).toBe("dcr_client");
    expect(hostedCalls).toBe(0);
  });

  test("beginFlow uses the injected client_id (no hosted endpoint mocked)", async () => {
    // Note: NO /surface/notes/oauth-client route is registered. If beginFlow
    // tried the hosted path, makeFetch would throw "unmocked URL".
    const oauth = makeOAuth({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
    });
    oauth.useClientId({ client_id: "dcr_client", scopes: ["vault:read", "vault:write"] });
    const { authorizeUrl } = await oauth.beginFlow({
      vaultName: "default",
      redirectUri: "http://gh-pages.example/oauth/callback",
    });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("client_id")).toBe("dcr_client");
    expect(u.searchParams.get("redirect_uri")).toBe("http://gh-pages.example/oauth/callback");
  });

  test("normalizes a missing scopes array to []", () => {
    const oauth = makeOAuth({});
    const info = oauth.useClientId({ client_id: "dcr_client" } as unknown as {
      client_id: string;
      scopes: string[];
    });
    expect(info.scopes).toEqual([]);
  });

  test("rejects an empty client_id", () => {
    const oauth = makeOAuth({});
    expect(() => oauth.useClientId({ client_id: "", scopes: [] })).toThrow(/client_id/);
  });

  test("resetCaches lets a later getClientId fall back to the hosted endpoint", async () => {
    let hostedCalls = 0;
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () => {
        hostedCalls++;
        return new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 });
      },
    });
    oauth.useClientId({ client_id: "dcr_client", scopes: [] });
    oauth.resetCaches();
    const resolved = await oauth.getClientId();
    expect(resolved.client_id).toBe("client_abc");
    expect(hostedCalls).toBe(1);
  });
});

describe("beginFlow", () => {
  test("builds the authorize URL with PKCE params + persists pending state", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
    });
    const { authorizeUrl, pending } = await oauth.beginFlow({
      scope: "vault:read",
      redirectUri: "http://app.example/cb",
    });
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe("http://hub.test/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client_abc");
    expect(u.searchParams.get("redirect_uri")).toBe("http://app.example/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")?.length ?? 0).toBeGreaterThan(20);
    expect(u.searchParams.get("scope")).toBe("vault:read");
    expect(pending.codeVerifier.length).toBeGreaterThan(20);
    expect(pending.state.length).toBeGreaterThan(8);
    expect(sessionStorage.getItem("parachute_app_oauth_pending")).not.toBeNull();
  });

  test("vaultName narrows scope via the `vault` query param", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
    });
    const { authorizeUrl } = await oauth.beginFlow({
      vaultName: "gitcoin",
      redirectUri: "http://x/cb",
    });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("vault")).toBe("gitcoin");
  });

  test("extraAuthorizeParams never override OAuth/PKCE params", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
    });
    const { authorizeUrl } = await oauth.beginFlow({
      redirectUri: "http://x/cb",
      extraAuthorizeParams: { client_id: "attacker", hint: "ok" },
    });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("client_id")).toBe("client_abc");
    expect(u.searchParams.get("hint")).toBe("ok");
  });
});

describe("handleCallback", () => {
  async function setupPending(oauth: ParachuteOAuth): Promise<{ state: string; code: string }> {
    const { pending } = await oauth.beginFlow({ redirectUri: "http://x/cb" });
    return { state: pending.state, code: "auth_code_123" };
  }

  test("exchanges code → token + persists in tokenStorage", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(JSON.stringify(HAPPY_TOKEN_RESPONSE), { status: 200 }),
    });
    const { state, code } = await setupPending(oauth);
    const result = await oauth.handleCallback(code, state, "default");
    expect(result.token.access_token).toBe("at_xyz");
    expect(result.stored.accessToken).toBe("at_xyz");
    expect(result.stored.expiresAt).toBe(1_000_000 + 3600 * 1000);
    // Persisted under parachute_token:notes:default
    const raw = tokenStorage.getItem("parachute_token:notes:default");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.accessToken).toBe("at_xyz");
    // pending state cleared
    expect(sessionStorage.getItem("parachute_app_oauth_pending")).toBeNull();
  });

  test("state mismatch rejects + clears pending", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
    });
    await setupPending(oauth);
    await expect(oauth.handleCallback("code", "wrong-state", "default")).rejects.toThrow(
      /state mismatch/,
    );
    expect(sessionStorage.getItem("parachute_app_oauth_pending")).toBeNull();
  });

  test("no pending state rejects with explicit message", async () => {
    const oauth = makeOAuth({});
    await expect(oauth.handleCallback("code", "state", "default")).rejects.toThrow(
      /No pending OAuth flow/,
    );
  });

  test("token endpoint 4xx with invalid_client + approve_url → PendingApprovalError", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(
          JSON.stringify({
            error: "invalid_client",
            approve_url: "http://hub.test/admin/approve-client/abc",
          }),
          { status: 400 },
        ),
    });
    const { state, code } = await setupPending(oauth);
    let thrown: unknown;
    try {
      await oauth.handleCallback(code, state, "default");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PendingApprovalError);
    expect((thrown as PendingApprovalError).approveUrl).toBe(
      "http://hub.test/admin/approve-client/abc",
    );
  });

  test("non-http(s) approve_url falls through to generic error", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(
          JSON.stringify({
            error: "invalid_client",
            approve_url: "javascript:alert(1)",
          }),
          { status: 400 },
        ),
    });
    const { state, code } = await setupPending(oauth);
    await expect(oauth.handleCallback(code, state, "default")).rejects.toThrow(
      /Token exchange failed/,
    );
  });
});

describe("getToken + clearToken", () => {
  test("getToken returns null when nothing stored", () => {
    const oauth = makeOAuth({});
    expect(oauth.getToken("default")).toBeNull();
  });

  test("getToken returns stored shape after handleCallback", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(JSON.stringify(HAPPY_TOKEN_RESPONSE), { status: 200 }),
    });
    const { pending } = await oauth.beginFlow({ redirectUri: "http://x/cb" });
    await oauth.handleCallback("code", pending.state, "default");
    const stored = oauth.getToken("default");
    expect(stored?.accessToken).toBe("at_xyz");
  });

  test("clearToken wipes the stored record", async () => {
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(JSON.stringify(HAPPY_TOKEN_RESPONSE), { status: 200 }),
    });
    const { pending } = await oauth.beginFlow({ redirectUri: "http://x/cb" });
    await oauth.handleCallback("code", pending.state, "default");
    oauth.clearToken("default");
    expect(oauth.getToken("default")).toBeNull();
  });

  test("clearToken removes the key without a poisoned-tombstone setItem", async () => {
    // Spy storage records every setItem/removeItem call so we can assert
    // the clear path does NOT write a tombstone before deleting (which
    // would surface a transient zero-token record in devtools).
    type Op = { kind: "set" | "remove"; key: string };
    const ops: Op[] = [];
    const spyStorage = {
      data: new Map<string, string>(),
      getItem(k: string): string | null {
        return this.data.get(k) ?? null;
      },
      setItem(k: string, v: string): void {
        ops.push({ kind: "set", key: k });
        this.data.set(k, v);
      },
      removeItem(k: string): void {
        ops.push({ kind: "remove", key: k });
        this.data.delete(k);
      },
      key(i: number): string | null {
        return Array.from(this.data.keys())[i] ?? null;
      },
      get length(): number {
        return this.data.size;
      },
    };
    const oauth = new ParachuteOAuth({
      appName: "notes",
      hubUrl: "http://hub.test",
      fetchImpl: makeFetch({
        "http://hub.test/surface/notes/oauth-client": () =>
          new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
        "http://hub.test/.well-known/oauth-authorization-server": () =>
          new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
        "http://hub.test/oauth/token": () =>
          new Response(JSON.stringify(HAPPY_TOKEN_RESPONSE), { status: 200 }),
      }),
      sessionStorage,
      tokenStorage: spyStorage,
      now: () => 1_000_000,
    });
    const { pending } = await oauth.beginFlow({ redirectUri: "http://x/cb" });
    await oauth.handleCallback("code", pending.state, "default");
    // Reset ops so we only see clearToken's writes
    ops.length = 0;
    oauth.clearToken("default");
    const tokenKeyOps = ops.filter((o) => o.key === "parachute_token:notes:default");
    // Exactly one op total, and it MUST be the remove (no set-then-remove).
    expect(tokenKeyOps.length).toBe(1);
    expect(tokenKeyOps[0]!.kind).toBe("remove");
  });
});

describe("refreshAccessToken", () => {
  test("posts refresh_token grant + persists fresh token", async () => {
    const fresh = {
      access_token: "at_new",
      token_type: "bearer",
      scope: "vault:read vault:write",
      refresh_token: "rt_new",
      expires_in: 3600,
    };
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": (_url, init) => {
        expect((init?.body as string).includes("refresh_token=rt_old")).toBe(true);
        return new Response(JSON.stringify(fresh), { status: 200 });
      },
    });
    const result = await oauth.refreshAccessToken("rt_old", "default");
    expect(result.token.access_token).toBe("at_new");
    expect(result.stored.accessToken).toBe("at_new");
    expect(oauth.getToken("default")?.accessToken).toBe("at_new");
  });
});

describe("resetCaches", () => {
  test("re-fetches client_id + metadata on next call", async () => {
    let clientCount = 0;
    let metaCount = 0;
    const oauth = makeOAuth({
      "http://hub.test/surface/notes/oauth-client": () => {
        clientCount++;
        return new Response(JSON.stringify(HAPPY_CLIENT_INFO), { status: 200 });
      },
      "http://hub.test/.well-known/oauth-authorization-server": () => {
        metaCount++;
        return new Response(JSON.stringify(HAPPY_METADATA), { status: 200 });
      },
    });
    await oauth.getClientId();
    await oauth.getMetadata();
    oauth.resetCaches();
    await oauth.getClientId();
    await oauth.getMetadata();
    expect(clientCount).toBe(2);
    expect(metaCount).toBe(2);
  });
});
