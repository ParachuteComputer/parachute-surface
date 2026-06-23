/**
 * Tests for R2 commit 4 — the two session-killers parachute-brain
 * documented (and worked around app-side) in surface-client 0.2.0:
 *
 *   1. **Cold-load DCR seeding.** `refreshAccessToken` needs the DCR
 *      client_id, but only `login()`/`handleCallback()` seeded it — the
 *      first refresh on a fresh page load threw before reaching the
 *      network. Fix: `getClient()`'s refresh seam re-seeds from the
 *      factory's durable DCR cache (`parachute_surface_dcr:<appName>`)
 *      before exchanging.
 *
 *   2. **Single-flight refresh.** N parallel queries → N 401s → N
 *      concurrent refresh exchanges with the same rotating refresh
 *      token; the hub's replay detection revokes the whole token family.
 *      Fix: one in-flight refresh promise per vaultScope, shared by all
 *      callers (`ParachuteOAuth.refreshAccessToken`).
 *
 * Both are correctness, not polish — each one killed brain's session on
 * every return visit.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { createVaultSurface } from "../create-vault-surface.ts";
import { ParachuteOAuth } from "../oauth.ts";
import { loadToken, saveToken } from "../token-storage.ts";

// --- in-memory storage stub (token-storage's localStorage shape) -----------

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

const HUB = "http://hub.test";

const METADATA = {
  issuer: HUB,
  authorization_endpoint: `${HUB}/oauth/authorize`,
  token_endpoint: `${HUB}/oauth/token`,
  registration_endpoint: `${HUB}/oauth/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["vault:read", "vault:write"],
};

type Counters = {
  discovery: number;
  register: number;
  tokenExchanges: number;
  hostedClientFetches: number;
  apiCalls: number;
};

/**
 * One fetch stub covering discovery, DCR registration, the token
 * endpoint (rotation + replay detection like the hub's), the hosted
 * oauth-client endpoint, and a vault API that 401s stale bearers.
 */
