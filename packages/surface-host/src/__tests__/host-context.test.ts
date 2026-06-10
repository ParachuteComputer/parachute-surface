/**
 * P2 — SurfaceHostContext + ScopedVaultClient: the keystone injection.
 *
 * Covers:
 *   - layer/clientIp: hub-stamped header reads, FAIL-CLOSED on absence /
 *     garbage (direct-to-1946 access gets no trust)
 *   - ScopedVaultClient: no token accessor (runtime + typecheck-level),
 *     force-write rejection, requests carry the tokenProvider's Bearer
 *     internally (fetchAttachmentBlob included)
 *   - the context builder: store lifecycle (closed on signal abort, file
 *     persists), per-surface config dynamic re-read, prefixed logger,
 *     vault bound to vault_default
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULTS } from "../config.ts";
import {
  PARACHUTE_CLIENT_IP_HEADER,
  PARACHUTE_LAYER_HEADER,
  clientIpFromRequest,
  createHostContextBuilder,
  layerFromRequest,
  surfaceConfigPathFor,
  surfaceLoggerFor,
} from "../host-context.ts";
import { parseMeta } from "../meta-schema.ts";
import { ScopedVaultClient } from "../scoped-vault-client.ts";
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

function makeUi(name: string, extras: Record<string, unknown> = {}): RegisteredUi {
  const meta = parseMeta({
    name,
    displayName: name,
    path: `/surface/${name}`,
    server: { entry: "server/index.js" },
    ...extras,
  });
  return { dirName: name, uiDir: `/tmp/${name}`, distDir: `/tmp/${name}/dist`, meta };
}

describe("layer/clientIp — substrate-stamped, fail-closed (§10)", () => {
  test("hub-stamped values are read verbatim", () => {
    const req = new Request("http://x/", {
      headers: {
        [PARACHUTE_LAYER_HEADER]: "tailnet",
        [PARACHUTE_CLIENT_IP_HEADER]: "100.99.1.2",
      },
    });
    expect(layerFromRequest(req)).toBe("tailnet");
    expect(clientIpFromRequest(req)).toBe("100.99.1.2");
  });

  test("absent headers (direct-to-1946) → 'public' / null", () => {
    const req = new Request("http://127.0.0.1:1946/surface/x/api/y");
    expect(layerFromRequest(req)).toBe("public");
    expect(clientIpFromRequest(req)).toBeNull();
  });

  // Note: whitespace-padded values ("loopback ") are normalized by the
  // platform's Headers layer (fetch-spec OWS trim) before our code sees
  // them, so they aren't a distinguishable garbage case.
  test("garbage layer values fail closed to 'public'", () => {
    for (const v of ["LOOPBACK", "local", "trusted", "loopback,public"]) {
      const req = new Request("http://x/", { headers: { [PARACHUTE_LAYER_HEADER]: v } });
      expect(layerFromRequest(req)).toBe("public");
    }
  });

  test("loopback stamp is honored (the hub stripped inbound forgeries)", () => {
    const req = new Request("http://x/", { headers: { [PARACHUTE_LAYER_HEADER]: "loopback" } });
    expect(layerFromRequest(req)).toBe("loopback");
  });

  test("header names match the hub's stamps byte-for-byte", () => {
    expect(PARACHUTE_LAYER_HEADER).toBe("x-parachute-layer");
    expect(PARACHUTE_CLIENT_IP_HEADER).toBe("x-parachute-client-ip");
  });
});

describe("ScopedVaultClient — capability, never secret", () => {
  function capturingFetch(): {
    calls: Array<{ url: string; auth: string | null }>;
    fetchImpl: typeof fetch;
  } {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      return Response.json([]);
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  test("exposes NO token accessor at runtime (inner client is #private)", () => {
    const client = new ScopedVaultClient({
      hubOrigin: "http://hub.test",
      vaultName: "default",
      tokenProvider: () => "tok-secret",
    });
    const raw = client as unknown as Record<string, unknown>;
    expect(raw.getAccessToken).toBeUndefined();
    expect(raw.setAccessToken).toBeUndefined();
    expect(raw.token).toBeUndefined();
    expect(raw.accessToken).toBeUndefined();
    expect(raw.tokenProvider).toBeUndefined();
    expect(raw.inner).toBeUndefined();
    // Nothing token-shaped is enumerable either.
    expect(JSON.stringify(client)).not.toContain("tok-secret");
    // Typecheck-level exclusions (consumed by the tsc gate):
    // @ts-expect-error — ScopedVaultClient must not expose setAccessToken
    client.setAccessToken;
    // @ts-expect-error — ScopedVaultClient must not expose getAccessToken
    client.getAccessToken;
    // @ts-expect-error — ScopedVaultClient must not expose vaultBaseUrl's inner client
    client.resolveToken;
  });

  test("requests carry the tokenProvider's Bearer internally", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const client = new ScopedVaultClient({
      hubOrigin: "http://hub.test",
      vaultName: "work",
      tokenProvider: () => "scoped-cred-123",
      fetchImpl,
    });
    await client.queryNotes({ tag: "meeting" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toStartWith("http://hub.test/vault/work/api/notes");
    expect(calls[0]!.auth).toBe("Bearer scoped-cred-123");
  });

  test("fetchAttachmentBlob stays internal-token (backend never sees the Bearer)", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(new Blob([new Uint8Array([7])]), { status: 200 });
    }) as typeof fetch;
    const client = new ScopedVaultClient({
      hubOrigin: "http://hub.test",
      vaultName: "default",
      tokenProvider: () => "blob-cred",
      fetchImpl,
    });
    const blob = await client.fetchAttachmentBlob(
      "http://hub.test/vault/default/api/storage/file.png",
    );
    expect(blob.size).toBe(1);
    expect(calls[0]!.auth).toBe("Bearer blob-cred");
  });

  test("force writes are rejected (allowForce never set in v1)", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const client = new ScopedVaultClient({
      hubOrigin: "http://hub.test",
      vaultName: "default",
      tokenProvider: () => "t",
      fetchImpl,
    });
    expect(client.updateNote("note-1", { content: "x", force: true })).rejects.toThrow(
      /force.*not permitted/,
    );
    // The rejection happens BEFORE any network call.
    expect(calls.length).toBe(0);
    // Non-force updates pass through.
    await client.updateNote("note-1", { content: "x", if_updated_at: "2026-01-01T00:00:00Z" });
    expect(calls.length).toBe(1);
  });

  test("allowForce: true (explicit, host never sets it) permits force", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const client = new ScopedVaultClient({
      hubOrigin: "http://hub.test",
      vaultName: "default",
      tokenProvider: () => "t",
      fetchImpl,
      allowForce: true,
    });
    await client.updateNote("note-1", { content: "x", force: true });
    expect(calls.length).toBe(1);
  });

  test("tokenProvider errors propagate unchanged (no-credential path)", async () => {
    const client = new ScopedVaultClient({
      hubOrigin: "http://hub.test",
      vaultName: "default",
      tokenProvider: () => {
        throw new Error('no vault credential provisioned for surface "demo"');
      },
    });
    expect(client.queryNotes({ tag: "x" })).rejects.toThrow(/no vault credential provisioned/);
  });
});

describe("createHostContextBuilder", () => {
  function build(ui: RegisteredUi, stateDir: string) {
    const controller = new AbortController();
    const builder = createHostContextBuilder({
      config: { ...DEFAULTS, hub_url: "http://hub.test" },
      logger: silent,
      stateDir,
      tokenProviderFor: () => () => "ctx-token",
    });
    return { ctx: builder(ui, controller.signal), controller };
  }

  test("store is per-surface, file-backed, closed on signal abort", () => {
    const stateDir = tmpDir("hostctx-");
    const { ctx, controller } = build(makeUi("alpha"), stateDir);
    ctx.store.put("k", "v");
    expect(new TextDecoder().decode(ctx.store.get("k")!.blob)).toBe("v");
    expect(ctx.store.path).toBe(path.join(stateDir, "alpha.sqlite"));
    controller.abort();
    expect(() => ctx.store.get("k")).toThrow(/closed/);
  });

  test("config is re-read per call (admin edits take effect live)", () => {
    const stateDir = tmpDir("hostctx-");
    const { ctx } = build(makeUi("beta"), stateDir);
    expect(ctx.config.all()).toEqual({});
    expect(ctx.config.get("theme")).toBeUndefined();
    writeFileSync(surfaceConfigPathFor("beta", stateDir), JSON.stringify({ theme: "dark" }));
    expect(ctx.config.get("theme")).toBe("dark");
    writeFileSync(surfaceConfigPathFor("beta", stateDir), "{not json");
    expect(ctx.config.all()).toEqual({}); // malformed → {} + warn, never throw
  });

  test("vault is bound to vault_default (falling back to 'default')", () => {
    const stateDir = tmpDir("hostctx-");
    const pinned = build(makeUi("gamma", { vault_default: "work" }), stateDir);
    expect(pinned.ctx.vault.vaultName).toBe("work");
    const fallback = build(makeUi("delta"), stateDir);
    expect(fallback.ctx.vault.vaultName).toBe("default");
  });

  test("mount + shutdownSignal + prefixed log are wired", () => {
    const stateDir = tmpDir("hostctx-");
    const lines: unknown[][] = [];
    const builder = createHostContextBuilder({
      config: { ...DEFAULTS },
      logger: { log: (...a: unknown[]) => lines.push(a), warn: () => {}, error: () => {} },
      stateDir,
      tokenProviderFor: () => () => "t",
    });
    const controller = new AbortController();
    const ctx = builder(makeUi("epsilon"), controller.signal);
    expect(ctx.mount).toBe("/surface/epsilon");
    expect(ctx.shutdownSignal.aborted).toBe(false);
    ctx.log.log("hello");
    expect(lines[0]).toEqual(["[surface:epsilon]", "hello"]);
    controller.abort();
    expect(ctx.shutdownSignal.aborted).toBe(true);
  });

  test("surfaceLoggerFor prefixes warn/error too", () => {
    const warns: unknown[][] = [];
    const log = surfaceLoggerFor(
      { log: () => {}, warn: (...a: unknown[]) => warns.push(a), error: () => {} },
      "zeta",
    );
    log.warn("careful");
    expect(warns[0]).toEqual(["[surface:zeta]", "careful"]);
  });
});
