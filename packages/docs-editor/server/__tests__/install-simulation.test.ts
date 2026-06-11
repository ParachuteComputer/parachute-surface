/**
 * Install simulation — the surface must mount from ANY real install path.
 *
 * All three install paths (npm fetch, URL tarball, local dir) copy
 * `dist/` + the server entry's first path segment (`server/`) + meta.json
 * into `<uis>/<name>/` — NEVER node_modules (surface-host
 * `copyServerFiles` / `copyDir`). So the meta.json entry must be a
 * SELF-CONTAINED bundle:
 *
 *   - negative control: the raw TS entry (bare npm imports) CANNOT load
 *     from an isolated install dir — exactly the pre-bundle failure mode
 *     (permanent backend-error on every real install);
 *   - the real thing: `bun run build:server`'s bundle, copied alone into
 *     an isolated dir, imports, constructs the backend via the P1 default
 *     export against a fake host context, and serves a request;
 *   - wiring pin: meta.json's `server.entry` points at the bundled file
 *     (the supervisor imports exactly what meta.json names).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { SurfaceBackend, SurfaceHostContext } from "@openparachute/surface";
import { MOUNT, ORIGIN, makeTestCtx } from "./helpers.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..");

/** An install dir with NO node_modules anywhere relevant. */
function isolatedDir(): string {
  return mkdtempSync(path.join(tmpdir(), "docs-editor-install-sim-"));
}

describe("install simulation (no node_modules)", () => {
  test("meta.json's server.entry names the bundled artifact, not raw TS", () => {
    const meta = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "meta.json"), "utf8")) as {
      server?: { entry?: string };
    };
    expect(meta.server?.entry).toBe("server/index.bundle.js");
  });

  test("NEGATIVE CONTROL: the raw TS entry cannot load from an install dir", async () => {
    // Simulate exactly what copyServerFiles produces for entry
    // "server/index.ts": the server/ source tree, no node_modules.
    const dir = isolatedDir();
    cpSync(path.join(PACKAGE_ROOT, "server"), path.join(dir, "server"), {
      recursive: true,
      filter: (src) => !src.includes("__tests__") && !src.endsWith(".bundle.js"),
    });
    expect(import(path.join(dir, "server", "index.ts"))).rejects.toThrow();
  });

  test("the bundled entry loads, mounts, and serves from an install dir", async () => {
    // Build the bundle the same way `bun run build:server` does — the
    // test is hermetic (doesn't depend on a prior `bun run build`).
    const dir = isolatedDir();
    const out = spawnSync(
      "bun",
      [
        "build",
        path.join(PACKAGE_ROOT, "server", "index.ts"),
        "--target=bun",
        `--outfile=${path.join(dir, "server", "index.bundle.js")}`,
      ],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(out.status).toBe(0);

    // Import from the ISOLATED dir — self-containment is the assertion.
    // (Bun prints a "Yjs was already imported" warning here: the TEST
    // process holds the workspace yjs while the bundle carries its own —
    // a deliberate two-realm setup. In production the daemon imports only
    // the bundle, so the backend sees exactly one yjs; the host never
    // touches Y types.)
    const mod = (await import(path.join(dir, "server", "index.bundle.js"))) as {
      default: (ctx: SurfaceHostContext) => Promise<SurfaceBackend>;
    };
    expect(typeof mod.default).toBe("function");

    // The P1 contract end to end: factory → backend → request. The fake
    // vault's live-query first-snapshots gate the factory, so deliver
    // them once the subscriptions register.
    const t = makeTestCtx();
    t.vault.noteFixture("doc-sim", "# Installed");
    const building = mod.default(t.ctx);
    await Promise.resolve();
    t.vault.deliverSnapshots();
    const backend = await building;

    const res = await backend.fetch(new Request(`${ORIGIN}${MOUNT}/api/me`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "anon" });
    expect(backend.websocket).toBeDefined();

    await backend.shutdown?.();
    t.controller.abort();
  });
});
