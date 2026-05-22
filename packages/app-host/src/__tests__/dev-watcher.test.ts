/**
 * Tests for `src/dev-watcher.ts` — Phase 3.0 file watcher + auto-rebuild.
 *
 * Coverage:
 *   - startWatcher: resolves the watch dir + clamps debounce; idempotent
 *     (a second start replaces the prior slot)
 *   - file change fires the debounced reload broadcast
 *   - rapid changes are batched into a single broadcast
 *   - dist/ + node_modules/ events are filtered out (ignore the build-
 *     output loop)
 *   - build command: success → reload broadcast; non-zero exit → no
 *     broadcast; build is single-flight + re-armed on overlapping
 *     batches
 *   - stopWatcher: cancels timers, kills in-flight build, closes the
 *     FSWatcher
 *   - watcherStatus: returns slot snapshot for the admin SPA
 *   - missing watch dir throws `DevWatcherError`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addSubscriber, broadcastReload, resetDevMode } from "../dev-mode.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  DevWatcherError,
  MIN_DEBOUNCE_MS,
  isWatching,
  startWatcher,
  stopAllWatchers,
  stopWatcher,
  watcherStatus,
} from "../dev-watcher.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let scratchDirs: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-watcher-"));
  scratchDirs.push(dir);
  return dir;
}

/** Sleep helper — real timers keep these tests faithful to production. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Helper: register a fake subscriber that records every enqueued event.
 * Returns a `read()` that tells us how many reloads have fired.
 */
function fakeSubscriber(name: string): { reloads: number; close: () => void } {
  const state = { reloads: 0, closed: false };
  const controller = {
    enqueue: () => {
      state.reloads++;
    },
    close: () => {
      state.closed = true;
    },
    error: () => {
      state.closed = true;
    },
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const sub = { controller, closed: false };
  addSubscriber(name, sub);
  return {
    get reloads() {
      return state.reloads;
    },
    close: () => {
      sub.closed = true;
    },
  };
}

beforeEach(() => {
  resetDevMode();
});

afterEach(() => {
  stopAllWatchers();
  resetDevMode();
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore — best-effort cleanup
    }
  }
  scratchDirs = [];
});

describe("dev-watcher: startWatcher basics", () => {
  test("startWatcher resolves an absolute watch dir + default debounce", () => {
    const dir = makeScratch();
    const result = startWatcher({ name: "ui-a", uiRootDir: dir, logger: silentLogger });
    expect(result.watchedAbsDir).toBe(dir);
    expect(result.debounceMs).toBe(DEFAULT_DEBOUNCE_MS);
    expect(isWatching("ui-a")).toBe(true);
  });

  test("startWatcher clamps debounce below the floor up to MIN_DEBOUNCE_MS", () => {
    const dir = makeScratch();
    const result = startWatcher({
      name: "ui-a",
      uiRootDir: dir,
      debounceMs: 1,
      logger: silentLogger,
    });
    expect(result.debounceMs).toBe(MIN_DEBOUNCE_MS);
  });

  test("startWatcher honors a custom relative dev_watch_dir", () => {
    const dir = makeScratch();
    mkdirSync(join(dir, "src"));
    const result = startWatcher({
      name: "ui-a",
      uiRootDir: dir,
      watchDir: "src",
      logger: silentLogger,
    });
    expect(result.watchedAbsDir).toBe(join(dir, "src"));
  });

  test("startWatcher is idempotent — second call replaces prior slot", () => {
    const dir = makeScratch();
    const otherDir = makeScratch();
    startWatcher({ name: "ui-a", uiRootDir: dir, logger: silentLogger });
    const second = startWatcher({
      name: "ui-a",
      uiRootDir: otherDir,
      logger: silentLogger,
    });
    expect(second.watchedAbsDir).toBe(otherDir);
    const status = watcherStatus("ui-a");
    expect(status?.watchedAbsDir).toBe(otherDir);
  });

  test("startWatcher throws DevWatcherError on a missing watch dir", () => {
    const dir = makeScratch();
    expect(() =>
      startWatcher({
        name: "ui-a",
        uiRootDir: dir,
        watchDir: "does-not-exist",
        logger: silentLogger,
      }),
    ).toThrow(DevWatcherError);
  });

  test("stopWatcher is idempotent", () => {
    expect(() => stopWatcher("nothing")).not.toThrow();
  });

  test("watcherStatus returns undefined for an unknown UI", () => {
    expect(watcherStatus("nothing")).toBeUndefined();
  });
});

describe("dev-watcher: file change → reload", () => {
  test("file change fires the debounced reload broadcast (no build cmd)", async () => {
    const dir = makeScratch();
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({ name: "ui-a", uiRootDir: dir, debounceMs: 60, logger: silentLogger });

    // Allow the FSWatcher a moment to arm.
    await sleep(20);
    writeFileSync(join(dir, "x.ts"), "console.log('hi')\n");

    // Wait for the debounce window + slack.
    await sleep(300);
    expect(subscriber.reloads).toBe(1);
  });

  test("rapid changes are batched into ONE reload", async () => {
    const dir = makeScratch();
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({ name: "ui-a", uiRootDir: dir, debounceMs: 100, logger: silentLogger });

    await sleep(20);
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `f-${i}.ts`), `line ${i}\n`);
      // ~10ms apart — well inside the debounce window
      await sleep(10);
    }
    await sleep(300);
    expect(subscriber.reloads).toBe(1);
  });

  test("events inside dist/ are filtered out", async () => {
    const dir = makeScratch();
    mkdirSync(join(dir, "dist"));
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({ name: "ui-a", uiRootDir: dir, debounceMs: 60, logger: silentLogger });

    await sleep(20);
    writeFileSync(join(dir, "dist", "build.js"), "// build output\n");
    await sleep(250);
    expect(subscriber.reloads).toBe(0);
  });

  test("events inside node_modules/ are filtered out", async () => {
    const dir = makeScratch();
    mkdirSync(join(dir, "node_modules", "leftpad"), { recursive: true });
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({ name: "ui-a", uiRootDir: dir, debounceMs: 60, logger: silentLogger });

    await sleep(20);
    writeFileSync(join(dir, "node_modules", "leftpad", "index.js"), "// noisy\n");
    await sleep(250);
    expect(subscriber.reloads).toBe(0);
  });

  test("stopWatcher cancels a pending debounce timer", async () => {
    const dir = makeScratch();
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({ name: "ui-a", uiRootDir: dir, debounceMs: 150, logger: silentLogger });

    await sleep(20);
    writeFileSync(join(dir, "x.ts"), "hi\n");
    await sleep(40); // timer is pending
    stopWatcher("ui-a");
    await sleep(400);
    expect(subscriber.reloads).toBe(0);
    expect(isWatching("ui-a")).toBe(false);
  });
});

