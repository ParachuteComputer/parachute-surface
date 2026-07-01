/**
 * P3 — credential custody: the hub delivery endpoint, the 0600 store, the
 * surface→credential binding, and the proof-of-possession renewal sweep
 * (against an in-test hub).
 *
 * Wire shapes mirror the MERGED hub#648 (parachute-hub/src/admin-connections.ts):
 * the CredentialPayload field names, the `surface:admin` delivery bearer,
 * `POST /admin/connections/:id/renew` with the current token as Bearer, and
 * the renewal response body `{ ok, credential }`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type EnforceScopeFn, routeAdmin } from "../admin-routes.ts";
import { DEFAULTS, loadConfig } from "../config.ts";
import { sweepCredentials } from "../credential-renewal.ts";
import {
  type CredentialPayload,
  applyCredentialPayload,
  createCredentialTokenProvider,
  credentialPathFor,
  listCredentials,
  markCredentialNeedsOperator,
  readCredential,
  resolveCredentialForSurface,
  resolveDiscoveryCredential,
} from "../credential-store.ts";
import { parseMeta } from "../meta-schema.ts";
import type { RegisteredUi } from "../ui-registry.ts";

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const tmpdirs: string[] = [];
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(d);
  return d;
}

function payload(overrides: Partial<CredentialPayload> = {}): CredentialPayload {
  return {
    kind: "credential",
    op: "provisioned",
    connection_id: "cred-surface-vault-default",
    key: "vault",
    vault: "default",
    scope: "vault:default:read",
    scoped_tags: ["public-site"],
    token: "jwt-token-1",
    jti: "jti-1",
    expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    renew_path: "/admin/connections/cred-surface-vault-default/renew",
    ...overrides,
  };
}

function makeUi(name: string, vault?: string): RegisteredUi {
  const meta = parseMeta({
    name,
    displayName: name,
    path: `/surface/${name}`,
    server: { entry: "server/index.js" },
    ...(vault ? { vault_default: vault } : {}),
  });
  return { dirName: name, uiDir: `/tmp/${name}`, distDir: `/tmp/${name}/dist`, meta };
}

const allow: EnforceScopeFn = async () => ({ scopes: ["surface:admin"] });
const deny: EnforceScopeFn = async () => Response.json({ error: "unauthorized" }, { status: 401 });

function adminOpts(credentialsDir: string, enforceScopeFn: EnforceScopeFn = allow) {
  return {
    state: { config: { ...DEFAULTS }, registeredUis: [], skippedUis: [] },
    credentialsDir,
    enforceScopeFn,
    logger: silent,
    skipSelfRegisterRefresh: true,
  };
}

function deliver(body: unknown, opts: ReturnType<typeof adminOpts>): Promise<Response> {
  const outcome = routeAdmin(
    new Request("http://x/surface/api/credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    opts,
  );
  if (!outcome.handled) throw new Error("credential route not handled");
  return Promise.resolve(outcome.response);
}

describe("POST /surface/api/credential (hub delivery)", () => {
  test("validates the bearer — unauthenticated deliveries are refused", async () => {
    const dir = tmpDir("creds-");
    const res = await deliver(payload(), adminOpts(dir, deny));
    expect(res.status).toBe(401);
    expect(listCredentials(dir)).toEqual([]);
  });

  test("provisioned payload persists 0600, keyed by connection id", async () => {
    const dir = tmpDir("creds-");
    const res = await deliver(payload(), adminOpts(dir));
    expect(res.status).toBe(200);
    const file = credentialPathFor("cred-surface-vault-default", dir);
    expect(existsSync(file)).toBe(true);
    // channels.json discipline: owner-only.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const rec = readCredential("cred-surface-vault-default", dir);
    expect(rec?.token).toBe("jwt-token-1");
    expect(rec?.scoped_tags).toEqual(["public-site"]);
    expect(rec?.status).toBe("ok");
  });

  test("renewed payload replaces the stored credential (and resets needs-operator)", async () => {
    const dir = tmpDir("creds-");
    await deliver(payload(), adminOpts(dir));
    const res = await deliver(
      payload({ op: "renewed", token: "jwt-token-2", jti: "jti-2" }),
      adminOpts(dir),
    );
    expect(res.status).toBe(200);
    const rec = readCredential("cred-surface-vault-default", dir);
    expect(rec?.token).toBe("jwt-token-2");
    expect(rec?.jti).toBe("jti-2");
    expect(rec?.status).toBe("ok");
  });

  test("removed payload drops our copy (hub teardown notify)", async () => {
    const dir = tmpDir("creds-");
    await deliver(payload(), adminOpts(dir));
    const res = await deliver(
      payload({ op: "removed", token: undefined, jti: undefined, expires_at: undefined }),
      adminOpts(dir),
    );
    expect(res.status).toBe(200);
    expect(existsSync(credentialPathFor("cred-surface-vault-default", dir))).toBe(false);
  });

  test("malformed payloads are 400 (kind, op, id charset, missing token)", async () => {
    const dir = tmpDir("creds-");
    const cases: unknown[] = [
      { ...payload(), kind: "secret" },
      { ...payload(), op: "minted" },
      { ...payload(), connection_id: "../escape" },
      { ...payload(), token: undefined },
      "not an object",
    ];
    for (const c of cases) {
      const res = await deliver(c, adminOpts(dir));
      expect(res.status).toBe(400);
    }
    expect(listCredentials(dir)).toEqual([]);
  });

  test("crafted renew_path outside /admin/connections/ is refused (nothing persisted)", async () => {
    const dir = tmpDir("creds-");
    for (const renew_path of [
      "/oauth/token",
      "/admin/users/promote",
      "admin/connections/x/renew",
    ]) {
      const res = await deliver(payload({ renew_path }), adminOpts(dir));
      expect(res.status).toBe(400);
    }
    expect(listCredentials(dir)).toEqual([]);
    // Absent renew_path falls back to the derived hub-connections default.
    await deliver(payload({ renew_path: undefined }), adminOpts(dir));
    expect(readCredential("cred-surface-vault-default", dir)?.renew_path).toBe(
      "/admin/connections/cred-surface-vault-default/renew",
    );
  });
});

describe("surface → credential binding (the params-shape delta)", () => {
  test("explicit config mapping wins", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ connection_id: "cred-a", vault: "default" }), dir);
    applyCredentialPayload(payload({ connection_id: "cred-b", vault: "default" }), dir);
    const res = resolveCredentialForSurface(makeUi("demo"), {
      dir,
      config: { credential_connections: { demo: "cred-b" } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.connection_id).toBe("cred-b");
  });

  test("single vault match binds automatically", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ connection_id: "cred-default", vault: "default" }), dir);
    applyCredentialPayload(payload({ connection_id: "cred-work", vault: "work" }), dir);
    const res = resolveCredentialForSurface(makeUi("demo", "work"), { dir });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.connection_id).toBe("cred-work");
  });

  test("multiple matches prefer the single READ credential (least privilege)", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(
      payload({ connection_id: "cred-read", scope: "vault:default:read" }),
      dir,
    );
    applyCredentialPayload(
      payload({ connection_id: "cred-write", scope: "vault:default:write" }),
      dir,
    );
    const res = resolveCredentialForSurface(makeUi("demo"), { dir });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.connection_id).toBe("cred-read");
  });

  test("ambiguity without a mapping is an explicit error", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ connection_id: "cred-1" }), dir);
    applyCredentialPayload(payload({ connection_id: "cred-2" }), dir);
    const res = resolveCredentialForSurface(makeUi("demo"), { dir });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("credential_connections");
  });

  test("END-TO-END: an operator mapping in the REAL config file wins (loadConfig → provider)", () => {
    // Reviewer item: prove the explicit-mapping branch is reachable through
    // the PRODUCTION config read path, not just an inline object — write a
    // real config.json, loadConfig() it, and thread it the way serve()
    // does (getConfig closure over the loaded config).
    const dir = tmpDir("creds-");
    const home = tmpDir("creds-home-");
    const configPath = path.join(home, "surface", "config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ credential_connections: { demo: "cred-2" } }));
    const loaded = loadConfig({ configPath, logger: silent });

    // Two WRITE credentials on the same vault: the heuristic chain
    // (single-match, then single-READ) cannot resolve this — ONLY the
    // operator's config mapping can.
    applyCredentialPayload(
      payload({ connection_id: "cred-1", scope: "vault:default:write", token: "tok-1" }),
      dir,
    );
    applyCredentialPayload(
      payload({ connection_id: "cred-2", scope: "vault:default:write", token: "tok-2" }),
      dir,
    );
    const provider = createCredentialTokenProvider(makeUi("demo"), {
      dir,
      getConfig: () => loaded,
    });
    expect(provider()).toBe("tok-2");
  });
});

describe("token provider (the P2↔P3 seam)", () => {
  test("resolves the stored token fresh per call", async () => {
    const dir = tmpDir("creds-");
    const provider = createCredentialTokenProvider(makeUi("demo"), { dir });
    expect(() => provider()).toThrow(/no vault credential provisioned/);
    applyCredentialPayload(payload(), dir);
    expect(provider()).toBe("jwt-token-1");
    applyCredentialPayload(payload({ op: "renewed", token: "jwt-token-2", jti: "j2" }), dir);
    expect(provider()).toBe("jwt-token-2"); // renewal visible without remount
  });

  test("needs-operator and expired credentials throw actionable errors", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ expires_at: "2020-01-01T00:00:00.000Z" }), dir);
    const provider = createCredentialTokenProvider(makeUi("demo"), { dir });
    expect(() => provider()).toThrow(/expired.*re-approve/);
  });
});

describe("renewal sweep (proof of possession against the hub)", () => {
  function inTestHub(handler: (req: Request) => Response | Promise<Response>) {
    const server = Bun.serve({ port: 0, fetch: handler });
    return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("happy path: within-horizon credential renews; stored record replaced", async () => {
    const dir = tmpDir("creds-");
    // Expires in 2 days — inside the 7-day horizon.
    const expiring = payload({
      expires_at: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    });
    applyCredentialPayload(expiring, dir);

    let sawBearer: string | null = null as string | null;
    const hub = inTestHub(async (req) => {
      const url = new URL(req.url);
      if (
        req.method === "POST" &&
        url.pathname === "/admin/connections/cred-surface-vault-default/renew"
      ) {
        sawBearer = req.headers.get("authorization");
        return Response.json({
          ok: true,
          credential: payload({
            op: "renewed",
            token: "jwt-renewed",
            jti: "jti-renewed",
            expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          }),
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const outcome = await sweepCredentials({ hubOrigin: hub.origin, dir, logger: silent });
      expect(outcome.renewed).toEqual(["cred-surface-vault-default"]);
      // Proof of possession: the CURRENT token rode as Bearer.
      expect(sawBearer).toBe("Bearer jwt-token-1");
      const rec = readCredential("cred-surface-vault-default", dir);
      expect(rec?.token).toBe("jwt-renewed");
      expect(rec?.status).toBe("ok");
    } finally {
      hub.stop();
    }
  });

  test("far-from-expiry credentials are left alone", async () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload(), dir); // ~90 days out
    let hubCalls = 0;
    const hub = inTestHub(() => {
      hubCalls++;
      return Response.json({ ok: true });
    });
    try {
      const outcome = await sweepCredentials({ hubOrigin: hub.origin, dir, logger: silent });
      expect(outcome.renewed).toEqual([]);
      expect(hubCalls).toBe(0);
    } finally {
      hub.stop();
    }
  });

  test("terminal 401 → needs-operator, and the sweep STOPS retrying (no spin)", async () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ expires_at: new Date(Date.now() + 1000).toISOString() }), dir);
    let hubCalls = 0;
    const hub = inTestHub(() => {
      hubCalls++;
      return Response.json({ error: "invalid_credential" }, { status: 401 });
    });
    try {
      const first = await sweepCredentials({ hubOrigin: hub.origin, dir, logger: silent });
      expect(first.needsOperator).toEqual(["cred-surface-vault-default"]);
      expect(readCredential("cred-surface-vault-default", dir)?.status).toBe("needs-operator");
      expect(hubCalls).toBe(1);

      // Second sweep: needs-operator is terminal — the hub is NOT re-asked.
      const second = await sweepCredentials({ hubOrigin: hub.origin, dir, logger: silent });
      expect(second.needsOperator).toEqual([]);
      expect(hubCalls).toBe(1);

      // The token provider refuses it with the operator-actionable message.
      const provider = createCredentialTokenProvider(makeUi("demo"), { dir });
      expect(() => provider()).toThrow(/needs operator re-approval/);

      // Operator re-approval re-delivers via the endpoint → usable again.
      applyCredentialPayload(payload({ token: "jwt-fresh", jti: "j3" }), dir);
      expect(provider()).toBe("jwt-fresh");
    } finally {
      hub.stop();
    }
  });

  test("transient failures (5xx) are retried next sweep, not marked terminal", async () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ expires_at: new Date(Date.now() + 1000).toISOString() }), dir);
    const hub = inTestHub(() => new Response("boom", { status: 503 }));
    try {
      const outcome = await sweepCredentials({ hubOrigin: hub.origin, dir, logger: silent });
      expect(outcome.failed.length).toBe(1);
      expect(readCredential("cred-surface-vault-default", dir)?.status).toBe("ok");
    } finally {
      hub.stop();
    }
  });
});

describe("resolveDiscoveryCredential (surface discovery)", () => {
  test("picks a usable read credential for the vault", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload(), dir);
    const rec = resolveDiscoveryCredential("default", { dir });
    expect(rec?.connection_id).toBe("cred-surface-vault-default");
  });

  test("prefers the broadest read credential (fewest scoped_tags)", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ connection_id: "narrow", scoped_tags: ["a", "b", "c"] }), dir);
    applyCredentialPayload(payload({ connection_id: "broad", scoped_tags: [] }), dir);
    expect(resolveDiscoveryCredential("default", { dir })?.connection_id).toBe("broad");
  });

  test("returns null when no read credential exists for the vault", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ vault: "other" }), dir);
    expect(resolveDiscoveryCredential("default", { dir })).toBeNull();
  });

  test("ignores a write credential (discovery is read-only)", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(
      payload({ connection_id: "w", scope: "vault:default:write", scoped_tags: [] }),
      dir,
    );
    expect(resolveDiscoveryCredential("default", { dir })).toBeNull();
  });

  test("ignores an expired read credential", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload({ expires_at: new Date(Date.now() - 1000).toISOString() }), dir);
    expect(resolveDiscoveryCredential("default", { dir })).toBeNull();
  });

  test("ignores a needs-operator read credential", () => {
    const dir = tmpDir("creds-");
    applyCredentialPayload(payload(), dir);
    markCredentialNeedsOperator("cred-surface-vault-default", dir);
    expect(resolveDiscoveryCredential("default", { dir })).toBeNull();
  });
});
