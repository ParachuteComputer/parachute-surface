/**
 * P4 + P6 — routing structural containment, WS multiplexing, host-injected
 * security headers. Integration-style: a REAL Bun server (port 0) with
 * real backends mounted from tmpdir surfaces, exercised over loopback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BackendSupervisor } from "../backend-supervisor.ts";
import { DEFAULTS } from "../config.ts";
import { createHostContextBuilder } from "../host-context.ts";
import { type AppState, startHttpServer } from "../http-server.ts";
import { parseMeta } from "../meta-schema.ts";
import { buildCspValue } from "../security-headers.ts";
import type { RegisteredUi } from "../ui-registry.ts";

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const tmpdirs: string[] = [];
const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Source for a backend that records every pathname it is asked to serve.
 * The recording rides a per-surface file in the surface's own tmpdir (path
 * baked into the generated source) — the dynamically-imported module can't
 * close over test scope, and a file keeps the capture closure-scoped to
 * the test (via the returned `seen()` reader) instead of globalThis.
 */
function recordingBackendSource(seenFile: string): string {
  return `
import { appendFileSync } from "node:fs";
export default (ctx) => ({
  fetch(req) {
    const url = new URL(req.url);
    appendFileSync(${JSON.stringify(seenFile)}, req.method + " " + url.pathname + "\\n");
    return Response.json({ via: "backend", path: url.pathname, mount: ctx.mount });
  },
});`;
}

/** Minimal healthy backend for tests that don't need request recording. */
const PLAIN_BACKEND = `export default (ctx) => ({
  fetch() { return Response.json({ via: "backend", mount: ctx.mount }); },
});`;

const ECHO_WS_BACKEND = `export default (ctx) => ({
  fetch() { return Response.json({ ok: true }); },
  websocket: {
    open(ws) { ws.send("hello:" + ws.data.surface + ":" + ws.data.layer); },
    message(ws, msg) { ws.send("echo:" + msg); },
  },
});`;

function makeSurface(
  name: string,
  code: string | null,
  metaExtras: Record<string, unknown> = {},
): RegisteredUi {
  const root = mkdtempSync(path.join(os.tmpdir(), `routing-${name}-`));
  tmpdirs.push(root);
  const uiDir = path.join(root, name);
  mkdirSync(path.join(uiDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(uiDir, "dist", "index.html"),
    `<html><head></head><body>${name} static</body></html>`,
  );
  writeFileSync(path.join(uiDir, "dist", "app.js"), `console.log("${name}")`);
  if (code !== null) {
    mkdirSync(path.join(uiDir, "server"), { recursive: true });
    writeFileSync(path.join(uiDir, "server", "index.js"), code);
  }
  const meta = parseMeta({
    name,
    displayName: name,
    path: `/surface/${name}`,
    ...(code !== null ? { server: { entry: "server/index.js" } } : {}),
    ...metaExtras,
  });
  return { dirName: name, uiDir, distDir: path.join(uiDir, "dist"), meta };
}

/** A recording surface + a closure-scoped reader of what its backend saw. */
function makeRecordingSurface(name: string): { ui: RegisteredUi; seen: () => string[] } {
  const seenFile = path.join(
    mkdtempSync(path.join(os.tmpdir(), `routing-seen-${name}-`)),
    "seen.txt",
  );
  tmpdirs.push(path.dirname(seenFile));
  const ui = makeSurface(name, recordingBackendSource(seenFile));
  const seen = (): string[] =>
    existsSync(seenFile)
      ? readFileSync(seenFile, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
      : [];
  return { ui, seen };
}

async function startHost(uis: RegisteredUi[]): Promise<{ origin: string; state: AppState }> {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "routing-state-"));
  tmpdirs.push(stateRoot);
  const state: AppState = {
    config: { ...DEFAULTS },
    registeredUis: uis,
    skippedUis: [],
  };
  const backends = new BackendSupervisor({
    buildContext: createHostContextBuilder({
      config: state.config,
      logger: silent,
      stateDir: stateRoot,
      tokenProviderFor: () => () => "test-token",
    }),
    logger: silent,
  });
  state.backends = backends;
  await backends.sync(uis);
  const server = startHttpServer({ state, port: 0, startedAt: new Date(), logger: silent });
  stoppers.push(() => {
    server.stop(true);
    void backends.stop();
  });
  return { origin: `http://127.0.0.1:${server.port}`, state };
}

