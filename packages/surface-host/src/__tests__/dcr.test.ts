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
  readOauthClientFile,
  registerOauthClient,
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
