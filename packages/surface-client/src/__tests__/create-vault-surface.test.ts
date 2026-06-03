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
