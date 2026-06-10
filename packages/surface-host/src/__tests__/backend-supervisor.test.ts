/**
 * P5 + §11 — BackendSupervisor: mount lifecycle + NON-OPTIONAL containment.
 *
 * Real entries on disk (tmpdir surfaces with actual server modules,
 * dynamically imported) — the mount path is the thing under test, so no
 * import stubbing except where the seam itself is the subject.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BackendSupervisor } from "../backend-supervisor.ts";
import type { SurfaceHostContext } from "../backend-types.ts";
import { parseMeta } from "../meta-schema.ts";
import { ScopedVaultClient } from "../scoped-vault-client.ts";
import { SurfaceStateStore } from "../surface-state-store.ts";
import type { RegisteredUi } from "../ui-registry.ts";

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const tmpdirs: string[] = [];

afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Create a tmp surface dir with a server entry whose source is `code`. */
function makeSurface(
  name: string,
  code: string,
  serverOverrides: Record<string, unknown> = {},
): RegisteredUi {
  const root = mkdtempSync(path.join(os.tmpdir(), `surface-${name}-`));
  tmpdirs.push(root);
  const uiDir = path.join(root, name);
  mkdirSync(path.join(uiDir, "dist"), { recursive: true });
  mkdirSync(path.join(uiDir, "server"), { recursive: true });
  writeFileSync(path.join(uiDir, "dist", "index.html"), "<html><head></head></html>");
  writeFileSync(path.join(uiDir, "server", "index.js"), code);
  const meta = parseMeta({
    name,
    displayName: name,
    path: `/surface/${name}`,
    server: { entry: "server/index.js", ...serverOverrides },
  });
  return { dirName: name, uiDir, distDir: path.join(uiDir, "dist"), meta };
}

function makeSupervisor(opts: Partial<ConstructorParameters<typeof BackendSupervisor>[0]> = {}) {
  const contexts: SurfaceHostContext[] = [];
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "supervisor-state-"));
  tmpdirs.push(stateRoot);
  const supervisor = new BackendSupervisor({
    buildContext: (ui, signal) => {
      const store = new SurfaceStateStore(path.join(stateRoot, `${ui.meta.name}.sqlite`));
      signal.addEventListener("abort", () => store.close());
      const ctx: SurfaceHostContext = {
        vault: new ScopedVaultClient({
          hubOrigin: "http://hub.test",
          vaultName: "default",
          tokenProvider: () => {
            throw new Error("no credential in supervisor tests");
          },
        }),
        store,
        layer: () => "public",
        clientIp: () => null,
        config: { all: () => ({}), get: () => undefined },
        log: silent,
        mount: ui.meta.path,
        shutdownSignal: signal,
      };
      contexts.push(ctx);
      return ctx;
    },
    logger: silent,
    ...opts,
  });
  return { supervisor, contexts };
}

const OK_BACKEND = `export default (ctx) => ({
  fetch(req) { return new Response("ok:" + ctx.mount, { status: 200 }); },
});`;

