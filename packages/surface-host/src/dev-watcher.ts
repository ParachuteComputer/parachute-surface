/**
 * Dev-mode file watcher + optional auto-rebuild — Phase 3.0.
 *
 * Closes the dev-mode loop Phase 1.3 left half-open. Phase 1.3 shipped
 * SSE live-reload but the operator still had to call
 * `parachute-surface dev <name> --trigger` (or rebuild a watched dist/) to
 * fire a reload. Phase 3.0 wires a process-local file watcher per UI in
 * dev mode so any edit under the UI's source tree:
 *
 *   1. (optional) re-runs the operator-declared `dev_build_cmd` to
 *      produce a fresh `dist/`, and
 *   2. broadcasts a `reload` event to every connected SSE subscriber
 *      (the injected EventSource shim in `dev-injection.ts`).
 *
 * Design choices:
 *
 *   - `node:fs.watch(..., { recursive: true })` over `Bun.watch` because
 *     it's the lower-level primitive Bun also implements on macOS +
 *     Linux + Windows. Recursive watches work out-of-the-box on macOS
 *     (FSEvents) and Linux (inotify since Node 20). On systems where
 *     recursive is unsupported, the watcher logs + falls back to non-
 *     recursive — better than silently missing nested edits.
 *
 *   - **Filtering.** We ignore changes inside `dist/` and
 *     `node_modules/` (relative to the watch root). A naive watcher
 *     loops on its own build output — the build writes to dist/, the
 *     watcher fires, the build runs again. The filter is a path-prefix
 *     check on the reported `filename` (no `stat()` per event — the
 *     hot path stays allocation-light).
 *
 *   - **Debounce.** Build tools touch many files in quick succession.
 *     We coalesce file events into one reload per quiet-window
 *     (`dev_debounce_ms` from meta.json, default 250ms; floor 50ms).
 *     A pending build/reload cycle is cancelled if a new event fires
 *     before the timer expires; only the LATEST event fires the work.
 *
 *   - **Build execution.** When `meta.dev_build_cmd` is set, we
 *     `Bun.spawn(["sh", "-c", cmd], { cwd: uiRootDir })` after the
 *     debounce expires. A 60s timeout aborts long-running builds.
 *     Success (exit 0) → broadcast reload. Failure → log stderr +
 *     stdout (truncated to keep daemon logs sane), no reload broadcast,
 *     watch stays armed (the next edit retries the build). Phase 4+
 *     may surface build failure to the browser as a status event; for
 *     MVP we just log.
 *
 *   - **Build serialization.** Per-UI single-flight: if a build is
 *     already running when the next debounced batch lands, we mark the
 *     watcher dirty and re-run once the current build finishes. We
 *     don't run two builds in parallel for the same UI — that race is
 *     a reliable way to corrupt `dist/`.
 *
 *   - **Lifecycle.** `start()` is idempotent — calling twice for the
 *     same UI replaces the previous watcher (operator might toggle
 *     dev_watch_dir at runtime via admin SPA in a future phase).
 *     `stop()` cancels pending timers, kills the in-flight build via
 *     its AbortController, and closes the FSWatcher. `stopAll()` is the
 *     test-mode + daemon-shutdown reaper.
 *
 *   - **Test seams.** `spawnFn` lets unit tests inject a fake spawner
 *     so we don't fork a shell. `nowFn` + `setTimeoutFn` are NOT
 *     mocked — the tests use real timers because the debounce window
 *     is small and the wall-clock cost is negligible.
 *
 * State design echoes `dev-mode.ts`: process-local map, single-
 * threaded mutations, no locking needed under Bun's event loop.
 */

import { type FSWatcher, existsSync, watch as fsWatch, statSync } from "node:fs";
import * as path from "node:path";

import { broadcastReload } from "./dev-mode.ts";

/** Default debounce window when meta.json doesn't override. */
export const DEFAULT_DEBOUNCE_MS = 250;
/** Floor enforced even when meta.json declares a smaller value. */
export const MIN_DEBOUNCE_MS = 50;
/** Maximum build time before we abort + skip the reload. */
export const BUILD_TIMEOUT_MS = 60_000;
/** Output truncation cap so a runaway build doesn't drown the daemon log. */
const LOG_OUTPUT_LIMIT = 4_000;

/**
 * Shape `Bun.spawn`-equivalent test mocks need to fulfill. Mirrors
 * `npm-fetch.ts`'s `NpmSpawnFn` — we accept the env + signal hook
 * because the watcher's spawn path needs an AbortController for the
 * 60s timeout.
 */