describe("dev-watcher: build command", () => {
  test("build success → reload broadcast", async () => {
    const dir = makeScratch();
    const subscriber = fakeSubscriber("ui-a");
    let spawnArgv: string[] | undefined;
    let spawnCwd: string | undefined;
    startWatcher({
      name: "ui-a",
      uiRootDir: dir,
      buildCmd: "echo built",
      debounceMs: 60,
      logger: silentLogger,
      spawnFn: async (argv, opts) => {
        spawnArgv = argv;
        spawnCwd = opts.cwd;
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    });

    await sleep(20);
    writeFileSync(join(dir, "src.ts"), "x\n");
    await sleep(400);
    expect(spawnArgv).toEqual(["sh", "-c", "echo built"]);
    expect(spawnCwd).toBe(dir);
    expect(subscriber.reloads).toBe(1);
  });

  test("build failure (non-zero exit) → NO reload broadcast", async () => {
    const dir = makeScratch();
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({
      name: "ui-a",
      uiRootDir: dir,
      buildCmd: "exit 1",
      debounceMs: 60,
      logger: silentLogger,
      spawnFn: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    });

    await sleep(20);
    writeFileSync(join(dir, "src.ts"), "x\n");
    await sleep(400);
    expect(subscriber.reloads).toBe(0);
  });

  test("build is single-flight: overlapping batches re-run after completion", async () => {
    const dir = makeScratch();
    const subscriber = fakeSubscriber("ui-a");
    let buildsStarted = 0;
    let buildsFinished = 0;
    const buildGates: Array<() => void> = [];
    const buildPromises: Array<Promise<void>> = [];
    startWatcher({
      name: "ui-a",
      uiRootDir: dir,
      buildCmd: "fake",
      debounceMs: 50,
      logger: silentLogger,
      spawnFn: async () => {
        buildsStarted++;
        // Park each build behind a manual gate so we can prove single-flight.
        let release: () => void = () => {};
        const p = new Promise<void>((r) => {
          release = r;
        });
        buildGates.push(release);
        buildPromises.push(p);
        await p;
        buildsFinished++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await sleep(20);
    writeFileSync(join(dir, "a.ts"), "a\n");
    // Wait for the debounce → first build starts and parks.
    await sleep(120);
    expect(buildsStarted).toBe(1);
    expect(buildsFinished).toBe(0);

    // While build 1 is in flight, fire more changes. They should coalesce
    // into a single re-run after build 1 completes (NOT spawn build #2 now).
    writeFileSync(join(dir, "b.ts"), "b\n");
    await sleep(20);
    writeFileSync(join(dir, "c.ts"), "c\n");
    await sleep(120);
    expect(buildsStarted).toBe(1); // still parked, no second build yet

    // Release build 1; the rerun-pending flag should trigger build 2.
    buildGates[0]!();
    await sleep(50);
    expect(buildsStarted).toBe(2);

    // Release build 2; cycle settles.
    buildGates[1]!();
    await sleep(50);
    expect(buildsFinished).toBe(2);
    expect(subscriber.reloads).toBe(2);
  });
});

describe("dev-watcher: watcherStatus", () => {
  test("status reflects start opts + building flag", () => {
    const dir = makeScratch();
    startWatcher({
      name: "ui-a",
      uiRootDir: dir,
      buildCmd: "bun run build",
      debounceMs: 333,
      logger: silentLogger,
    });
    const s = watcherStatus("ui-a");
    expect(s).toBeTruthy();
    expect(s?.name).toBe("ui-a");
    expect(s?.watchedAbsDir).toBe(dir);
    expect(s?.debounceMs).toBe(333);
    expect(s?.buildCmd).toBe("bun run build");
    expect(s?.building).toBe(false);
  });
});

describe("dev-watcher: integration — broadcast wiring", () => {
  test("file change → reload event reaches a real SSE subscriber", async () => {
    const dir = makeScratch();
    // Use the production broadcastReload via fakeSubscriber so we exercise
    // the wiring path the dev-routes SSE handler walks.
    const subscriber = fakeSubscriber("ui-a");
    startWatcher({ name: "ui-a", uiRootDir: dir, debounceMs: 60, logger: silentLogger });

    await sleep(20);
    appendFileSync(join(dir, "edit.txt"), "first\n");
    await sleep(300);
    expect(subscriber.reloads).toBe(1);

    // A manual broadcastReload still works in parallel — confirms the
    // watcher's broadcast isn't somehow consuming the only available slot.
    const n = broadcastReload("ui-a");
    expect(n).toBe(1);
    expect(subscriber.reloads).toBe(2);
  });
});