describe("mount lifecycle", () => {
  test("healthy factory → active; requests flow through", async () => {
    const ui = makeSurface("happy", OK_BACKEND);
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("active");
    const res = await supervisor.handleRequest(ui, new Request("http://x/surface/happy/api/ping"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:/surface/happy");
  });

  test("factory throw → backend-error; api namespace 503s", async () => {
    const ui = makeSurface("explode", `export default () => { throw new Error("boom S3CR3T"); };`);
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("backend-error");
    expect(supervisor.reasonFor("explode")).toContain("factory threw");
    const res = await supervisor.handleRequest(ui, new Request("http://x/surface/explode/api/x"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("backend_unavailable");
    // No factory detail leaks to the client.
    expect(JSON.stringify(body)).not.toContain("S3CR3T");
  });

  test("async factory rejection → backend-error", async () => {
    const ui = makeSurface("rejector", `export default async () => { throw new Error("nope"); };`);
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("backend-error");
  });

  test("missing entry file → backend-error with reason", async () => {
    const ui = makeSurface("ghostly", OK_BACKEND);
    rmSync(path.join(ui.uiDir, "server", "index.js"));
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("backend-error");
    expect(supervisor.reasonFor("ghostly")).toContain("not found");
  });

  test("no default-export factory → backend-error", async () => {
    const ui = makeSurface("nodefault", `export const fetch = () => new Response("x");`);
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("backend-error");
    expect(supervisor.reasonFor("nodefault")).toContain("default-export");
  });

  test("factory returning a non-backend → backend-error", async () => {
    const ui = makeSurface("notabackend", "export default () => ({ notFetch: true });");
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("backend-error");
  });

  test("entry escaping the surface dir → backend-error (defense in depth)", async () => {
    const ui = makeSurface("escapee", OK_BACKEND);
    // Bypass parseMeta (which would reject this) — simulate a meta written
    // to disk by another tool.
    ui.meta.server = { ...ui.meta.server!, entry: "../../../etc/evil.js" };
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(supervisor.statusFor(ui)).toBe("backend-error");
    expect(supervisor.reasonFor("escapee")).toContain("escapes");
  });

  test("static surface (no server block) → static-only", () => {
    const ui = makeSurface("staticy", OK_BACKEND);
    const { server: _server, ...rest } = ui.meta;
    const staticUi = { ...ui, meta: { ...rest } } as RegisteredUi;
    const { supervisor } = makeSupervisor();
    expect(supervisor.statusFor(staticUi)).toBe("static-only");
  });

  test("declared but never mounted → backend-error", () => {
    const ui = makeSurface("unsynced", OK_BACKEND);
    const { supervisor } = makeSupervisor();
    expect(supervisor.statusFor(ui)).toBe("backend-error");
  });

  test("reload imports a FRESH module instance (edited entry takes effect)", async () => {
    const ui = makeSurface(
      "evolving",
      `export default () => ({ fetch: () => new Response("v1") });`,
    );
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    expect(await (await supervisor.handleRequest(ui, new Request("http://x/api"))).text()).toBe(
      "v1",
    );
    writeFileSync(
      path.join(ui.uiDir, "server", "index.js"),
      `export default () => ({ fetch: () => new Response("v2") });`,
    );
    await supervisor.reload(ui);
    expect(supervisor.statusFor(ui)).toBe("active");
    expect(await (await supervisor.handleRequest(ui, new Request("http://x/api"))).text()).toBe(
      "v2",
    );
  });

  test("sync mounts new, keeps unchanged, unmounts removed", async () => {
    const a = makeSurface("aaa", OK_BACKEND);
    let shutdownCalls = 0;
    const b = makeSurface(
      "bbb",
      `export default () => ({
        fetch: () => new Response("b"),
        shutdown: async () => { globalThis.__bbbShutdown = (globalThis.__bbbShutdown ?? 0) + 1; },
      });`,
    );
    const { supervisor } = makeSupervisor();
    await supervisor.sync([a, b]);
    expect(supervisor.statusFor(a)).toBe("active");
    expect(supervisor.statusFor(b)).toBe("active");

    await supervisor.sync([a]); // b removed
    shutdownCalls = (globalThis as Record<string, unknown>).__bbbShutdown as number;
    expect(shutdownCalls).toBe(1);
    expect(supervisor.has("bbb")).toBe(false);
    expect(supervisor.statusFor(a)).toBe("active"); // untouched
    (globalThis as Record<string, unknown>).__bbbShutdown = undefined;
  });
});

describe("containment (§11 — NON-OPTIONAL)", () => {
  test("throwing route → 500 generic JSON, no detail leak; sibling unaffected", async () => {
    const bad = makeSurface(
      "thrower",
      `export default () => ({ fetch: () => { throw new Error("stack S3CR3T /private/path"); } });`,
    );
    const good = makeSurface("neighbor", OK_BACKEND);
    const { supervisor } = makeSupervisor();
    await supervisor.sync([bad, good]);

    const res = await supervisor.handleRequest(bad, new Request("http://x/api"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("S3CR3T");
    expect(text).not.toContain("/private/path");
    expect((JSON.parse(text) as { error: string }).error).toBe("backend_error");

    // Sibling keeps serving.
    const ok = await supervisor.handleRequest(good, new Request("http://x/api"));
    expect(ok.status).toBe(200);
    expect(supervisor.statusFor(good)).toBe("active");
    expect(supervisor.statusFor(bad)).toBe("failing");
  });

  test("rejected promise → 500 generic", async () => {
    const ui = makeSurface(
      "rejecting",
      `export default () => ({ fetch: async () => { throw new Error("async-fail"); } });`,
    );
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    const res = await supervisor.handleRequest(ui, new Request("http://x/api"));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("backend_error");
  });

  test("non-Response return → 500 generic", async () => {
    const ui = makeSurface(
      "wrongtype",
      `export default () => ({ fetch: () => "not a response" });`,
    );
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    const res = await supervisor.handleRequest(ui, new Request("http://x/api"));
    expect(res.status).toBe(500);
  });

  test("timeout fires at server.timeoutMs → 504", async () => {
    const ui = makeSurface(
      "sleeper",
      "export default () => ({ fetch: () => new Promise(() => {}) });", // never resolves
      { timeoutMs: 1000 }, // schema minimum
    );
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    const started = Date.now();
    const res = await supervisor.handleRequest(ui, new Request("http://x/api"));
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toBe("backend_timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(supervisor.statusFor(ui)).toBe("failing");
  });

  test("crash-loop window → backend-disabled (503, backend not invoked); reload recovers", async () => {
    const ui = makeSurface(
      "loopy",
      `globalThis.__loopyCalls = 0;
       export default () => ({ fetch: () => { globalThis.__loopyCalls++; throw new Error("x"); } });`,
    );
    const { supervisor } = makeSupervisor({ crashLoopMax: 3, crashLoopWindowMs: 60_000 });
    await supervisor.mount(ui);

    for (let i = 0; i < 3; i++) {
      const res = await supervisor.handleRequest(ui, new Request("http://x/api"));
      expect(res.status).toBe(500);
    }
    expect(supervisor.statusFor(ui)).toBe("backend-disabled");
    const g = globalThis as Record<string, unknown>;
    const callsAtQuarantine = g.__loopyCalls as number;

    // Quarantined: 503 WITHOUT invoking the backend.
    const blocked = await supervisor.handleRequest(ui, new Request("http://x/api"));
    expect(blocked.status).toBe(503);
    expect(((await blocked.json()) as { error: string }).error).toBe("backend_disabled");
    expect(g.__loopyCalls).toBe(callsAtQuarantine);

    // Operator reload remounts + resets the window.
    await supervisor.reload(ui);
    expect(supervisor.statusFor(ui)).toBe("active");
    g.__loopyCalls = undefined;
  });

  test("failures age out of the sliding window (failing → active)", async () => {
    let clock = 1_000_000;
    const ui = makeSurface(
      "flaky",
      `let n = 0;
       export default () => ({ fetch: () => { if (n++ === 0) throw new Error("once"); return new Response("ok"); } });`,
    );
    const { supervisor } = makeSupervisor({
      crashLoopMax: 3,
      crashLoopWindowMs: 1_000,
      now: () => clock,
    });
    await supervisor.mount(ui);
    await supervisor.handleRequest(ui, new Request("http://x/api")); // fails
    expect(supervisor.statusFor(ui)).toBe("failing");
    clock += 5_000; // window passes
    expect(supervisor.statusFor(ui)).toBe("active");
  });
});

describe("shutdown contract", () => {
  test("unmount aborts ctx.shutdownSignal BEFORE awaiting shutdown()", async () => {
    const order: string[] = [];
    const ui = makeSurface(
      "orderly",
      `export default (ctx) => {
         ctx.shutdownSignal.addEventListener("abort", () => globalThis.__order.push("signal"));
         return {
           fetch: () => new Response("ok"),
           shutdown: async () => { globalThis.__order.push("shutdown"); },
         };
       };`,
    );
    (globalThis as Record<string, unknown>).__order = order;
    const { supervisor } = makeSupervisor();
    await supervisor.mount(ui);
    await supervisor.unmount("orderly");
    expect(order).toEqual(["signal", "shutdown"]);
    (globalThis as Record<string, unknown>).__order = undefined;
  });

  test("hung shutdown() is bounded — unmount returns anyway", async () => {
    const ui = makeSurface(
      "hangy",
      `export default () => ({
         fetch: () => new Response("ok"),
         shutdown: () => new Promise(() => {}),
       });`,
    );
    const { supervisor } = makeSupervisor({ shutdownTimeoutMs: 50 });
    await supervisor.mount(ui);
    const started = Date.now();
    await supervisor.unmount("hangy");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(supervisor.has("hangy")).toBe(false);
  });

  test("stop() unmounts everything", async () => {
    const a = makeSurface("stopa", OK_BACKEND);
    const b = makeSurface("stopb", OK_BACKEND);
    const { supervisor } = makeSupervisor();
    await supervisor.sync([a, b]);
    await supervisor.stop();
    expect(supervisor.has("stopa")).toBe(false);
    expect(supervisor.has("stopb")).toBe(false);
  });
});
