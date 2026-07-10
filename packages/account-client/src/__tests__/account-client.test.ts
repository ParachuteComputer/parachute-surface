/**
 * Tests for `AccountClient` — the account/door contract client, driven against
 * a mocked `fetch`. Each endpoint asserts the exact method / path / headers /
 * body the door will receive, plus the cross-cutting invariants:
 *   - the account token is minted from the cookie (credentials: include + CSRF
 *     body field) and held IN MEMORY (re-used, re-minted on near-expiry, never
 *     written to localStorage)
 *   - bearer-gating (Authorization header) on the vault-lifecycle calls
 *   - a single silent re-mint + retry on a 401
 *   - capability discovery is memoized
 *   - error classification surfaces through the typed hierarchy
 *
 * The server endpoints don't exist yet (Hub H2 / Cloud C3); these tests pin the
 * wire the SDK expects, so those implementations have a fixed target.
 */

import { describe, expect, test } from "bun:test";

import {
  AccountAuthError,
  AccountClient,
  AccountConflictError,
  AccountUnreachableError,
  VaultLimitError,
} from "../index.ts";

const ORIGIN = "https://cloud.test";

interface Ctx {
  url: URL;
  init: RequestInit;
  body: unknown;
}
type Handler = (ctx: Ctx) => Response | Promise<Response>;