function makeHubFetch(counters: Counters, opts: { tokenDelayMs?: number } = {}): typeof fetch {
  let tokenSerial = 0;
  let validRefresh = "rt_0";
  let validAccess: string | null = null;
  let familyRevoked = false;

  return (async (url: string, init?: RequestInit) => {
    if (url.includes("/.well-known/")) {
      counters.discovery++;
      return Response.json(METADATA);
    }
    if (url.startsWith(`${HUB}/oauth/register`)) {
      counters.register++;
      return Response.json({ client_id: `dcr_${counters.register}` });
    }
    if (url.startsWith(`${HUB}/surface/`)) {
      counters.hostedClientFetches++;
      return Response.json({ client_id: "hosted_client", scopes: [] });
    }
    if (url.startsWith(`${HUB}/oauth/token`)) {
      counters.tokenExchanges++;
      const body = new URLSearchParams((init?.body as string) ?? "");
      if (opts.tokenDelayMs) await new Promise((r) => setTimeout(r, opts.tokenDelayMs));
      if (familyRevoked) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (body.get("grant_type") === "refresh_token") {
        if (body.get("refresh_token") !== validRefresh) {
          // Replay of a rotated refresh token → the hub revokes the family.
          familyRevoked = true;
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        if (!body.get("client_id")) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        tokenSerial++;
        validRefresh = `rt_${tokenSerial}`;
        validAccess = `at_${tokenSerial}`;
        return Response.json({
          access_token: validAccess,
          token_type: "bearer",
          scope: "vault:read vault:write",
          vault: "default",
          refresh_token: validRefresh,
          expires_in: 900,
        });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url.startsWith(`${HUB}/vault/`)) {
      counters.apiCalls++;
      const auth = new Headers(init?.headers).get("authorization");
      if (validAccess && auth === `Bearer ${validAccess}`) {
        return Response.json([]);
      }
      return Response.json({ error_type: "expired" }, { status: 401 });
    }
    throw new Error(`unmocked URL: ${url}`);
  }) as unknown as typeof fetch;
}

function freshCounters(): Counters {
  return { discovery: 0, register: 0, tokenExchanges: 0, hostedClientFetches: 0, apiCalls: 0 };
}

/**
 * A hub stub whose refresh endpoint ALWAYS returns a terminal
 * `400 invalid_grant` ("refresh_token revoked") — the dead-token case the
 * single-flight + cold-load fixes don't recover from. The vault API 401s every
 * bearer (the stale token never becomes valid), so a request forces the refresh
 * → the refresh fails terminally. Used to prove the surface EVICTS the dead
 * token and does not re-hit the token endpoint on the next request (no loop).
 */
function makeRevokedRefreshFetch(counters: Counters): typeof fetch {
  return (async (url: string) => {
    if (url.includes("/.well-known/")) {
      counters.discovery++;
      return Response.json(METADATA);
    }
    if (url.startsWith(`${HUB}/oauth/register`)) {
      counters.register++;
      return Response.json({ client_id: `dcr_${counters.register}` });
    }
    if (url.startsWith(`${HUB}/surface/`)) {
      counters.hostedClientFetches++;
      return Response.json({ client_id: "hosted_client", scopes: [] });
    }
    if (url.startsWith(`${HUB}/oauth/token`)) {
      counters.tokenExchanges++;
      return Response.json(
        { error: "invalid_grant", error_description: "refresh_token revoked" },
        { status: 400 },
      );
    }
    if (url.startsWith(`${HUB}/vault/`)) {
      counters.apiCalls++;
      return Response.json({ error_type: "expired" }, { status: 401 });
    }
    throw new Error(`unmocked URL: ${url}`);
  }) as unknown as typeof fetch;
}

let sessionStorage: MemoryStorage;
let tokenStorage: MemoryStorage;
let dcrCache: MemoryStorage;

beforeEach(() => {
  sessionStorage = new MemoryStorage();
  tokenStorage = new MemoryStorage();
  dcrCache = new MemoryStorage();
});

/**
 * Simulate the "return visit" state: a previous session registered via
 * DCR (durable cache populated) and stored an EXPIRED access token with
 * a refresh token. Nothing in-memory — fresh page load.
 */
function seedReturnVisit(appName: string) {
  dcrCache.setItem(
    `parachute_surface_dcr:${appName}`,
    JSON.stringify({
      issuer: HUB,
      redirectUri: "http://app.example/oauth/callback",
      clientId: "dcr_prior",
    }),
  );
  saveToken(
    appName,
    "default",
    {
      accessToken: "at_stale",
      scope: "vault:read vault:write",
      vault: "default",
      refreshToken: "rt_0",
      expiresAt: Date.now() - 60_000, // expired — every return visit looks like this
    },
    { storage: tokenStorage },
  );
}

function makeSurface(
  counters: Counters,
  opts: { tokenDelayMs?: number; fetchImpl?: typeof fetch } = {},
) {
  return createVaultSurface({
    clientName: "Resilience Spec",
    appName: "resilience-spec",
    hubUrl: HUB,
    origin: "http://app.example",
    redirectUri: "http://app.example/oauth/callback",
    doc: null, // standalone
    bootstrap: "dcr",
    fetchImpl: opts.fetchImpl ?? makeHubFetch(counters, opts),
    sessionStorage,
    tokenStorage,
    dcrCacheStorage: dcrCache,
  });
}

describe("cold-load DCR seeding (brain gap 1)", () => {
  test("first refresh on a fresh page load succeeds from the durable DCR cache", async () => {
    seedReturnVisit("resilience-spec");
    const counters = freshCounters();
    const surface = makeSurface(counters);

    // Fresh load: no login()/handleCallback() ran. getClient() must exist
    // (expired-but-refreshable tokens stay loadable) and its first request
    // must refresh-and-retry successfully.
    const client = surface.getClient();
    expect(client).not.toBeNull();
    const notes = await client!.queryNotes({ tag: "#x" });
    expect(notes).toEqual([]);

    expect(counters.tokenExchanges).toBe(1); // the refresh happened
    expect(counters.register).toBe(0); // …without a NEW DCR registration
    expect(counters.hostedClientFetches).toBe(0); // …and never via the hosted endpoint
  });

  test("cache miss → refresh reports not-possible (null) instead of mis-registering", async () => {
    seedReturnVisit("resilience-spec");
    dcrCache.removeItem("parachute_surface_dcr:resilience-spec"); // cache lost
    const counters = freshCounters();
    const surface = makeSurface(counters);

    const client = surface.getClient();
    expect(client).not.toBeNull();
    // onAuthError returns null → VaultClient throws VaultAuthError; a fresh
    // registration must NOT be attempted (the refresh token is bound to the
    // old client_id — registering can't redeem it).
    expect(client!.queryNotes({ tag: "#x" })).rejects.toThrow(/rejected the token/);
    await Promise.resolve();
    expect(counters.register).toBe(0);
    expect(counters.tokenExchanges).toBe(0);
  });

  test("stale cache (issuer mismatch) is ignored, not trusted", async () => {
    seedReturnVisit("resilience-spec");
    dcrCache.setItem(
      "parachute_surface_dcr:resilience-spec",
      JSON.stringify({
        issuer: "http://old-hub.test", // hub migrated → cached registration invalid
        redirectUri: "http://app.example/oauth/callback",
        clientId: "dcr_stale",
      }),
    );
    const counters = freshCounters();
    const surface = makeSurface(counters);
    expect(surface.getClient()!.queryNotes({ tag: "#x" })).rejects.toThrow(
      /rejected the token/,
    );
    await Promise.resolve();
    expect(counters.tokenExchanges).toBe(0);
  });
});

describe("single-flight refresh (brain gap 2)", () => {
  test("concurrent 401s share ONE token-endpoint exchange — and all succeed", async () => {
    seedReturnVisit("resilience-spec");
    const counters = freshCounters();
    // Delay the token exchange so the concurrent 401s genuinely overlap.
    const surface = makeSurface(counters, { tokenDelayMs: 25 });
    const client = surface.getClient()!;

    // N parallel queries with an expired bearer → N 401s → must collapse
    // into one refresh. (The stub's replay detection would revoke the
    // family on a second concurrent exchange — exactly the hub's behavior
    // that killed brain's session.)
    const results = await Promise.all([
      client.queryNotes({ tag: "#a" }),
      client.queryNotes({ tag: "#b" }),
      client.queryNotes({ tag: "#c" }),
      client.queryNotes({ tag: "#d" }),
    ]);
    expect(results).toEqual([[], [], [], []]);
    expect(counters.tokenExchanges).toBe(1); // exactly one network refresh
  });

  test("ParachuteOAuth.refreshAccessToken: concurrent callers get the same in-flight result", async () => {
    const counters = freshCounters();
    const oauth = new ParachuteOAuth({
      appName: "resilience-spec",
      hubUrl: HUB,
      fetchImpl: makeHubFetch(counters, { tokenDelayMs: 25 }),
      sessionStorage,
      tokenStorage,
    });
    oauth.useClientId({ client_id: "dcr_prior", scopes: [] });

    const [a, b, c] = await Promise.all([
      oauth.refreshAccessToken("rt_0", "default"),
      oauth.refreshAccessToken("rt_0", "default"),
      oauth.refreshAccessToken("rt_0", "default"),
    ]);
    expect(counters.tokenExchanges).toBe(1);
    expect(a.token.access_token).toBe("at_1");
    expect(b.token.access_token).toBe("at_1");
    expect(c.token.access_token).toBe("at_1");
  });

  test("sequential refreshes are separate exchanges (single-flight ≠ caching)", async () => {
    const counters = freshCounters();
    const oauth = new ParachuteOAuth({
      appName: "resilience-spec",
      hubUrl: HUB,
      fetchImpl: makeHubFetch(counters),
      sessionStorage,
      tokenStorage,
    });
    oauth.useClientId({ client_id: "dcr_prior", scopes: [] });

    const first = await oauth.refreshAccessToken("rt_0", "default");
    expect(first.token.refresh_token).toBe("rt_1");
    // Next refresh uses the ROTATED token — a real second exchange.
    const second = await oauth.refreshAccessToken(first.token.refresh_token!, "default");
    expect(second.token.access_token).toBe("at_2");
    expect(counters.tokenExchanges).toBe(2);
  });

  test("a failed refresh is not cached — the next call retries the exchange", async () => {
    const counters = freshCounters();
    const oauth = new ParachuteOAuth({
      appName: "resilience-spec",
      hubUrl: HUB,
      fetchImpl: makeHubFetch(counters),
      sessionStorage,
      tokenStorage,
    });
    oauth.useClientId({ client_id: "dcr_prior", scopes: [] });

    expect(oauth.refreshAccessToken("rt_wrong", "default")).rejects.toThrow(/400/);
    await Promise.resolve();
    const before = counters.tokenExchanges;
    // The in-flight slot must be cleared after rejection.
    expect(oauth.refreshAccessToken("rt_also_wrong", "default")).rejects.toThrow();
    await Promise.resolve();
    expect(counters.tokenExchanges).toBe(before + 1);
  });
});

describe("terminal invalid_grant recovery (revoked refresh token → no loop)", () => {
  test("vault flow: a 400 invalid_grant EVICTS the dead token and does not loop", async () => {
    seedReturnVisit("resilience-spec");
    const counters = freshCounters();
    const surface = makeSurface(counters, { fetchImpl: makeRevokedRefreshFetch(counters) });

    const client = surface.getClient();
    expect(client).not.toBeNull();

    // First request: stale bearer 401s → refresh → hub 400 invalid_grant
    // (revoked). The seam must catch it, clear the token, and surface a clean
    // VaultAuthError (NOT propagate RefreshHttpError, NOT loop).
    await expect(client!.queryNotes({ tag: "#x" })).rejects.toThrow(/rejected the token/);

    // (a) the stored token was CLEARED after the failed refresh.
    expect(loadToken("resilience-spec", "default", { storage: tokenStorage })).toBeNull();
    const exchangesAfterFirst = counters.tokenExchanges;
    expect(exchangesAfterFirst).toBe(1); // exactly one refresh attempt

    // (b) a SECOND request via getClient() does NOT re-hit the token endpoint —
    // the token is gone, so getClient() returns null (no client, no loop).
    expect(surface.getClient()).toBeNull();
    expect(counters.tokenExchanges).toBe(exchangesAfterFirst); // unchanged: no re-refresh
  });

  test("module flow: a 400 invalid_grant EVICTS the module token and returns null", async () => {
    // Seed the DCR cache so the cold-load seed succeeds, then store an EXPIRED
    // agent-audience token with a (revoked) refresh token under the module scope.
    dcrCache.setItem(
      "parachute_surface_dcr:resilience-spec",
      JSON.stringify({
        issuer: HUB,
        redirectUri: "http://app.example/oauth/callback",
        clientId: "dcr_prior",
      }),
    );
    saveToken(
      "resilience-spec",
      "agent",
      {
        accessToken: "agent_at_stale",
        scope: "agent:read",
        refreshToken: "agent_rt_revoked",
        expiresAt: Date.now() - 60_000, // expired → forces refresh
      },
      { storage: tokenStorage },
    );

    const counters = freshCounters();
    const surface = makeSurface(counters, { fetchImpl: makeRevokedRefreshFetch(counters) });
    const agentAuth = surface.moduleAuth({ scope: "agent:read" });

    // Expired → refresh → 400 invalid_grant → evict + null (no throw, no loop).
    expect(await agentAuth.getAccessToken()).toBeNull();
    expect(loadToken("resilience-spec", "agent", { storage: tokenStorage })).toBeNull();
    const after = counters.tokenExchanges;
    expect(after).toBe(1);

    // Second call: token gone → null without another exchange.
    expect(await agentAuth.getAccessToken()).toBeNull();
    expect(counters.tokenExchanges).toBe(after);
  });

  test("concurrent 401s on a revoked token: ONE refresh, evicted once, no loop", async () => {
    seedReturnVisit("resilience-spec");
    const counters = freshCounters();
    const surface = makeSurface(counters, { fetchImpl: makeRevokedRefreshFetch(counters) });
    const client = surface.getClient()!;

    // N parallel queries all 401 → all enter onAuthError → single-flight
    // collapses them into ONE token-endpoint exchange, which 400s terminally.
    // Each closure catches the SAME rejection and calls clearToken (idempotent
    // — removeItem on a missing key is a no-op). All must reject cleanly; none
    // loop.
    const settled = await Promise.allSettled([
      client.queryNotes({ tag: "#a" }),
      client.queryNotes({ tag: "#b" }),
      client.queryNotes({ tag: "#c" }),
    ]);
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(counters.tokenExchanges).toBe(1); // single-flight held even on terminal failure
    expect(loadToken("resilience-spec", "default", { storage: tokenStorage })).toBeNull();
  });

  test("non-terminal refresh failure (5xx) still PROPAGATES — token preserved", async () => {
    seedReturnVisit("resilience-spec");
    const counters = freshCounters();
    // Refresh endpoint returns a 503 (transient) — NOT a terminal invalid_grant.
    const fetchImpl = (async (url: string) => {
      if (url.includes("/.well-known/")) return Response.json(METADATA);
      if (url.startsWith(`${HUB}/oauth/register`)) return Response.json({ client_id: "dcr_x" });
      if (url.startsWith(`${HUB}/oauth/token`)) {
        counters.tokenExchanges++;
        return new Response("upstream unavailable", { status: 503 });
      }
      if (url.startsWith(`${HUB}/vault/`)) {
        counters.apiCalls++;
        return Response.json({ error_type: "expired" }, { status: 401 });
      }
      throw new Error(`unmocked URL: ${url}`);
    }) as unknown as typeof fetch;

    const surface = makeSurface(counters, { fetchImpl });
    // A transient failure must NOT silently evict the token (it may recover);
    // it propagates as the original RefreshHttpError-derived rejection.
    await expect(surface.getClient()!.queryNotes({ tag: "#x" })).rejects.toThrow(/503/);
    await Promise.resolve();
    // Token PRESERVED — not a terminal failure.
    expect(loadToken("resilience-spec", "default", { storage: tokenStorage })).not.toBeNull();
  });
});