describe("routing — structural containment (P4)", () => {
  test("backend receives EXACTLY ${mount}/api/* — host paths never reach it", async () => {
    const { ui: backed, seen } = makeRecordingSurface("recorder");
    const { origin } = await startHost([backed]);

    // api namespace → backend (any method).
    const apiGet = await fetch(`${origin}/surface/recorder/api/notes`);
    expect(apiGet.status).toBe(200);
    expect(((await apiGet.json()) as { via: string }).via).toBe("backend");
    const apiPost = await fetch(`${origin}/surface/recorder/api/notes`, { method: "POST" });
    expect(apiPost.status).toBe(200);

    // Host-served paths — even though the recording backend's router would
    // happily claim them, they must NEVER reach it.
    const staticRes = await fetch(`${origin}/surface/recorder/`);
    expect(await staticRes.text()).toContain("recorder static");
    const asset = await fetch(`${origin}/surface/recorder/app.js`);
    expect(asset.status).toBe(200);
    const oauthClient = await fetch(`${origin}/surface/recorder/oauth-client`);
    expect(oauthClient.status).toBe(404); // host route (no DCR record) — not the backend
    const healthz = await fetch(`${origin}/surface/healthz`);
    expect(healthz.status).toBe(200);

    expect(seen()).toEqual(["GET /surface/recorder/api/notes", "POST /surface/recorder/api/notes"]);
  });

  test("sibling surfaces are isolated — one backend cannot serve another's namespace", async () => {
    const { ui: backed, seen } = makeRecordingSurface("served");
    const staticOnly = makeSurface("plain", null);
    const { origin } = await startHost([backed, staticOnly]);

    // The static surface has no backend: its /api namespace falls through
    // to the host's ordinary static handling (SPA fallback serves ITS OWN
    // shell) — never to the sibling backend.
    const res = await fetch(`${origin}/surface/plain/api/anything`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("plain static");
    expect(seen()).toEqual([]);
  });

  test("backed surface with failed mount → api 503s while static serves", async () => {
    const broken = makeSurface("brokeback", `export default () => { throw new Error("x"); };`);
    const { origin } = await startHost([broken]);
    const api = await fetch(`${origin}/surface/brokeback/api/x`);
    expect(api.status).toBe(503);
    const staticRes = await fetch(`${origin}/surface/brokeback/`);
    expect(staticRes.status).toBe(200);
    expect(await staticRes.text()).toContain("brokeback static");
  });
});

describe("security headers (P6/§13)", () => {
  test("injected on backed-surface responses: api, static, and refusals", async () => {
    const backed = makeSurface("armored", PLAIN_BACKEND);
    const { origin } = await startHost([backed]);

    for (const url of [
      `${origin}/surface/armored/api/x`,
      `${origin}/surface/armored/`,
      `${origin}/surface/armored/app.js`,
      `${origin}/surface/armored/ws`, // 426 refusal (no capability)
    ]) {
      const res = await fetch(url);
      const csp = res.headers.get("content-security-policy");
      expect(csp).not.toBeNull();
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("static-only surfaces keep current behavior (no CSP injection)", async () => {
    const plain = makeSurface("bare", null);
    const { origin } = await startHost([plain]);
    const res = await fetch(`${origin}/surface/bare/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("csp override ADDS sources to specific directives only", async () => {
    const backed = makeSurface("extended", PLAIN_BACKEND, {
      server: {
        entry: "server/index.js",
        csp: { "connect-src": ["https://api.example.com", "wss:"] },
      },
    });
    const { origin } = await startHost([backed]);
    const res = await fetch(`${origin}/surface/extended/api/x`);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self' https://api.example.com wss:");
    // Untouched directives keep the strict defaults.
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("default-src 'self';");
  });

  test("override validation: loosening + injection shapes are rejected at parse time", () => {
    const base = { name: "x", displayName: "X", path: "/surface/x" };
    const bad = [
      { "default-src": ["https://x.example"] }, // not overridable
      { "script-src": ["'unsafe-eval'"] },
      { "script-src": ["'unsafe-inline'"] },
      { "connect-src": ["https://a.example https://b.example"] }, // whitespace smuggling
      { "connect-src": ["https://a.example;script-src *"] }, // directive injection
    ];
    for (const csp of bad) {
      expect(() => parseMeta({ ...base, server: { entry: "s.js", csp } })).toThrow();
    }
    // 'unsafe-inline' for STYLE additions is acceptable (it's already in the default).
    const ok = parseMeta({
      ...base,
      server: { entry: "s.js", csp: { "style-src": ["https://fonts.example"] } },
    });
    expect(buildCspValue(ok)).toContain("style-src 'self' 'unsafe-inline' https://fonts.example");
  });
});

describe("WebSocket multiplexing (P4)", () => {
  test("upgrade + pump round-trip for a capability-declaring surface", async () => {
    const wsSurface = makeSurface("talky", ECHO_WS_BACKEND, {
      server: { entry: "server/index.js", capabilities: ["websocket"] },
    });
    const { origin } = await startHost([wsSurface]);

    const url = `${origin.replace("http://", "ws://")}/surface/talky/ws`;
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ws round-trip timed out")), 5_000);
      const ws = new WebSocket(url);
      ws.addEventListener("message", (ev) => {
        received.push(String(ev.data));
        if (received.length === 1) {
          ws.send("ping");
        } else {
          clearTimeout(timeout);
          ws.close(1000);
          resolve();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("ws errored"));
      });
    });
    // open() fired with the per-connection context (surface + fail-closed
    // layer — no hub stamps on a direct connection), then the echo.
    expect(received).toEqual(["hello:talky:public", "echo:ping"]);
  });

  test("426 without the declared capability (deny-by-default)", async () => {
    const noCap = makeSurface("muted", ECHO_WS_BACKEND); // backend has handlers, meta declares nothing
    const { origin } = await startHost([noCap]);
    const res = await fetch(`${origin}/surface/muted/ws`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("websocket_not_supported");
  });

  test("426 for a plain GET to ${mount}/ws (not an upgrade)", async () => {
    const wsSurface = makeSurface("talkytwo", ECHO_WS_BACKEND, {
      server: { entry: "server/index.js", capabilities: ["websocket"] },
    });
    const { origin } = await startHost([wsSurface]);
    const res = await fetch(`${origin}/surface/talkytwo/ws`);
    expect(res.status).toBe(426);
    expect(((await res.json()) as { error: string }).error).toBe("upgrade_required");
  });

  test("ws handler errors are contained: socket closes, sibling api unaffected", async () => {
    const crashy = makeSurface(
      "crashws",
      `export default () => ({
         fetch() { return Response.json({ ok: true }); },
         websocket: {
           message() { throw new Error("ws-boom"); },
         },
       });`,
      { server: { entry: "server/index.js", capabilities: ["websocket"] } },
    );
    const { origin } = await startHost([crashy]);
    const url = `${origin.replace("http://", "ws://")}/surface/crashws/ws`;
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ws close timed out")), 5_000);
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => ws.send("trigger"));
      ws.addEventListener("close", (ev) => {
        clearTimeout(timeout);
        resolve({ code: ev.code, reason: ev.reason });
      });
    });
    expect(closed.code).toBe(1011);
    // Generic reason only — the backend's error text never crosses the wire.
    expect(closed.reason).not.toContain("ws-boom");
    // The surface's HTTP namespace keeps serving.
    const api = await fetch(`${origin}/surface/crashws/api/x`);
    expect(api.status).toBe(200);
  });
});