interface RecordedCall {
  key: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a mock `fetch` from a `"METHOD /path" → Handler | Handler[]` map. An
 * array of handlers is consumed one-per-call (for sequential responses, e.g.
 * a 401 then a 200 on the re-mint retry); a single handler is reused.
 */
function makeFetch(handlers: Record<string, Handler | Handler[]>): {
  fn: typeof fetch;
  calls: RecordedCall[];
} {
  const queues: Record<string, Handler[]> = {};
  for (const [k, v] of Object.entries(handlers)) queues[k] = Array.isArray(v) ? [...v] : [v];
  const calls: RecordedCall[] = [];
  const fn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    let body: unknown;
    if (typeof init.body === "string" && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({
      key,
      url: String(input),
      method,
      headers: (init.headers ?? {}) as Record<string, string>,
      credentials: init.credentials,
      body,
    });
    const q = queues[key];
    if (!q || q.length === 0) throw new Error(`unexpected request: ${key}`);
    const handler = q.length > 1 ? (q.shift() as Handler) : (q[0] as Handler);
    return handler({ url, init, body });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const CAPS = {
  door: "cloud",
  issuer: "https://cloud.test",
  account_token: { endpoint: "/account/token", method: "POST", scheme: "cookie" },
  features: {
    vault_create: true,
    vault_delete: true,
    import: true,
    export: true,
    billing: true,
    plans: ["entry", "power"],
    modules: false,
    expose: false,
  },
  caps_writable: false,
  limits: { vaults_max: 10 },
};

describe("discoverCapabilities", () => {
  test("GETs the public descriptor with no auth, and memoizes", async () => {
    const { fn, calls } = makeFetch({
      "GET /.well-known/parachute-account": () => json(CAPS),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const caps = await client.discoverCapabilities();
    expect(caps.door).toBe("cloud");
    expect(caps.caps_writable).toBe(false);
    // Second call is served from memory — still one network fetch.
    await client.discoverCapabilities();
    expect(calls.filter((c) => c.key === "GET /.well-known/parachute-account")).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.credentials).toBeUndefined();
  });

  test("network failure surfaces AccountUnreachableError", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await expect(client.discoverCapabilities()).rejects.toBeInstanceOf(AccountUnreachableError);
  });
});

describe("getAccountToken (the cookie→bearer mint)", () => {
  test("POSTs /account/token with credentials:include + CSRF body field, holds in memory", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": () => json({ account_token: "acct-1", expires_in: 600 }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn, csrfToken: "csrf-abc" });
    const token = await client.getAccountToken();
    expect(token).toBe("acct-1");
    const mint = calls.find((c) => c.key === "POST /account/token");
    expect(mint?.credentials).toBe("include");
    expect(mint?.body).toEqual({ __csrf: "csrf-abc" });
    expect(mint?.headers["Content-Type"]).toBe("application/json");
    // Second call re-uses the held token — no second mint.
    await client.getAccountToken();
    expect(calls.filter((c) => c.key === "POST /account/token")).toHaveLength(1);
  });

  test("re-mints when the held token is within the near-expiry skew", async () => {
    const clock = { t: 0 };
    const { fn, calls } = makeFetch({
      "POST /account/token": [
        () => json({ account_token: "acct-1", expires_in: 600 }),
        () => json({ account_token: "acct-2", expires_in: 600 }),
      ],
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn, now: () => clock.t });
    expect(await client.getAccountToken()).toBe("acct-1"); // expiresAt = 600_000
    clock.t = 600_000 - 20_000; // inside the 30s skew window
    expect(await client.getAccountToken()).toBe("acct-2");
    expect(calls.filter((c) => c.key === "POST /account/token")).toHaveLength(2);
  });

  test("tolerates an OAuth-signer mint that returns access_token", async () => {
    const { fn } = makeFetch({
      "POST /account/token": () => json({ access_token: "acct-oauth", expires_in: 600 }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    expect(await client.getAccountToken()).toBe("acct-oauth");
  });

  test("clearAccountToken forces a fresh mint on the next call", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": [
        () => json({ account_token: "acct-1", expires_in: 600 }),
        () => json({ account_token: "acct-2", expires_in: 600 }),
      ],
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await client.getAccountToken();
    client.clearAccountToken();
    expect(await client.getAccountToken()).toBe("acct-2");
    expect(calls.filter((c) => c.key === "POST /account/token")).toHaveLength(2);
  });
});

describe("vault lifecycle (bearer-gated)", () => {
  function mint(): Handler {
    return () => json({ account_token: "acct-1", expires_in: 600 });
  }

  test("listVaults GETs with Bearer, no credentials, unwraps { vaults }", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "GET /account/vaults": () => json({ vaults: [{ name: "fn", url: "u", created_at: "2026" }] }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const vaults = await client.listVaults();
    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.name).toBe("fn");
    const list = calls.find((c) => c.key === "GET /account/vaults");
    expect(list?.headers.Authorization).toBe("Bearer acct-1");
    expect(list?.credentials).toBeUndefined(); // bearer calls never send the cookie
  });

  test("createVault sends { name, seed_pack } and returns the ready vault token", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "POST /account/vaults": () =>
        json(
          {
            name: "fn",
            url: "https://u/vault/fn",
            vault_token: "vt-1",
            services: { "vault:fn": { url: "u", version: "cloud" } },
          },
          201,
        ),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const created = await client.createVault({ name: "fn", seedPack: "surface-starter" });
    expect(created.vault_token).toBe("vt-1");
    const create = calls.find((c) => c.key === "POST /account/vaults");
    expect(create?.body).toEqual({ name: "fn", seed_pack: "surface-starter" });
    expect(create?.headers.Authorization).toBe("Bearer acct-1");
  });

  test("createVault omits seed_pack when not given", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "POST /account/vaults": () => json({ name: "fn", url: "u", vault_token: "vt-1" }, 201),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await client.createVault({ name: "fn" });
    const create = calls.find((c) => c.key === "POST /account/vaults");
    expect(create?.body).toEqual({ name: "fn" });
  });

  test("createVault falls back to a per-vault mint on an empty vault_token (Hub caveat)", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "POST /account/vaults": () => json({ name: "fn", url: "u", vault_token: "" }, 201),
      "POST /account/vaults/fn/token": () =>
        json({ vault_token: "vt-mint", services: { "vault:fn": { url: "u", version: "hub" } } }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const created = await client.createVault({ name: "fn" });
    expect(created.vault_token).toBe("vt-mint");
    expect(created.services?.["vault:fn"]?.version).toBe("hub");
    const fallback = calls.find((c) => c.key === "POST /account/vaults/fn/token");
    expect(fallback?.body).toEqual({ scopes: ["vault:fn:read", "vault:fn:write"] });
  });

  test("deleteVault DELETEs with the { confirm } retype body", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "DELETE /account/vaults/fn": () => new Response(null, { status: 204 }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await client.deleteVault("fn");
    const del = calls.find((c) => c.key === "DELETE /account/vaults/fn");
    expect(del?.method).toBe("DELETE");
    expect(del?.body).toEqual({ confirm: "fn" });
  });

  test("mintVaultToken defaults to read+write, honors explicit scopes", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "POST /account/vaults/fn/token": () =>
        json({ vault_token: "vt", expires_at: "2026-07-10T00:00:00Z" }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const def = await client.mintVaultToken("fn");
    expect(def.vault_token).toBe("vt");
    expect(def.expires_at).toBe("2026-07-10T00:00:00Z");

    await client.mintVaultToken("fn", ["vault:fn:admin"]);
    const mints = calls.filter((c) => c.key === "POST /account/vaults/fn/token");
    expect(mints[0]?.body).toEqual({ scopes: ["vault:fn:read", "vault:fn:write"] });
    expect(mints[1]?.body).toEqual({ scopes: ["vault:fn:admin"] });
  });

  test("encodes vault names in the path", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "POST /account/vaults/my%20vault/token": () => json({ vault_token: "vt" }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await client.mintVaultToken("my vault");
    expect(calls.some((c) => c.url.endsWith("/account/vaults/my%20vault/token"))).toBe(true);
  });
});