export type DevSpawnFn = (
  argv: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const DEFAULT_SPAWN: DevSpawnFn = async (argv, { cwd, signal }) => {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Bridge AbortSignal → process kill. Bun.spawn doesn't yet take a
  // `signal` option natively (as of bun 1.3); we wire it manually.
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (signal) signal.removeEventListener("abort", onAbort);
  return { exitCode, stdout, stderr };
};

/**
 * Options that drive a single per-UI watcher. The `name` and `uiRootDir`
 * pair identifies which UI this watch belongs to; everything else is
 * configuration parsed from `meta.json` + caller overrides.
 */
export type WatchOpts = {
  /** UI name; used for log prefix + reload broadcast key. */
  name: string;
  /** Absolute path to the UI's root dir (`<uis>/<dirName>/`). */
  uiRootDir: string;
  /**
   * Path relative to `uiRootDir` the watcher monitors. When undefined,
   * defaults to `uiRootDir` itself — minus `dist/` and `node_modules/`
   * which the event filter discards.
   */
  watchDir?: string;
  /**
   * Shell command (e.g. `"bun run build"`) run on each debounced batch.
   * When undefined, the watcher skips the build step and broadcasts the
   * reload directly. cwd is always `uiRootDir`.
   */
  buildCmd?: string;
  /** Debounce window in ms; clamped to `[MIN_DEBOUNCE_MS, ∞]`. */
  debounceMs?: number;
  /** Spawner override (tests). Defaults to `Bun.spawn`. */
  spawnFn?: DevSpawnFn;
  /**
   * Per-call override for the build timeout. Production code never sets
   * this — it exists so unit tests can drop the 60s ceiling to something
   * a test can wait for (~100ms) without slowing the suite. Falsy /
   * undefined → use `BUILD_TIMEOUT_MS`.
   */
  buildTimeoutMs?: number;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

type WatcherSlot = {
  name: string;
  watcher: FSWatcher;
  /** Absolute path the watcher monitors. */
  watchedAbsDir: string;
  /** Build command (post-config). */
  buildCmd?: string;
  /** Resolved debounce after clamping. */
  debounceMs: number;
  /** Pending debounce timer (cleared on stop + when new events arrive). */
  pendingTimer?: ReturnType<typeof setTimeout>;
  /** Cwd for the build spawn. */
  cwd: string;
  /** Spawn function captured at start time. */
  spawn: DevSpawnFn;
  /** Per-slot build-timeout (test seam). Defaults to `BUILD_TIMEOUT_MS`. */
  buildTimeoutMs: number;
  /** Logger captured at start time. */
  logger: Pick<Console, "log" | "warn" | "error">;
  /** A build is currently in flight (single-flight per UI). */
  building: boolean;
  /** Set when a fresh batch fires while `building` — re-run on completion. */
  rerunPending: boolean;
  /**
   * AbortController for the in-flight build. `stop()` aborts; the
   * spawn promise resolves with the kill exit-code and we treat it as
   * "no reload" (the next batch — or `stop()`'s reaper — handles it).
   */
  buildAbort?: AbortController;
};

const SLOTS = new Map<string, WatcherSlot>();

/**
 * Start (or replace) the watcher for a UI. Idempotent — calling with
 * the same `name` reaps the prior slot first so meta.json edits to
 * `dev_watch_dir` / `dev_build_cmd` propagate cleanly.
 *
 * Returns the resolved absolute watch dir + debounce so callers can
 * log "watching <dir> @ <ms>ms" in their own messages. Throws only if
 * the watch dir doesn't exist (operator config error worth surfacing);
 * everything else falls through to a logged warning and a no-op slot.
 */
export function startWatcher(opts: WatchOpts): { watchedAbsDir: string; debounceMs: number } {
  // Reap any prior slot first — supports meta.json edits.
  stopWatcher(opts.name);

  const logger = opts.logger ?? console;
  const spawn = opts.spawnFn ?? DEFAULT_SPAWN;
  const debounceMs = clampDebounce(opts.debounceMs);

  // Resolve the watch dir: relative paths join under uiRootDir; absolute
  // paths win. Default to uiRootDir itself.
  const watchedAbsDir = resolveWatchDir(opts.uiRootDir, opts.watchDir);

  if (!existsSync(watchedAbsDir)) {
    // Surface as a thrown error so the caller (typically the dev-routes
    // `enable` handler) can report a 4xx instead of silently arming a
    // non-firing watcher.
    throw new DevWatcherError(
      `watch dir does not exist: ${watchedAbsDir} (resolved from meta.dev_watch_dir="${opts.watchDir ?? "<default>"}")`,
      "watch_dir_missing",
    );
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(watchedAbsDir);
  } catch (e) {
    throw new DevWatcherError(
      `failed to stat watch dir ${watchedAbsDir}: ${(e as Error).message}`,
      "watch_dir_stat_failed",
    );
  }
  if (!st.isDirectory()) {
    throw new DevWatcherError(
      `watch dir is not a directory: ${watchedAbsDir}`,
      "watch_dir_not_directory",
    );
  }

  // Construct the FSWatcher. We pass `{ recursive: true }` — supported
  // out-of-the-box on macOS + recent Node/Bun on Linux. If recursive is
  // somehow unsupported, fall back to non-recursive (worse, but better
  // than throwing).
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(watchedAbsDir, { recursive: true, persistent: false }, (_event, filename) => {
      handleEvent(opts.name, filename ?? "");
    });
  } catch (e) {
    logger.warn(
      `[app] dev-watcher: recursive watch failed (${(e as Error).message}); falling back to non-recursive on ${watchedAbsDir}`,
    );
    watcher = fsWatch(watchedAbsDir, { persistent: false }, (_event, filename) => {
      handleEvent(opts.name, filename ?? "");
    });
  }

  const slot: WatcherSlot = {
    name: opts.name,
    watcher,
    watchedAbsDir,
    buildCmd: opts.buildCmd,
    debounceMs,
    cwd: opts.uiRootDir,
    spawn,
    buildTimeoutMs:
      opts.buildTimeoutMs && opts.buildTimeoutMs > 0 ? opts.buildTimeoutMs : BUILD_TIMEOUT_MS,
    logger,
    building: false,
    rerunPending: false,
  };
  SLOTS.set(opts.name, slot);

  logger.log(
    `[app] dev-watcher: watching ${watchedAbsDir} for ${opts.name}${
      opts.buildCmd ? ` (build: \`${opts.buildCmd}\`)` : " (no build cmd)"
    } debounce=${debounceMs}ms`,
  );
  return { watchedAbsDir, debounceMs };
}

/**
 * Stop the watcher for a UI. Idempotent; safe to call when nothing is
 * registered. Clears any pending debounce timer, aborts in-flight
 * builds, and closes the underlying FSWatcher.
 */
export function stopWatcher(name: string): void {
  const slot = SLOTS.get(name);
  if (!slot) return;
  if (slot.pendingTimer) clearTimeout(slot.pendingTimer);
  slot.pendingTimer = undefined;
  if (slot.buildAbort) {
    try {
      slot.buildAbort.abort();
    } catch {
      // ignore — controller may have already fired
    }
  }
  try {
    slot.watcher.close();
  } catch {
    // already closed
  }
  SLOTS.delete(name);
  slot.logger.log(`[app] dev-watcher: stopped for ${name}`);
}

/** Whether a watcher is currently active for `name`. */
export function isWatching(name: string): boolean {
  return SLOTS.has(name);
}

/**
 * Diagnostic snapshot — used by the status endpoint + admin SPA to
 * render "watching <dir>" sub-text on the dev badge.
 */
export type WatcherStatus = {
  name: string;
  watchedAbsDir: string;
  debounceMs: number;
  buildCmd?: string;
  building: boolean;
};

export function watcherStatus(name: string): WatcherStatus | undefined {
  const slot = SLOTS.get(name);
  if (!slot) return undefined;
  return {
    name: slot.name,
    watchedAbsDir: slot.watchedAbsDir,
    debounceMs: slot.debounceMs,
    buildCmd: slot.buildCmd,
    building: slot.building,
  };
}

/** Stop every watcher. Used on shutdown + tests. */
export function stopAllWatchers(): void {
  for (const name of [...SLOTS.keys()]) stopWatcher(name);
}

/**
 * Custom error so the route handler can distinguish "operator misconfig
 * — surface as a 4xx" from "internal failure — log + 5xx". `code` is
 * stable; `message` is human-facing.
 */
export class DevWatcherError extends Error {
  override name = "DevWatcherError" as const;
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// --- internal -----------------------------------------------------------

function clampDebounce(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_DEBOUNCE_MS;
  return Math.max(MIN_DEBOUNCE_MS, Math.floor(input));
}

function resolveWatchDir(uiRootDir: string, watchDir: string | undefined): string {
  if (!watchDir) return uiRootDir;
  if (path.isAbsolute(watchDir)) return watchDir;
  return path.resolve(uiRootDir, watchDir);
}

/**
 * Filter that drops events from inside `dist/` and `node_modules/`.
 * `filename` is the path the FSWatcher reported relative to the watch
 * root; on some platforms it can be `""` (rename-without-name) — those
 * we keep because they may signal a top-level event.
 */
function shouldIgnore(filename: string): boolean {
  if (!filename) return false;
  // Normalize path separators (Windows) — Bun on Windows isn't supported
  // by parachute-surface at the moment but the cost is one regex.
  const normalized = filename.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "dist" || seg === "node_modules" || seg === ".git") return true;
  }
  // Common transient editor turds.
  const base = segments[segments.length - 1] ?? "";
  if (base.startsWith(".#") || base.endsWith("~")) return true;
  return false;
}

/**
 * Handle a single FSWatcher event. Applies the filter, then resets the
 * debounce timer. The timer callback is what actually runs the build +
 * fires the reload broadcast.
 */
function handleEvent(name: string, filename: string): void {
  const slot = SLOTS.get(name);
  if (!slot) return;
  if (shouldIgnore(filename)) return;

  if (slot.pendingTimer) clearTimeout(slot.pendingTimer);
  slot.pendingTimer = setTimeout(() => {
    slot.pendingTimer = undefined;
    void runDebouncedCycle(name);
  }, slot.debounceMs);
}

/**
 * Run one build → broadcast cycle. Honors the single-flight guard: if a
 * build is already in flight, mark `rerunPending` and return. The
 * in-flight build's completion path consumes `rerunPending` and starts
 * the next cycle.
 */
async function runDebouncedCycle(name: string): Promise<void> {
  const slot = SLOTS.get(name);
  if (!slot) return;
  if (slot.building) {
    slot.rerunPending = true;
    return;
  }

  // If no build command, fast-path: broadcast immediately.
  if (!slot.buildCmd) {
    const notified = broadcastReload(name);
    slot.logger.log(`[app] dev-watcher: reload broadcast for ${name} (notified=${notified})`);
    return;
  }

  slot.building = true;
  slot.buildAbort = new AbortController();
  const cmd = slot.buildCmd;
  const startedAt = Date.now();
  slot.logger.log(`[app] dev-watcher: build for ${name} starting: \`${cmd}\``);

  // Per-slot timeout (default 60s) — abort if the build hangs.
  const timeoutHandle = setTimeout(() => {
    slot.buildAbort?.abort();
  }, slot.buildTimeoutMs);

  try {
    const result = await slot.spawn(["sh", "-c", cmd], {
      cwd: slot.cwd,
      signal: slot.buildAbort.signal,
    });
    clearTimeout(timeoutHandle);
    const elapsedMs = Date.now() - startedAt;
    if (result.exitCode === 0) {
      slot.logger.log(`[app] dev-watcher: build for ${name} succeeded in ${elapsedMs}ms`);
      const notified = broadcastReload(name);
      slot.logger.log(`[app] dev-watcher: reload broadcast for ${name} (notified=${notified})`);
    } else {
      slot.logger.warn(
        `[app] dev-watcher: build for ${name} failed (exit=${result.exitCode}, ${elapsedMs}ms) — NOT broadcasting reload`,
      );
      const out = truncate(result.stdout);
      const err = truncate(result.stderr);
      if (out) slot.logger.warn(`[app] dev-watcher: build stdout:\n${out}`);
      if (err) slot.logger.warn(`[app] dev-watcher: build stderr:\n${err}`);
    }
  } catch (e) {
    clearTimeout(timeoutHandle);
    slot.logger.warn(
      `[app] dev-watcher: build for ${name} threw: ${(e as Error).message} — NOT broadcasting reload`,
    );
  } finally {
    slot.building = false;
    slot.buildAbort = undefined;
    // If a debounce-batch landed while we were building, run again.
    if (slot.rerunPending) {
      slot.rerunPending = false;
      // Re-enter via the same path; no recursion concerns since the
      // function is async + awaited internally.
      void runDebouncedCycle(name);
    }
  }
}

function truncate(s: string): string {
  if (s.length <= LOG_OUTPUT_LIMIT) return s;
  return `${s.slice(0, LOG_OUTPUT_LIMIT)}\n… (truncated, ${s.length - LOG_OUTPUT_LIMIT} more chars)`;
}
