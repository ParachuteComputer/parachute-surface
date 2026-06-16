/**
 * Tests for `src/dcr.ts` — DCR registration shape + persistence + revoke.
 *
 * Coverage:
 *   - registerOauthClient sends RFC 7591-shaped body
 *   - registerOauthClient sends Authorization when operatorToken present
 *   - registerOauthClient surfaces hub 4xx as DcrError code:"hub_rejected"
 *   - registerOauthClient surfaces network failure as code:"hub_unreachable"
 *   - registerOauthClient throws on response missing client_id
 *   - writeOauthClientFile + readOauthClientFile round-trip
 *   - readOauthClientFile returns undefined when file absent
 *   - unregisterOauthClient calls DELETE /oauth/clients/<id> + removes local
 *   - unregisterOauthClient tolerates hub unreachable
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DcrError,
  type OauthClientRecord,
  buildSurfaceRedirectUris,
  knownHubOrigins,
  readOauthClientFile,
  registerOauthClient,
  selfHealRedirectUris,
  unregisterOauthClient,
  writeOauthClientFile,
} from "../dcr.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-dcr-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Save/clear/restore PARACHUTE_HUB_ORIGIN around an env-sensitive block.
 * The single biome-ignore lives here so the surface#118 blocks below don't
 * each repeat it (matches the convention in auth.test.ts / http-server.test.ts).
 */