describe("account bootstrap + plan/billing", () => {
  function mint(): Handler {
    return () => json({ account_token: "acct-1", expires_in: 600 });
  }

  test("getAccount GETs /account", async () => {
    const { fn } = makeFetch({
      "POST /account/token": mint(),
      "GET /account": () => json({ account_id: "u1", email: "a@b.c", door: "cloud" }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const acct = await client.getAccount();
    expect(acct.account_id).toBe("u1");
    expect(acct.door).toBe("cloud");
  });

  test("getPlan returns the plan on 200", async () => {
    const { fn } = makeFetch({
      "POST /account/token": mint(),
      "GET /account/plan": () => json({ tier: "power", usage: {}, options: ["entry", "power"] }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const plan = await client.getPlan();
    expect(plan?.tier).toBe("power");
  });

  test("getPlan returns null on the honest 404 (billing:false door)", async () => {
    const { fn } = makeFetch({
      "POST /account/token": mint(),
      "GET /account/plan": () => json({ error: "not_supported" }, 404),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    expect(await client.getPlan()).toBeNull();
  });

  test("openBilling maps redirect_url → { url } and puts the kind in the path", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": mint(),
      "POST /account/billing/checkout": () => json({ redirect_url: "https://stripe/checkout" }),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const out = await client.openBilling("checkout");
    expect(out.url).toBe("https://stripe/checkout");
    expect(calls.some((c) => c.key === "POST /account/billing/checkout")).toBe(true);
  });
});

describe("silent re-mint + retry on 401", () => {
  test("a 401 on a bearer call re-mints from the cookie and retries once", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": [
        () => json({ account_token: "acct-1", expires_in: 600 }),
        () => json({ account_token: "acct-2", expires_in: 600 }),
      ],
      "GET /account/vaults": [
        () => json({ error: "invalid_token" }, 401),
        () => json({ vaults: [] }),
      ],
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const vaults = await client.listVaults();
    expect(vaults).toEqual([]);
    expect(calls.filter((c) => c.key === "POST /account/token")).toHaveLength(2);
    const listCalls = calls.filter((c) => c.key === "GET /account/vaults");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]?.headers.Authorization).toBe("Bearer acct-2"); // retry uses the fresh token
  });

  test("a persistent 401 surfaces AccountAuthError (no infinite retry)", async () => {
    const { fn, calls } = makeFetch({
      "POST /account/token": () => json({ account_token: "acct-1", expires_in: 600 }),
      "GET /account": () => json({ error: "invalid_token" }, 401),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await expect(client.getAccount()).rejects.toBeInstanceOf(AccountAuthError);
    // one initial mint + one re-mint, then it gives up
    expect(calls.filter((c) => c.key === "GET /account")).toHaveLength(2);
  });
});

describe("error surfacing through the client", () => {
  test("createVault surfaces a 409 as AccountConflictError with the code", async () => {
    const { fn } = makeFetch({
      "POST /account/token": () => json({ account_token: "acct-1", expires_in: 600 }),
      "POST /account/vaults": () => json({ error: "vault_taken", message: "taken" }, 409),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    const err = await client.createVault({ name: "fn" }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountConflictError);
    expect(err.code).toBe("vault_taken");
  });

  test("createVault surfaces a plan-cap 403 as VaultLimitError", async () => {
    const { fn } = makeFetch({
      "POST /account/token": () => json({ account_token: "acct-1", expires_in: 600 }),
      "POST /account/vaults": () => json({ error: "vault_limit_reached" }, 403),
    });
    const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn });
    await expect(client.createVault({ name: "fn" })).rejects.toBeInstanceOf(VaultLimitError);
  });
});

describe("in-memory-only token custody (F6)", () => {
  test("no account operation ever writes to localStorage", async () => {
    const setItemCalls: [string, string][] = [];
    const fakeLS = {
      getItem: () => null,
      setItem: (k: string, v: string) => {
        setItemCalls.push([k, v]);
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: fakeLS, configurable: true });
    try {
      const { fn } = makeFetch({
        "POST /account/token": () => json({ account_token: "acct-1", expires_in: 600 }),
        "POST /account/vaults": () => json({ name: "fn", url: "u", vault_token: "vt" }, 201),
        "GET /account/vaults": () => json({ vaults: [] }),
      });
      const client = new AccountClient({ doorOrigin: ORIGIN, fetchImpl: fn, csrfToken: "c" });
      await client.getAccountToken();
      await client.createVault({ name: "fn" });
      await client.listVaults();
      expect(setItemCalls).toHaveLength(0);
    } finally {
      if (prev) Object.defineProperty(globalThis, "localStorage", prev);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
