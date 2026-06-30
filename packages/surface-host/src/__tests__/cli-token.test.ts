/**
 * Tests for `cli-token.ts` — the CLI's operator-token → surface:admin mint.
 *
 * The CLI can't present the operator token directly (it's `aud: "operator"`;
 * the daemon demands `aud: "surface"`), so it exchanges it for a short-lived
 * `surface:admin` token at the hub's `POST /api/auth/mint-token`. These tests
 * pin the request shape and every failure surface via an injected `fetchFn`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_MINT_SCOPE, CLI_MINT_TTL_SECONDS, CliTokenError, mintCliToken } from "../cli-token.ts";

const OPERATOR = "operator.jwt.value";
const HUB = "http://127.0.0.1:1939";

/** A fetch double that records the single call it receives. */
function recordingFetch(response: Response): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("mintCliToken", () => {
  test("exchanges the operator token for a surface:admin token", async () => {
    const { fetchFn, calls } = recordingFetch(
      Response.json({ token: "surface.jwt.minted", scope: CLI_MINT_SCOPE }),
    );

    const token = await mintCliToken({ operatorToken: OPERATOR, hubOrigin: HUB, fetchFn });

    expect(token).toBe("surface.jwt.minted");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${HUB}/api/auth/mint-token`);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${OPERATOR}`);
    expect(headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(String(call.init.body));
    expect(sent.scope).toBe(CLI_MINT_SCOPE);
    expect(sent.expires_in).toBe(CLI_MINT_TTL_SECONDS);
  });

  test("trims a trailing slash from the hub origin", async () => {
    const { fetchFn, calls } = recordingFetch(Response.json({ token: "t" }));
    await mintCliToken({ operatorToken: OPERATOR, hubOrigin: "http://127.0.0.1:1939/", fetchFn });
    expect(calls[0]!.url).toBe("http://127.0.0.1:1939/api/auth/mint-token");
  });

  test("returns undefined when no operator token is available", async () => {
    // No PARACHUTE_HUB_TOKEN, PARACHUTE_HOME pointed at an empty dir → the
    // on-disk operator.token lookup misses. fetch must never be called.
    const prevHome = process.env.PARACHUTE_HOME;
    const prevTok = process.env.PARACHUTE_HUB_TOKEN;
    const emptyHome = mkdtempSync(join(tmpdir(), "cli-token-test-"));
    process.env.PARACHUTE_HOME = emptyHome;
    process.env.PARACHUTE_HUB_TOKEN = "";
    try {
      const fetchFn = (async () => {
        throw new Error("fetch should not be called when there is no operator token");
      }) as unknown as typeof fetch;
      const token = await mintCliToken({ hubOrigin: HUB, fetchFn });
      expect(token).toBeUndefined();
    } finally {
      // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
      if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
      else process.env.PARACHUTE_HOME = prevHome;
      // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
      if (prevTok === undefined) delete process.env.PARACHUTE_HUB_TOKEN;
      else process.env.PARACHUTE_HUB_TOKEN = prevTok;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("throws hub_unreachable when the hub fetch fails", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    try {
      await mintCliToken({ operatorToken: OPERATOR, hubOrigin: HUB, fetchFn });
      throw new Error("expected mintCliToken to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliTokenError);
      expect((e as CliTokenError).code).toBe("hub_unreachable");
      expect((e as CliTokenError).message).toContain("couldn't reach the hub");
    }
  });

  test("throws mint_rejected with a rotate hint on 401", async () => {
    const { fetchFn } = recordingFetch(
      Response.json(
        { error: "unauthenticated", error_description: "bearer token invalid — expired" },
        { status: 401 },
      ),
    );
    try {
      await mintCliToken({ operatorToken: OPERATOR, hubOrigin: HUB, fetchFn });
      throw new Error("expected mintCliToken to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliTokenError);
      expect((e as CliTokenError).code).toBe("mint_rejected");
      expect((e as CliTokenError).message).toContain("rotate-operator");
    }
  });

  test("throws mint_rejected with an authority hint on 403", async () => {
    const { fetchFn } = recordingFetch(
      Response.json(
        { error: "insufficient_scope", error_description: "no minting authority" },
        { status: 403 },
      ),
    );
    try {
      await mintCliToken({ operatorToken: OPERATOR, hubOrigin: HUB, fetchFn });
      throw new Error("expected mintCliToken to throw");
    } catch (e) {
      expect((e as CliTokenError).code).toBe("mint_rejected");
      expect((e as CliTokenError).message).toContain("parachute:host:auth");
    }
  });

  test("throws bad_response when the 2xx body has no token", async () => {
    const { fetchFn } = recordingFetch(Response.json({ jti: "abc", scope: CLI_MINT_SCOPE }));
    try {
      await mintCliToken({ operatorToken: OPERATOR, hubOrigin: HUB, fetchFn });
      throw new Error("expected mintCliToken to throw");
    } catch (e) {
      expect((e as CliTokenError).code).toBe("bad_response");
    }
  });

  test("throws bad_response on a non-JSON 2xx body", async () => {
    const { fetchFn } = recordingFetch(new Response("not json", { status: 200 }));
    try {
      await mintCliToken({ operatorToken: OPERATOR, hubOrigin: HUB, fetchFn });
      throw new Error("expected mintCliToken to throw");
    } catch (e) {
      expect((e as CliTokenError).code).toBe("bad_response");
    }
  });

  test("honors a custom scope + ttl override", async () => {
    const { fetchFn, calls } = recordingFetch(Response.json({ token: "t" }));
    await mintCliToken({
      operatorToken: OPERATOR,
      hubOrigin: HUB,
      fetchFn,
      scope: "surface:read",
      ttlSeconds: 60,
    });
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.scope).toBe("surface:read");
    expect(sent.expires_in).toBe(60);
  });
});