function setHubOriginEnv(value: string | undefined): void {
  // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
  if (value === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = value;
}

describe("registerOauthClient", () => {
  test("sends RFC 7591-shaped body with no auth", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch: import("../dcr.ts").FetchFn = (url, init) => {
      captured = { url: url as string, init: init as RequestInit };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "client_abc",
            redirect_uris: ["http://hub/surface/test/", "http://hub/surface/test/oauth-callback"],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            client_id_issued_at: 1700000000,
            status: "pending",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const res = await registerOauthClient({
      hubUrl: "http://hub/",
      clientName: "Test UI",
      redirectUris: ["http://hub/surface/test/", "http://hub/surface/test/oauth-callback"],
      scopes: ["vault:default:read", "vault:default:write"],
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(res.client_id).toBe("client_abc");
    expect(captured?.url).toBe("http://hub/oauth/register");
    expect(captured?.init.method).toBe("POST");
    const body = JSON.parse(captured?.init.body as string);
    expect(body.client_name).toBe("Test UI");
    expect(body.redirect_uris).toHaveLength(2);
    expect(body.scope).toBe("vault:default:read vault:default:write");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.response_types).toEqual(["code"]);
    const headers = (captured?.init.headers as Record<string, string>) ?? {};
    expect(headers.authorization).toBeUndefined();
  });

  test("sends Authorization when operatorToken present", async () => {
    let captured: { init: RequestInit } | undefined;
    const fakeFetch: import("../dcr.ts").FetchFn = (_url, init) => {
      captured = { init: init as RequestInit };
      return Promise.resolve(
        new Response(JSON.stringify({ client_id: "client_xyz" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    await registerOauthClient({
      hubUrl: "http://hub",
      clientName: "Test",
      redirectUris: ["http://hub/surface/test/"],
      scopes: ["vault:*:read"],
      operatorToken: "op-token-123",
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    const headers = (captured?.init.headers as Record<string, string>) ?? {};
    expect(headers.authorization).toBe("Bearer op-token-123");
  });

  test("hub 4xx → DcrError code:'hub_rejected' with body folded in", async () => {
    const fakeFetch: import("../dcr.ts").FetchFn = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "invalid_client_metadata", error_description: "bad scope" }),
          { status: 400 },
        ),
      );
    let caught: unknown;
    try {
      await registerOauthClient({
        hubUrl: "http://hub",
        clientName: "Test",
        redirectUris: ["http://hub/surface/test/"],
        scopes: ["bad:scope"],
        fetchFn: fakeFetch,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DcrError);
    if (caught instanceof DcrError) {
      expect(caught.status).toBe("hub_rejected");
      expect(caught.hubResponseStatus).toBe(400);
      expect(caught.hubResponseBody).toContain("bad scope");
    }
  });

  test("network failure → DcrError code:'hub_unreachable'", async () => {
    const fakeFetch: import("../dcr.ts").FetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
    let caught: unknown;
    try {
      await registerOauthClient({
        hubUrl: "http://127.0.0.1:1",
        clientName: "Test",
        redirectUris: ["http://hub/surface/test/"],
        scopes: [],
        fetchFn: fakeFetch,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DcrError);
    if (caught instanceof DcrError) {
      expect(caught.status).toBe("hub_unreachable");
    }
  });

  test("response missing client_id → DcrError code:'invalid_response'", async () => {
    const fakeFetch: import("../dcr.ts").FetchFn = () =>
      Promise.resolve(
        new Response(JSON.stringify({ no_client_id_here: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    let caught: unknown;
    try {
      await registerOauthClient({
        hubUrl: "http://hub",
        clientName: "Test",
        redirectUris: ["http://hub/surface/test/"],
        scopes: [],
        fetchFn: fakeFetch,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DcrError);
    if (caught instanceof DcrError) {
      expect(caught.status).toBe("invalid_response");
    }
  });
});

describe("writeOauthClientFile + readOauthClientFile", () => {
  test("round-trip succeeds", () => {
    const record: OauthClientRecord = {
      client_id: "client_abc",
      client_name: "Test UI",
      redirect_uris: ["http://hub/surface/test/"],
      scope: "vault:*:read",
      registered_at: new Date().toISOString(),
      hub_url: "http://hub",
    };
    const filePath = writeOauthClientFile(tmp, record);
    expect(fs.existsSync(filePath)).toBe(true);
    const read = readOauthClientFile(tmp);
    expect(read?.client_id).toBe("client_abc");
    expect(read?.scope).toBe("vault:*:read");
  });

  test("mode is 0o600 on Unix", () => {
    if (process.platform === "win32") return;
    writeOauthClientFile(tmp, {
      client_id: "x",
      client_name: "x",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const st = fs.statSync(path.join(tmp, ".oauth-client.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("readOauthClientFile returns undefined on missing file", () => {
    expect(readOauthClientFile(tmp)).toBeUndefined();
  });

  test("readOauthClientFile returns undefined on malformed JSON", () => {
    fs.writeFileSync(path.join(tmp, ".oauth-client.json"), "not json {");
    expect(readOauthClientFile(tmp)).toBeUndefined();
  });
});

describe("unregisterOauthClient", () => {
  test("happy path: DELETE returns 204, local file removed", async () => {
    writeOauthClientFile(tmp, {
      client_id: "client_to_delete",
      client_name: "x",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    let called = false;
    const fakeFetch: import("../dcr.ts").FetchFn = (url, init) => {
      called = true;
      expect(url).toBe("http://hub/oauth/clients/client_to_delete");
      expect((init as RequestInit).method).toBe("DELETE");
      return Promise.resolve(new Response("", { status: 204 }));
    };
    const result = await unregisterOauthClient({
      hubUrl: "http://hub",
      clientId: "client_to_delete",
      uiDir: tmp,
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(called).toBe(true);
    expect(result.hubDeleteStatus).toBe("ok");
    expect(result.localFileRemoved).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".oauth-client.json"))).toBe(false);
  });

  test("DELETE returns 404 → 'not_found' or 'unsupported', still removes local", async () => {
    writeOauthClientFile(tmp, {
      client_id: "stale",
      client_name: "x",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const fakeFetch: import("../dcr.ts").FetchFn = () =>
      Promise.resolve(new Response("not found", { status: 404 }));
    const result = await unregisterOauthClient({
      hubUrl: "http://hub",
      clientId: "stale",
      uiDir: tmp,
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(["not_found", "unsupported"]).toContain(result.hubDeleteStatus);
    expect(result.localFileRemoved).toBe(true);
  });

  test("hub unreachable → 'unreachable' status, still removes local", async () => {
    writeOauthClientFile(tmp, {
      client_id: "x",
      client_name: "x",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const fakeFetch: import("../dcr.ts").FetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
    const result = await unregisterOauthClient({
      hubUrl: "http://hub",
      clientId: "x",
      uiDir: tmp,
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(result.hubDeleteStatus).toBe("unreachable");
    expect(result.localFileRemoved).toBe(true);
  });

  test("no clientId + no local file → skipped, no-op", async () => {
    const fakeFetch: import("../dcr.ts").FetchFn = () =>
      Promise.reject(new Error("should not be called"));
    const result = await unregisterOauthClient({
      hubUrl: "http://hub",
      clientId: undefined,
      uiDir: tmp,
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(result.hubDeleteStatus).toBe("skipped");
    expect(result.localFileRemoved).toBe(true);
  });
});

// ===========================================================================
// surface#118 — multi-hub-origin redirect_uri registration + boot self-heal
// ===========================================================================

describe("knownHubOrigins (surface#118)", () => {
  const LOOPBACK = "http://127.0.0.1:1939";
  const PUBLIC = "https://box.taildf9ce2.ts.net";
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.PARACHUTE_HUB_ORIGIN;
    setHubOriginEnv(undefined);
  });
  afterEach(() => {
    setHubOriginEnv(savedEnv);
  });

  test("loopback-only box (no env): single origin", () => {
    expect(knownHubOrigins(LOOPBACK)).toEqual([LOOPBACK]);
  });

  test("exposed box (PARACHUTE_HUB_ORIGIN set): includes BOTH public + loopback", () => {
    process.env.PARACHUTE_HUB_ORIGIN = PUBLIC;
    const origins = knownHubOrigins(LOOPBACK);
    // env-resolved public origin first, loopback second.
    expect(origins).toContain(PUBLIC);
    expect(origins).toContain(LOOPBACK);
    expect(origins[0]).toBe(PUBLIC);
  });

  test("env equal to config.hub_url collapses (no dupe)", () => {
    process.env.PARACHUTE_HUB_ORIGIN = LOOPBACK;
    expect(knownHubOrigins(LOOPBACK)).toEqual([LOOPBACK]);
  });
});

describe("buildSurfaceRedirectUris (surface#118)", () => {
  const LOOPBACK = "http://127.0.0.1:1939";
  const PUBLIC = "https://box.taildf9ce2.ts.net";
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.PARACHUTE_HUB_ORIGIN;
    setHubOriginEnv(undefined);
  });
  afterEach(() => {
    setHubOriginEnv(savedEnv);
  });

  test("loopback-only: three callback forms on loopback", () => {
    expect(buildSurfaceRedirectUris(LOOPBACK, "/surface/notes")).toEqual([
      `${LOOPBACK}/surface/notes/`,
      `${LOOPBACK}/surface/notes/oauth/callback`,
      `${LOOPBACK}/surface/notes/oauth-callback`,
    ]);
  });

  test("exposed box: the three forms registered on BOTH origins (the fix)", () => {
    process.env.PARACHUTE_HUB_ORIGIN = PUBLIC;
    const uris = buildSurfaceRedirectUris(LOOPBACK, "/surface/notes");
    // Public-origin runtime callback — what window.location.origin produces.
    expect(uris).toContain(`${PUBLIC}/surface/notes/oauth/callback`);
    expect(uris).toContain(`${PUBLIC}/surface/notes/`);
    expect(uris).toContain(`${PUBLIC}/surface/notes/oauth-callback`);
    // Loopback forms still there for the local-box flow.
    expect(uris).toContain(`${LOOPBACK}/surface/notes/oauth/callback`);
    expect(uris).toContain(`${LOOPBACK}/surface/notes/`);
  });
});

describe("selfHealRedirectUris (surface#118 boot self-heal)", () => {
  const LOOPBACK = "http://127.0.0.1:1939";
  const PUBLIC = "https://box.taildf9ce2.ts.net";
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.PARACHUTE_HUB_ORIGIN;
    setHubOriginEnv(undefined);
  });
  afterEach(() => {
    setHubOriginEnv(savedEnv);
  });

  function seedUi(name: string, mountPath: string, redirectUris: string[]): string {
    const uiDir = path.join(tmp, name);
    fs.mkdirSync(uiDir, { recursive: true });
    const record: OauthClientRecord = {
      client_id: `client_${name}`,
      client_name: `Surface ${name}`,
      redirect_uris: redirectUris,
      scope: "vault:default:read",
      status: "approved",
      registered_at: new Date().toISOString(),
      hub_url: LOOPBACK,
    };
    writeOauthClientFile(uiDir, record);
    return uiDir;
  }

  test("loopback-only registration on a now-exposed box → re-registers with public origin", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = PUBLIC;
    const uiDir = seedUi("notes", "/surface/notes", [
      `${LOOPBACK}/surface/notes/`,
      `${LOOPBACK}/surface/notes/oauth/callback`,
      `${LOOPBACK}/surface/notes/oauth-callback`,
    ]);

    let sentUris: string[] | undefined;
    const fakeFetch: import("../dcr.ts").FetchFn = (_url, init) => {
      sentUris = JSON.parse(String(init?.body)).redirect_uris as string[];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            client_id: "client_notes",
            client_name: "Surface notes",
            redirect_uris: sentUris,
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            client_id_issued_at: 1,
            status: "approved",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const outcome = await selfHealRedirectUris({
      uis: [{ uiDir, meta: { path: "/surface/notes", scopes_required: ["vault:default:read"] } }],
      hubUrl: LOOPBACK,
      operatorToken: "op-token",
      fetchFn: fakeFetch,
      logger: silentLogger,
    });

    expect(outcome.reregistered).toEqual([uiDir]);
    // The re-register sent the public-origin runtime callback — the missing URI.
    expect(sentUris).toContain(`${PUBLIC}/surface/notes/oauth/callback`);
    // On-disk record updated to include the public origin.
    const onDisk = readOauthClientFile(uiDir);
    expect(onDisk?.redirect_uris).toContain(`${PUBLIC}/surface/notes/oauth/callback`);
  });

  test("already covers every known origin → no re-register (no network call)", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = PUBLIC;
    const uiDir = seedUi(
      "notes",
      "/surface/notes",
      buildSurfaceRedirectUris(LOOPBACK, "/surface/notes"),
    );
    let called = false;
    const fakeFetch: import("../dcr.ts").FetchFn = () => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const outcome = await selfHealRedirectUris({
      uis: [{ uiDir, meta: { path: "/surface/notes" } }],
      hubUrl: LOOPBACK,
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(called).toBe(false);
    expect(outcome.upToDate).toEqual([uiDir]);
    expect(outcome.reregistered).toEqual([]);
  });

  test("UI with no .oauth-client.json is skipped (not counted)", async () => {
    const uiDir = path.join(tmp, "unregistered");
    fs.mkdirSync(uiDir, { recursive: true });
    const outcome = await selfHealRedirectUris({
      uis: [{ uiDir, meta: { path: "/surface/unregistered" } }],
      hubUrl: LOOPBACK,
      logger: silentLogger,
    });
    expect(outcome.checked).toBe(0);
    expect(outcome.reregistered).toEqual([]);
  });

  test("hub-unreachable re-register is best-effort (recorded as failed, not thrown)", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = PUBLIC;
    const uiDir = seedUi("notes", "/surface/notes", [`${LOOPBACK}/surface/notes/`]);
    const fakeFetch: import("../dcr.ts").FetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
    const outcome = await selfHealRedirectUris({
      uis: [{ uiDir, meta: { path: "/surface/notes" } }],
      hubUrl: LOOPBACK,
      fetchFn: fakeFetch,
      logger: silentLogger,
    });
    expect(outcome.reregistered).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.uiDir).toBe(uiDir);
    // On-disk record untouched on failure.
    expect(readOauthClientFile(uiDir)?.redirect_uris).toEqual([`${LOOPBACK}/surface/notes/`]);
  });
});
