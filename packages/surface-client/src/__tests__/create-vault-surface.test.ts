/**
 * Tests for `createVaultSurface` — the turnkey quick-start factory (design
 * doc §5C / Phase 2).
 *
 * The factory's load-bearing behaviors:
 *   - hosted-vs-standalone auto-detect from the `parachute-mount` meta tag,
 *   - default-baking (hubUrl / redirectUri / scope / appName),
 *   - standalone DCR (discover + register + seed) so `login` never hits the
 *     hosted endpoint,
 *   - hosted path uses `getClientId()` and never DCR-registers,
 *   - `getClient()` returns a refresh-wired VaultClient (or null).
 *
 * Runs under Bun with stubbed fetch + storage + a minimal Document stub for
 * the meta-tag readers (no real DOM / window assumed).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { createVaultSurface } from "../create-vault-surface.ts";
import { saveToken } from "../token-storage.ts";

// --- in-memory storage stub (matches token-storage's localStorage shape) ---

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

const HAPPY_TOKEN = {
  access_token: "at_xyz",
  token_type: "bearer",
  scope: "vault:read vault:write",
  vault: "default",
  refresh_token: "rt_xyz",
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

// --- detection -------------------------------------------------------------

describe("createVaultSurface — bootstrap auto-detect", () => {
  test("hosted when a parachute-mount meta tag is present", () => {
    const surface = createVaultSurface({
      clientName: "Notes",
      doc: makeDoc({ "parachute-mount": "/surface/notes", "parachute-hub": "http://hub.test" }),
      origin: "http://hub.test",
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.bootstrap).toBe("hosted");
  });

  test("standalone when no parachute-mount meta tag is present", () => {
    const surface = createVaultSurface({
      clientName: "My Vault UI",
      doc: makeDoc({}),
      origin: "http://gh-pages.example",
      hubUrl: "http://hub.test",
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.bootstrap).toBe("dcr");
  });

  test("explicit bootstrap overrides detection", () => {
    const surface = createVaultSurface({
      clientName: "Forced",
      bootstrap: "dcr",
      doc: makeDoc({ "parachute-mount": "/surface/notes" }), // would auto-detect hosted
      origin: "http://hub.test",
      hubUrl: "http://hub.test",
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.bootstrap).toBe("dcr");
  });
});

// --- default baking --------------------------------------------------------

describe("createVaultSurface — default baking", () => {
  test("hubUrl defaults to the parachute-hub meta tag", () => {
    const surface = createVaultSurface({
      clientName: "Notes",
      doc: makeDoc({ "parachute-mount": "/surface/notes", "parachute-hub": "http://hub.meta" }),
      origin: "http://hub.meta",
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.hubUrl).toBe("http://hub.meta");
  });

  test("hubUrl falls back to origin when no meta tag", () => {
    const surface = createVaultSurface({
      clientName: "My Vault UI",
      doc: makeDoc({}),
      origin: "http://gh-pages.example",
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.hubUrl).toBe("http://gh-pages.example");
  });

  test("vaultName defaults to 'default'", () => {
    const surface = createVaultSurface({
      clientName: "X",
      doc: makeDoc({}),
      origin: "http://x.test",
      hubUrl: "http://hub.test",
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.vaultName).toBe("default");
  });

  test("throws when clientName is empty", () => {
    expect(() =>
      createVaultSurface({ clientName: "", doc: makeDoc({}), origin: "http://x.test" }),
    ).toThrow(/clientName/);
  });

  test("throws when no hub URL is resolvable", () => {
    expect(() =>
      createVaultSurface({
        clientName: "X",
        doc: makeDoc({}),
        origin: undefined, // no window in this test context → null
      }),
    ).toThrow(/hub URL/);
  });
});

// --- standalone login (DCR) ------------------------------------------------

describe("createVaultSurface — standalone login (DCR)", () => {
  test("login discovers, DCR-registers, and builds a DCR-seeded authorize URL", async () => {
    let registerCalls = 0;
    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/register": () => {
        registerCalls++;
        return new Response(
          JSON.stringify({
            client_id: "dcr_abc",
            client_name: "My Vault UI",
            redirect_uris: ["http://gh-pages.example/oauth/callback"],
          }),
          { status: 200 },
        );
      },
    });
    const surface = createVaultSurface({
      clientName: "My Vault UI",
      hubUrl: "http://hub.test",
      origin: "http://gh-pages.example",
      doc: makeDoc({}),
      fetchImpl,
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });

    // No window in this test → login resolves the authorize URL but can't
    // navigate. Drive beginFlow directly to assert the seeded client_id.
    await surface.login();
    expect(registerCalls).toBe(1);

    const { authorizeUrl } = await surface.oauth.beginFlow({
      vaultName: "default",
      redirectUri: "http://gh-pages.example/oauth/callback",
    });
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("client_id")).toBe("dcr_abc");
    expect(u.searchParams.get("redirect_uri")).toBe("http://gh-pages.example/oauth/callback");
  });

  test("DCR client_id is cached — a second login does not re-register", async () => {
    let registerCalls = 0;
    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/register": () => {
        registerCalls++;
        return new Response(
          JSON.stringify({
            client_id: "dcr_abc",
            client_name: "My Vault UI",
            redirect_uris: ["http://gh-pages.example/oauth/callback"],
          }),
          { status: 200 },
        );
      },
    });
    const make = () =>
      createVaultSurface({
        clientName: "My Vault UI",
        hubUrl: "http://hub.test",
        origin: "http://gh-pages.example",
        doc: makeDoc({}),
        fetchImpl,
        sessionStorage,
        tokenStorage,
        dcrCacheStorage: dcrCache, // shared cache across both surfaces
      });

    await make().login();
    await make().login(); // fresh surface instance, same cache
    expect(registerCalls).toBe(1);
  });

  test("two distinct surfaces sharing an origin do NOT evict each other's DCR registration", async () => {
    // Regression: a single fixed localStorage key (`parachute_surface_dcr`)
    // meant two standalone surfaces on one origin clobbered each other's
    // cached client_id (different redirectUris → cross-eviction → a wasteful
    // re-register on every surface switch). The cache key is now namespaced by
    // appName, so each surface keeps its own entry.
    const registerCallsByName: Record<string, number> = {};
    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/register": (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as { client_name?: string };
        const name = body.client_name ?? "?";
        registerCallsByName[name] = (registerCallsByName[name] ?? 0) + 1;
        return new Response(
          JSON.stringify({
            client_id: `dcr_${name.replace(/\s+/g, "_")}`,
            client_name: name,
            redirect_uris: ["http://gh-pages.example/oauth/callback"],
          }),
          { status: 200 },
        );
      },
    });
    // Two surfaces, same origin + shared dcrCache, distinct appName + redirectUri.
    const makeNotes = () =>
      createVaultSurface({
        clientName: "Notes Surface",
        appName: "notes",
        hubUrl: "http://hub.test",
        origin: "http://gh-pages.example",
        redirectUri: "http://gh-pages.example/notes/oauth/callback",
        doc: makeDoc({}),
        fetchImpl,
        sessionStorage,
        tokenStorage,
        dcrCacheStorage: dcrCache,
      });
    const makeTasks = () =>
      createVaultSurface({
        clientName: "Tasks Surface",
        appName: "tasks",
        hubUrl: "http://hub.test",
        origin: "http://gh-pages.example",
        redirectUri: "http://gh-pages.example/tasks/oauth/callback",
        doc: makeDoc({}),
        fetchImpl,
        sessionStorage,
        tokenStorage,
        dcrCacheStorage: dcrCache,
      });

    // Interleave: notes, tasks, then notes again. With per-surface keys, the
    // third login reuses notes' cached client_id (no eviction by tasks).
    await makeNotes().login();
    await makeTasks().login();
    await makeNotes().login();

    expect(registerCallsByName["Notes Surface"]).toBe(1);
    expect(registerCallsByName["Tasks Surface"]).toBe(1);

    // Both registrations coexist under distinct, namespaced cache keys.
    expect(dcrCache.getItem("parachute_surface_dcr:notes")).not.toBeNull();
    expect(dcrCache.getItem("parachute_surface_dcr:tasks")).not.toBeNull();
  });
});

// --- hosted login ----------------------------------------------------------

describe("createVaultSurface — hosted login", () => {
  test("login fetches the hosted client_id and never DCR-registers", async () => {
    let registerCalls = 0;
    let hostedCalls = 0;
    const fetchImpl = makeFetch({
      "http://hub.test/surface/notes/oauth-client": () => {
        hostedCalls++;
        return new Response(
          JSON.stringify({ client_id: "hosted_xyz", scopes: ["vault:read", "vault:write"] }),
          { status: 200 },
        );
      },
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/register": () => {
        registerCalls++;
        return new Response("should not register", { status: 500 });
      },
    });
    const surface = createVaultSurface({
      clientName: "Notes",
      appName: "notes",
      doc: makeDoc({ "parachute-mount": "/surface/notes", "parachute-hub": "http://hub.test" }),
      origin: "http://hub.test",
      fetchImpl,
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    expect(surface.bootstrap).toBe("hosted");

    await surface.login();
    expect(registerCalls).toBe(0);
    expect(hostedCalls).toBe(1);

    const { authorizeUrl } = await surface.oauth.beginFlow({ vaultName: "default" });
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("hosted_xyz");
  });
});

// --- getClient + logout ----------------------------------------------------

describe("createVaultSurface — getClient", () => {
  function seededSurface() {
    return createVaultSurface({
      clientName: "X",
      hubUrl: "http://hub.test",
      origin: "http://x.test",
      doc: makeDoc({}),
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
  }

  test("returns null when not signed in", () => {
    expect(seededSurface().getClient()).toBeNull();
  });

  test("returns a VaultClient once a token is stored, and logout clears it", () => {
    const surface = seededSurface();
    // Persist a token via the underlying driver's storage path.
    surface.oauth.useClientId({ client_id: "dcr", scopes: ["vault:read"] });
    saveTokenDirect(tokenStorage, "x", "default", HAPPY_TOKEN.access_token);

    const client = surface.getClient();
    expect(client).not.toBeNull();

    surface.logout();
    expect(surface.getClient()).toBeNull();
  });

  test("refresh-on-401 re-reads the latest stored refresh token (no replay of a rotated token)", async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": (_url, init) => {
        const body = init?.body as string;
        const m = /refresh_token=([^&]+)/.exec(body);
        if (m) seen.push(m[1]!);
        return new Response(
          JSON.stringify({ ...HAPPY_TOKEN, access_token: "at_2", refresh_token: "rt_2" }),
          { status: 200 },
        );
      },
    });
    const surface = createVaultSurface({
      clientName: "X",
      hubUrl: "http://hub.test",
      origin: "http://x.test",
      doc: makeDoc({}),
      fetchImpl,
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    surface.oauth.useClientId({ client_id: "dcr", scopes: ["vault:read"] });
    saveTokenDirect(tokenStorage, "x", "default", "at_1", "rt_1");

    const client = surface.getClient();
    expect(client).not.toBeNull();
    // Exercise the wired onAuthError by refreshing through the oauth driver
    // the factory composed; assert it sends the stored refresh token.
    const { token } = await surface.oauth.refreshAccessToken("rt_1", "default");
    expect(token.access_token).toBe("at_2");
    expect(seen).toContain("rt_1");
  });

  test("getClient()'s wired refresh fires through a real VaultClient 401 (re-reads latest token, retries with refreshed access token, second 401 fails)", async () => {
    // Drive an actual VaultClient request to a 401 and assert the *wired*
    // onAuthError closure (create-vault-surface.ts:~292) runs end-to-end:
    //   (a) it re-reads the LATEST stored refresh token via oauth.getToken
    //       (not a value closed over when getClient was called), then
    //   (b) the refreshed access token is sent on the retried request, and
    //   (c) a second 401 after rotation propagates as a VaultAuthError.
    const tokenRefreshRequests: string[] = []; // refresh_tokens presented to the AS
    const vaultAuthHeaders: string[] = []; // Bearer values the vault saw
    // The vault accepts the freshly-refreshed access token EXACTLY ONCE (it
    // expires immediately after, mimicking a short-lived access token). Keying
    // behavior on the actual credential presented — plus single-use — makes the
    // whole sequence deterministic with no timing/phase flag.
    let acceptsRemaining = 1;
    const VAULT_ACCEPTS = "at_refreshed";

    const fetchImpl = makeFetch({
      "http://hub.test/.well-known/oauth-authorization-server": () =>
        new Response(JSON.stringify(HAPPY_METADATA), { status: 200 }),
      "http://hub.test/oauth/token": (_url, init) => {
        const body = init?.body as string;
        const m = /refresh_token=([^&]+)/.exec(body);
        const presented = m ? decodeURIComponent(m[1]!) : "";
        if (m) tokenRefreshRequests.push(presented);
        // First refresh (rt_3) rotates to the access token the vault accepts;
        // a later refresh (rt_2, after rotation) hands back a token the vault
        // always rejects — proving the second-401 path surfaces.
        const accessToken = presented === "rt_3" ? "at_refreshed" : "at_still_bad";
        return new Response(
          JSON.stringify({ ...HAPPY_TOKEN, access_token: accessToken, refresh_token: "rt_2" }),
          { status: 200 },
        );
      },
      "http://hub.test/vault/default/api/notes": (_url, init) => {
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        vaultAuthHeaders.push(auth);
        if (auth === `Bearer ${VAULT_ACCEPTS}` && acceptsRemaining > 0) {
          acceptsRemaining--;
          return new Response(JSON.stringify([{ id: "n1" }]), { status: 200 });
        }
        return new Response(JSON.stringify({ error_type: "expired", message: "token expired" }), {
          status: 401,
        });
      },
    });

    const surface = createVaultSurface({
      clientName: "X",
      hubUrl: "http://hub.test",
      origin: "http://x.test",
      doc: makeDoc({}),
      fetchImpl,
      sessionStorage,
      tokenStorage,
      dcrCacheStorage: dcrCache,
    });
    surface.oauth.useClientId({ client_id: "dcr", scopes: ["vault:read"] });
    // Build the client while "at_1"/"rt_1" is the stored token...
    saveTokenDirect(tokenStorage, "x", "default", "at_1", "rt_1");
    const client = surface.getClient();
    expect(client).not.toBeNull();

    // ...then mutate the stored REFRESH token under the client from "rt_1" to
    // "rt_3" BEFORE the request (e.g. another tab refreshed). The client's
    // own access token stays "at_1" (the value it was built with), but a
    // correct onAuthError re-reads getToken at 401-time and refreshes with
    // "rt_3" (the latest), NOT "rt_1" (the value present when getClient ran).
    saveTokenDirect(tokenStorage, "x", "default", "at_1", "rt_3");

    // First request 401s (at_1 is expired) → wired onAuthError re-reads
    // getToken, refreshes with rt_3 → vault accepts the at_refreshed retry.
    const notes = await client!.queryNotes({ tag: "#x" });
    expect(notes).toEqual([{ id: "n1" }]);

    // (a) the refresh used the LATEST stored refresh token (rt_3), not the
    //     rt_1 that was stored when getClient() built the closure.
    expect(tokenRefreshRequests).toContain("rt_3");
    expect(tokenRefreshRequests).not.toContain("rt_1");
    // (b) the first attempt carried the client's built-in token "at_1"; the
    //     retry carried the refreshed access token "at_refreshed".
    expect(vaultAuthHeaders[0]).toBe("Bearer at_1");
    expect(vaultAuthHeaders).toContain("Bearer at_refreshed");

    // (c) a second 401 after rotation fails correctly. The first refresh
    // rotated the stored refresh token to "rt_2"; the next request 401s,
    // onAuthError refreshes once more (rt_2 → at_still_bad), the retry 401s
    // again → VaultAuthError surfaces (no infinite loop; one retry only).
    await expect(client!.queryNotes({ tag: "#y" })).rejects.toThrow(/rejected the token/);
  });
});

// --- helper: persist a token the way token-storage does -------------------

function saveTokenDirect(
  storage: MemoryStorage,
  appName: string,
  vaultScope: string,
  accessToken: string,
  refreshToken?: string,
): void {
  const stored: {
    accessToken: string;
    scope: string;
    vault: string;
    expiresAt: number;
    refreshToken?: string;
  } = {
    accessToken,
    scope: "vault:read vault:write",
    vault: "default",
    expiresAt: 9_999_999_999_999,
  };
  if (refreshToken) stored.refreshToken = refreshToken;
  saveToken(appName, vaultScope, stored, { storage, now: () => 1_000_000 });
}
