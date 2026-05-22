/**
 * Per-UI dev-mode state — Phase 1.3.
 *
 * Solves the "edit code, build, browser still shows old" frustration
 * (parachute-notes#151) at the platform level. Each registered UI carries
 * an optional dev-mode flag the operator toggles via `parachute-app dev
 * <name>` (Phase 1.3) or the admin SPA. When dev mode is on:
 *
 *   1. The HTTP server emits `Cache-Control: no-cache, no-store,
 *      must-revalidate` on every response from that UI (overrides smart
 *      caching for hashed assets + 1h-default for non-hashed).
 *   2. The UI's `index.html` gets an injected `<script>` tag that opens
 *      an EventSource against `/app/<name>/_dev/reload`. Operator-triggered
 *      reload events broadcast on the stream cause the tab to reload.
 *   3. The operator-flow trigger is manual at MVP — `parachute-app dev
 *      <name> --trigger`. Phase 2 will wire a file watcher to fire the
 *      same broadcast on dist/ change.
 *
 * State design choices:
 *
 *   - Process-local, in-memory. A daemon restart returns every UI to
 *     production cache headers. This is deliberate — dev mode is an
 *     interactive operator concern, not a persisted property of the UI
 *     itself. If an operator wants persistence later, meta.json could
 *     grow a `dev_mode_default` field (Phase 2+).
 *   - One map module-wide. Lookup is O(name) on every request, but the
 *     map is at most a handful of entries (operator iterating on UIs).
 *   - SSE controllers live in a separate `Set` per-UI; broadcast iterates
 *     and tolerates per-client errors (disconnects are normal).
 *
 * Concurrency notes: Bun runs the event loop single-threaded, so the
 * mutations here (Map.set, Set.add) are atomic relative to one another;
 * no locking needed.
 */

export type DevModeState = {
  enabled: boolean;
  /** ms since epoch when `enabled` was last flipped to `true`. 0 when disabled. */
  enabledAt: number;
  /** Phase 2 — file watcher source dir override. Stored for forward-compat. */
  watchDir?: string;
  /** Phase 2 — auto-rebuild command override. Stored for forward-compat. */
  buildCmd?: string;
};

/**
 * SSE subscriber — a connected browser tab listening on
 * `/app/<name>/_dev/reload`. We keep both the controller (for `enqueue`)
 * and the encoder (we always emit utf8) so the broadcast path stays
 * allocation-light.
 *
 * Per-subscriber `closed` flag short-circuits the broadcast loop if a
 * `controller.enqueue` already threw on this client — we mark it dead
 * and reap on the next pass instead of re-throwing on every event.
 */
export type DevReloadSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
};

const STATE = new Map<string, DevModeState>();
const SUBSCRIBERS = new Map<string, Set<DevReloadSubscriber>>();

/** Return the dev-mode state for a UI, or the default (disabled). */
export function getDevMode(name: string): DevModeState {
  return STATE.get(name) ?? { enabled: false, enabledAt: 0 };
}

/** Pure predicate, used everywhere the cache + injection branches read. */
export function isDevMode(name: string): boolean {
  return STATE.get(name)?.enabled === true;
}

/** List every UI currently in dev mode (for the `dev list` CLI). */
export function listDevMode(): Array<{ name: string; state: DevModeState }> {
  const out: Array<{ name: string; state: DevModeState }> = [];
  for (const [name, state] of STATE) {
    if (state.enabled) out.push({ name, state });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Enable dev mode for `name`. Idempotent — calling twice doesn't reset
 * the timestamp. Returns the resulting state.
 */
export function enableDevMode(
  name: string,
  opts: { watchDir?: string; buildCmd?: string } = {},
): DevModeState {
  const existing = STATE.get(name);
  if (existing?.enabled) {
    // Idempotent — preserve the earlier `enabledAt`.
    return existing;
  }
  const next: DevModeState = {
    enabled: true,
    enabledAt: Date.now(),
    watchDir: opts.watchDir,
    buildCmd: opts.buildCmd,
  };
  STATE.set(name, next);
  return next;
}

/**
 * Disable dev mode for `name`. Also closes every connected SSE subscriber
 * so the next page load resumes production cache headers cleanly. Returns
 * the resulting state (always `enabled: false`).
 */
export function disableDevMode(name: string): DevModeState {
  STATE.set(name, { enabled: false, enabledAt: 0 });
  // Close any active SSE streams so the browser's EventSource auto-reconnect
  // doesn't keep retrying against a UI that's no longer in dev mode.
  closeAllSubscribers(name);
  return STATE.get(name)!;
}

/** Reset all dev-mode state. Tests use this. */
export function resetDevMode(): void {
  for (const name of [...SUBSCRIBERS.keys()]) {
    closeAllSubscribers(name);
  }
  STATE.clear();
  SUBSCRIBERS.clear();
}

/** Register a new SSE subscriber. The caller holds the controller. */
export function addSubscriber(name: string, subscriber: DevReloadSubscriber): void {
  let set = SUBSCRIBERS.get(name);
  if (!set) {
    set = new Set();
    SUBSCRIBERS.set(name, set);
  }
  set.add(subscriber);
}

/** Drop a subscriber (called from the stream's `cancel` hook). */
export function removeSubscriber(name: string, subscriber: DevReloadSubscriber): void {
  const set = SUBSCRIBERS.get(name);
  if (!set) return;
  set.delete(subscriber);
  if (set.size === 0) SUBSCRIBERS.delete(name);
}

/** Count of currently-connected subscribers (used by the trigger response). */
export function subscriberCount(name: string): number {
  return SUBSCRIBERS.get(name)?.size ?? 0;
}

/**
 * Broadcast a `reload` event to every subscriber of `name`. Returns the
 * number of subscribers we successfully enqueued to — a controller that
 * errors mid-broadcast (disconnect) is marked closed + removed.
 *
 * SSE wire format:
 *
 *     event: reload\n
 *     data: {"timestamp": 1716345600000}\n
 *     \n
 *
 * The empty line terminates the event; without it most browsers buffer
 * the event without dispatching.
 */
export function broadcastReload(name: string, timestamp = Date.now()): number {
  const set = SUBSCRIBERS.get(name);
  if (!set) return 0;
  const encoder = new TextEncoder();
  const payload = encoder.encode(`event: reload\ndata: ${JSON.stringify({ timestamp })}\n\n`);
  let notified = 0;
  const dead: DevReloadSubscriber[] = [];
  for (const sub of set) {
    if (sub.closed) {
      dead.push(sub);
      continue;
    }
    try {
      sub.controller.enqueue(payload);
      notified++;
    } catch {
      sub.closed = true;
      dead.push(sub);
    }
  }
  for (const d of dead) set.delete(d);
  if (set.size === 0) SUBSCRIBERS.delete(name);
  return notified;
}

/** Close + drop every subscriber for a UI. Used on disableDevMode + tests. */
export function closeAllSubscribers(name: string): void {
  const set = SUBSCRIBERS.get(name);
  if (!set) return;
  for (const sub of set) {
    if (sub.closed) continue;
    sub.closed = true;
    try {
      sub.controller.close();
    } catch {
      // already closed by the runtime — fine
    }
  }
  SUBSCRIBERS.delete(name);
}
