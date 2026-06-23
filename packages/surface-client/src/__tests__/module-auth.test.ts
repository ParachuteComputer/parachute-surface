/**
 * Tests for `VaultSurface.moduleAuth` — a SECOND-audience OAuth flow held
 * alongside the vault token.
 *
 * The why: the hub derives a token's `aud` from its scopes, and a NAMED-vault
 * scope WINS (`inferAudience`). A single token carrying both `vault:<name>:…`
 * and `agent:read` resolves to `aud: vault.<name>`, which the agent daemon
 * REJECTS (it validates `aud: agent`). Refresh cannot re-narrow scope/aud. So
 * the `agent:read` token must come from its OWN authorize request scoped to
 * `agent:read` ALONE → `aud: agent`. `moduleAuth` drives exactly that flow,
 * isolated from the vault flow:
 *
 *   - requests `scope=agent:read` (no vault scope),
 *   - stores its token under an isolated key (`…:<storageScope>`), distinct
 *     from the vault token,
 *   - routes its callback by a namespaced pending-state key so a vault
 *     callback and an agent callback never cross-wire,
 *   - refreshes + caches the agent token like the vault token,
 *   - leaves the vault flow byte-for-byte unchanged.
 *
 * Runs under Bun with stubbed fetch + storage + a minimal Document stub (no
 * real DOM / window assumed).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { createVaultSurface } from "../create-vault-surface.ts";
import { saveToken } from "../token-storage.ts";

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

// --- fetch stub ------------------------------------------------------------

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeFetch(routes: Record<string, Responder>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    for (const prefix of Object.keys(routes)) {
      if (url.startsWith(prefix)) return await routes[prefix]!(url, init);
    }
    throw new Error(`unmocked URL: ${url}`);
  }) as unknown as typeof fetch;
}

// --- minimal Document stub for the mount.ts meta-tag readers ---------------

function makeDoc(metas: Record<string, string>): Document {
  return {
    querySelector(selector: string) {
      const m = /^meta\[name="(.+)"\]$/.exec(selector);
      if (!m) return null;
      const name = m[1]!;
      if (!(name in metas)) return null;
      return { content: metas[name] } as unknown as HTMLMetaElement;
    },
  } as unknown as Document;
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
  scopes_supported: ["vault:read", "vault:write", "agent:read"],
};

const AGENT_TOKEN = {
  access_token: "agent_at",
  token_type: "bearer",
  scope: "agent:read",
  refresh_token: "agent_rt",
  expires_in: 3600,
};

let sessionStorage: MemoryStorage;
let tokenStorage: MemoryStorage;
let dcrCache: MemoryStorage;

beforeEach(() => {
  sessionStorage = new MemoryStorage();
  tokenStorage = new MemoryStorage();
  dcrCache = new MemoryStorage();
});

function hostedSurface(fetchImpl: typeof fetch) {
  return createVaultSurface({
    clientName: "Notes",
    appName: "notes",
    doc: makeDoc({ "parachute-mount": "/surface/notes", "parachute-hub": HUB }),
    origin: HUB,
    fetchImpl,
    sessionStorage,
    tokenStorage,
    dcrCacheStorage: dcrCache,
    now: () => 1_000_000,
  });
}

function dcrSurface(fetchImpl: typeof fetch) {
  return createVaultSurface({
    clientName: "My Vault UI",
    appName: "notes",
    hubUrl: HUB,
    origin: "http://gh-pages.example",
    doc: makeDoc({}),
    fetchImpl,
    sessionStorage,
    tokenStorage,
    dcrCacheStorage: dcrCache,
    now: () => 1_000_000,
  });
}

// --- shape -----------------------------------------------------------------

describe("moduleAuth — construction", () => {
  test("defaults storageScope to the scope's service prefix", () => {
    const surface = hostedSurface(makeFetch({}));
    const agent = surface.moduleAuth({ scope: "agent:read" });
    expect(agent.scope).toBe("agent:read");
    expect(agent.storageScope).toBe("agent");
  });

  test("honors an explicit storageScope", () => {
    const surface = hostedSurface(makeFetch({}));
    const agent = surface.moduleAuth({ scope: "agent:read", storageScope: "agent-live" });
    expect(agent.storageScope).toBe("agent-live");
  });

  test("throws on empty scope", () => {
    const surface = hostedSurface(makeFetch({}));
    expect(() => surface.moduleAuth({ scope: "" })).toThrow(/scope/);
  });

  test("throws when storageScope would alias the vault token key", () => {
    // The default vaultName is "default"; a storageScope of "default" would
    // collide with the vault token's storage key (and a logout() would wipe
    // the vault token). Fail loud instead.
    const surface = hostedSurface(makeFetch({}));
    expect(() => surface.moduleAuth({ scope: "agent:read", storageScope: "default" })).toThrow(
      /must not equal the vault name/,
    );
  });
});

// --- the agent:read authorize request --------------------------------------

describe("moduleAuth — login requests agent:read alone (→ aud: agent)", () => {
  test("hosted: authorize URL carries scope=agent:read, no vault scope, shared client_id", async () => {
    let hostedCalls = 0;
    const fetchImpl = makeFetch({
      "http://hub.test/surface/notes/oauth-client": () => {
        hostedCalls++;
        return new Response(
          JSON.stringify({ client_id: "hosted_xyz", scopes: ["vault:read", "agent:read"] }),
          { status: 200 },
        );
      },
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(METADATA), { status: 200 }),
    });
    const surface = hostedSurface(fetchImpl);
    const agent = surface.moduleAuth({ scope: "agent:read" });

    // No window → resolves the URL but doesn't navigate; drive beginFlow to
    // inspect the exact request the agent flow makes.
    await agent.login();
    const { authorizeUrl } = await surface.oauth.beginFlow({
      scope: agent.scope,
      flowKey: "parachute_app_oauth_pending:agent",
    });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("scope")).toBe("agent:read");
    expect(u.searchParams.get("scope")).not.toContain("vault");
    expect(u.searchParams.get("vault")).toBeNull();
    // Shares the vault flow's hosted client_id.
    expect(u.searchParams.get("client_id")).toBe("hosted_xyz");
    expect(hostedCalls).toBeGreaterThanOrEqual(1);
  });

  test("DCR: agent flow reuses the SAME registered client_id as the vault flow (no second register)", async () => {
    let registerCalls = 0;
    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(METADATA), { status: 200 }),
      "http://hub.test/oauth/register": () => {
        registerCalls++;
        return new Response(
          JSON.stringify({
            client_id: "dcr_shared",
            client_name: "My Vault UI",
            redirect_uris: ["http://gh-pages.example/oauth/callback"],
          }),
          { status: 200 },
        );
      },
    });
    const surface = dcrSurface(fetchImpl);

    // Vault login registers the client once...
    await surface.login();
    // ...the agent flow reuses it (cache hit), no second registration.
    const agent = surface.moduleAuth({ scope: "agent:read" });
    await agent.login();
    expect(registerCalls).toBe(1);

    const { authorizeUrl } = await surface.oauth.beginFlow({
      scope: agent.scope,
      flowKey: "parachute_app_oauth_pending:agent",
    });
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("dcr_shared");
  });
});

// --- token isolation -------------------------------------------------------

describe("moduleAuth — token + callback isolation from the vault flow", () => {
  function fetchWithToken(): typeof fetch {
    return makeFetch({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(
          JSON.stringify({ client_id: "hosted_xyz", scopes: ["vault:read", "agent:read"] }),
          { status: 200 },
        ),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(JSON.stringify(AGENT_TOKEN), { status: 200 }),
    });
  }

  test("the agent token is stored under an isolated key, distinct from the vault key", async () => {
    const surface = hostedSurface(fetchWithToken());
    const agent = surface.moduleAuth({ scope: "agent:read" });

    // Start the agent flow + complete its callback via the driver.
    const { pending } = await surface.oauth.beginFlow({
      scope: "agent:read",
      flowKey: "parachute_app_oauth_pending:agent",
    });
    await surface.oauth.handleCallback(
      "agent_code",
      pending.state,
      agent.storageScope,
      "parachute_app_oauth_pending:agent",
    );

    // Stored under parachute_token:notes:agent, NOT :default (the vault key).
    expect(tokenStorage.getItem("parachute_token:notes:agent")).not.toBeNull();
    expect(tokenStorage.getItem("parachute_token:notes:default")).toBeNull();
    expect(agent.getToken()?.accessToken).toBe("agent_at");
    // The vault flow sees no token — fully isolated.
    expect(surface.getClient()).toBeNull();
  });

  test("handleCallback routing: agent flow declines a vault-flow callback, claims its own", async () => {
    const surface = hostedSurface(fetchWithToken());
    const agent = surface.moduleAuth({ scope: "agent:read" });

    // Two flows in flight (vault + agent), sharing the redirect URI.
    const vaultPending = await surface.oauth.beginFlow({ scope: "vault:read vault:write" });
    const agentPending = await surface.oauth.beginFlow({
      scope: "agent:read",
      flowKey: "parachute_app_oauth_pending:agent",
    });

    // Simulate the browser returning with the VAULT flow's state. The agent
    // flow's handleCallback must DECLINE (return false) — not steal the code.
    const windowWith = (state: string) => ({
      location: { href: `http://hub.test/surface/notes/oauth/callback?code=c&state=${state}` },
      history: { replaceState: () => {} },
    });
    const realWindow = (globalThis as { window?: unknown }).window;
    try {
      (globalThis as { window?: unknown }).window = windowWith(vaultPending.pending.state);
      expect(await agent.handleCallback()).toBe(false);
      // Vault pending state still intact (agent declined → didn't clear it).
      expect(surface.oauth.peekPending()!.state).toBe(vaultPending.pending.state);
      // No agent token stored from a declined callback.
      expect(tokenStorage.getItem("parachute_token:notes:agent")).toBeNull();

      // Now the browser returns with the AGENT flow's state → agent claims it.
      (globalThis as { window?: unknown }).window = windowWith(agentPending.pending.state);
      expect(await agent.handleCallback()).toBe(true);
      expect(tokenStorage.getItem("parachute_token:notes:agent")).not.toBeNull();
    } finally {
      (globalThis as { window?: unknown }).window = realWindow;
    }
  });

  test("logout clears the agent token only, leaving the vault token intact", () => {
    const surface = hostedSurface(makeFetch({}));
    const agent = surface.moduleAuth({ scope: "agent:read" });
    // Seed both tokens directly.
    saveTokenDirect(tokenStorage, "notes", "default", "vault_at");
    saveTokenDirect(tokenStorage, "notes", "agent", "agent_at", "agent_rt");

    expect(agent.getToken()?.accessToken).toBe("agent_at");
    agent.logout();
    expect(agent.getToken()).toBeNull();
    // Vault token survives.
    expect(tokenStorage.getItem("parachute_token:notes:default")).not.toBeNull();
  });
});

// --- access token caching + refresh ----------------------------------------

describe("moduleAuth — getAccessToken cache + auto-refresh", () => {
  test("returns the cached token when fresh (no token-endpoint call)", async () => {
    let tokenCalls = 0;
    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () => {
        tokenCalls++;
        return new Response(JSON.stringify(AGENT_TOKEN), { status: 200 });
      },
    });
    const surface = hostedSurface(fetchImpl);
    const agent = surface.moduleAuth({ scope: "agent:read" });
    // Fresh token (expiry far in the future relative to now=1_000_000).
    saveTokenDirect(
      tokenStorage,
      "notes",
      "agent",
      "agent_at_fresh",
      "agent_rt",
      9_999_999_999_999,
    );
    expect(await agent.getAccessToken()).toBe("agent_at_fresh");
    expect(tokenCalls).toBe(0);
  });

  test("refreshes a near-expiry token and returns the fresh access token", async () => {
    let seenRefresh = "";
    const fetchImpl = makeFetch({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(JSON.stringify({ client_id: "hosted_xyz", scopes: ["agent:read"] }), {
          status: 200,
        }),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(METADATA), { status: 200 }),
      "http://hub.test/oauth/token": (_url, init) => {
        const m = /refresh_token=([^&]+)/.exec(init?.body as string);
        if (m) seenRefresh = m[1]!;
        return new Response(
          JSON.stringify({
            ...AGENT_TOKEN,
            access_token: "agent_at_new",
            refresh_token: "agent_rt_new",
          }),
          { status: 200 },
        );
      },
    });
    const surface = hostedSurface(fetchImpl);
    const agent = surface.moduleAuth({ scope: "agent:read" });
    // Expired (expiresAt == now → within the 60s skew window) WITH a refresh token.
    saveTokenDirect(tokenStorage, "notes", "agent", "agent_at_old", "agent_rt_old", 1_000_000);
    const at = await agent.getAccessToken();
    expect(at).toBe("agent_at_new");
    expect(seenRefresh).toBe("agent_rt_old");
    // Persisted under the isolated key for next time.
    expect(agent.getToken()?.accessToken).toBe("agent_at_new");
  });

  test("returns null when not signed in", async () => {
    const surface = hostedSurface(makeFetch({}));
    const agent = surface.moduleAuth({ scope: "agent:read" });
    expect(await agent.getAccessToken()).toBeNull();
  });

  test("expired token with NO refresh token → null (forces re-login)", async () => {
    const surface = hostedSurface(makeFetch({}));
    const agent = surface.moduleAuth({ scope: "agent:read" });
    // Expired, no refresh token. token-storage prunes it on load → null.
    saveTokenDirect(tokenStorage, "notes", "agent", "agent_at_old", undefined, 1);
    expect(await agent.getAccessToken()).toBeNull();
  });
});

// --- vault-flow backward-compat (the headline guarantee) -------------------

describe("moduleAuth — vault flow is unchanged", () => {
  test("a vault login still parks pending under the DEFAULT key + stores under :default", async () => {
    const fetchImpl = makeFetch({
      "http://hub.test/surface/notes/oauth-client": () =>
        new Response(
          JSON.stringify({ client_id: "hosted_xyz", scopes: ["vault:read", "vault:write"] }),
          { status: 200 },
        ),
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(METADATA), { status: 200 }),
      "http://hub.test/oauth/token": () =>
        new Response(
          JSON.stringify({
            access_token: "vault_at",
            token_type: "bearer",
            scope: "vault:read vault:write",
            vault: "default",
            refresh_token: "vault_rt",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    });
    const surface = hostedSurface(fetchImpl);
    // Construct a moduleAuth alongside — must not perturb the vault flow.
    surface.moduleAuth({ scope: "agent:read" });

    const { pending } = await surface.oauth.beginFlow({ vaultName: "default" });
    // Vault pending under the legacy fixed key.
    expect(sessionStorage.getItem("parachute_app_oauth_pending")).not.toBeNull();
    await surface.oauth.handleCallback("c", pending.state, "default");
    // Vault token under :default; client present.
    expect(tokenStorage.getItem("parachute_token:notes:default")).not.toBeNull();
    expect(surface.getClient()).not.toBeNull();
  });
});

// --- helper: persist a token the way token-storage does --------------------

function saveTokenDirect(
  storage: MemoryStorage,
  appName: string,
  vaultScope: string,
  accessToken: string,
  refreshToken?: string,
  expiresAt = 9_999_999_999_999,
): void {
  const stored: {
    accessToken: string;
    scope: string;
    expiresAt: number;
    refreshToken?: string;
  } = {
    accessToken,
    scope: "agent:read",
    expiresAt,
  };
  if (refreshToken) stored.refreshToken = refreshToken;
  saveToken(appName, vaultScope, stored, { storage, now: () => 1_000_000 });
}
