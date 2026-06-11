/**
 * BackendSupervisor — mount lifecycle + fault containment for backed
 * surfaces (surface-runtime design P5 + §11).
 *
 * One supervisor per daemon. For every installed surface whose meta.json
 * declares a `server` block, the supervisor dynamically imports the entry
 * at mount time (boot / add / reload), calls the default-export factory
 * with the surface's host context, and holds the resulting
 * {@link SurfaceBackend} for the routing layer (P4) to dispatch into.
 *
 * CONTAINMENT IS NON-OPTIONAL (§11 — Workers were rejected; v1 is
 * in-process with a hard middleware):
 *
 *   - **Per-request timeout** (`server.timeoutMs`, bounded at parse time):
 *     a request that outlives it returns 504 generic JSON and counts as a
 *     failure. The backend's work is NOT forcibly cancelled (no real
 *     isolation in-process — the honest charter line) but the caller is
 *     released and the failure feeds the crash-loop counter.
 *   - **Error boundary**: a sync throw or rejected promise from
 *     `backend.fetch` returns 500 with a generic JSON body — no stack, no
 *     filesystem path, nothing surface-author-shaped leaks to the client.
 *     The real error goes to the daemon log. Only THAT surface is
 *     affected; siblings keep serving.
 *   - **Crash-loop quarantine**: failures are tracked in a sliding window;
 *     at the threshold the surface flips to `backend-disabled` — 503 for
 *     its api/ws namespaces (the static bundle still serves) and surfaced
 *     in admin status — until an operator reload remounts it.
 *
 * Unmount: `ctx.shutdownSignal` aborts FIRST (long-lived work keyed to the
 * signal stops), then `backend.shutdown()` is awaited with a ~5s bound.
 *
 * Entry resolution re-checks containment (the meta-schema validator already
 * rejected traversal shapes; this is defense in depth for metas written to
 * disk by other tools): the resolved entry must live under the surface's
 * own directory. Reload imports a fresh module instance via a
 * generation-stamped file URL query so edited entries actually re-evaluate
 * (ESM caches by specifier).
 */

import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  BackendMountSpec,
  BackendWebSocketHandlers,
  SurfaceBackend,
  SurfaceBackendFactory,
  SurfaceHostContext,
  SurfaceStatus,
} from "./backend-types.ts";
import type { RegisteredUi } from "./ui-registry.ts";

/** Failures inside the window before quarantine. */
export const DEFAULT_CRASH_LOOP_MAX = 5;
/** Sliding-window width for the crash-loop counter. */
export const DEFAULT_CRASH_LOOP_WINDOW_MS = 60_000;
/** Bound on `shutdown()` at unmount. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

type MountedStatus = Exclude<SurfaceStatus, "static-only">;

interface MountRecord {
  spec: BackendMountSpec;
  /** Present iff the factory succeeded. */
  backend?: SurfaceBackend;
  status: MountedStatus;
  /** Operator-facing reason for backend-error / backend-disabled. */
  reason?: string;
  /** Timestamps (ms) of recent contained failures — the sliding window. */
  failures: number[];
  /** Aborting this fires ctx.shutdownSignal. */
  controller: AbortController;
  /** Bumped per mount so reloads import a fresh module instance. */
  generation: number;
}

export type BackendSupervisorOpts = {
  /**
   * Build the per-surface host context (commit 3's `buildHostContext`).
   * Called once per mount with the mount's abort signal.
   */
  buildContext: (ui: RegisteredUi, signal: AbortSignal) => SurfaceHostContext;
  /**
   * Credential gate (#101). When supplied, evaluated at mount time: a
   * non-null return (the operator-actionable reason) parks the record in
   * `pending-credential` WITHOUT calling the factory — factories that
   * await a vault token at startup (store/reconciler start) would block
   * the add/boot path until a credential is delivered. The deferred mount
   * runs via {@link BackendSupervisor.retryPendingCredentialMounts} when
   * the credential lands (delivery endpoint, binding-config change) or on
   * an operator reload. Absent → every mount proceeds immediately
   * (today's behavior; unit tests / contexts without a credential store).
   */
  pendingCredentialReason?: (ui: RegisteredUi) => string | null;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Test seam — dynamic import. Defaults to the real `import()`. */
  importFn?: (specifier: string) => Promise<unknown>;
  /** Test seam for the clock. */
  now?: () => number;
  crashLoopMax?: number;
  crashLoopWindowMs?: number;
  shutdownTimeoutMs?: number;
};

/** Generic JSON error responses — deliberately free of any backend detail. */
function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Race a promise against a timeout WITHOUT leaking the timer.
 *
 * The losing arm is ABANDONED, not cancelled — in-process code has no
 * preemption (§11), so a timed-out `fetch` / hung `shutdown()` keeps
 * running detached until it settles on its own. The timeout releases the
 * CALLER (and feeds the crash-loop counter), nothing more; backends must
 * key long-running work to `ctx.shutdownSignal`.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Extract the supervisor-relevant spec from a registered UI, or null. */
export function mountSpecFor(ui: RegisteredUi): BackendMountSpec | null {
  if (!ui.meta.server) return null;
  return {
    name: ui.meta.name,
    uiDir: ui.uiDir,
    mount: ui.meta.path,
    server: ui.meta.server,
  };
}

export class BackendSupervisor {
  private readonly mounts = new Map<string, MountRecord>();
  private readonly buildContext: BackendSupervisorOpts["buildContext"];
  private readonly pendingCredentialReason: BackendSupervisorOpts["pendingCredentialReason"];
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly importFn: (specifier: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly crashLoopMax: number;
  private readonly crashLoopWindowMs: number;
  private readonly shutdownTimeoutMs: number;
  private generationCounter = 0;

  constructor(opts: BackendSupervisorOpts) {
    this.buildContext = opts.buildContext;
    this.pendingCredentialReason = opts.pendingCredentialReason;
    this.logger = opts.logger ?? console;
    this.importFn = opts.importFn ?? ((specifier) => import(specifier));
    this.now = opts.now ?? Date.now;
    this.crashLoopMax = opts.crashLoopMax ?? DEFAULT_CRASH_LOOP_MAX;
    this.crashLoopWindowMs = opts.crashLoopWindowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  /** Is a backend record present (any status) for this surface? */
  has(name: string): boolean {
    return this.mounts.has(name);
  }

  /**
   * Real per-surface status (P5). Static surfaces report "static-only";
   * a declared-but-unmounted backend reports "backend-error" (the surface
   * still serves statically, its api namespace 503s).
   */
  statusFor(ui: RegisteredUi): SurfaceStatus {
    if (!ui.meta.server) return "static-only";
    const rec = this.mounts.get(ui.meta.name);
    if (!rec) return "backend-error";
    this.pruneFailures(rec);
    return rec.status;
  }

  /** Operator-facing reason for non-active states (admin surfacing). */
  reasonFor(name: string): string | undefined {
    return this.mounts.get(name)?.reason;
  }

  /** The mounted backend's websocket handlers, iff healthy + declared (P4/P6). */
  websocketHandlersFor(name: string): BackendWebSocketHandlers | undefined {
    const rec = this.mounts.get(name);
    if (!rec || !rec.backend || rec.status === "backend-disabled") return undefined;
    if (!rec.spec.server.capabilities.includes("websocket")) return undefined;
    return rec.backend.websocket;
  }

  /**
   * Reconcile the mounted set against the current scan: unmount removed /
   * de-backed surfaces, mount new ones, remount surfaces whose server spec
   * or location changed. Unchanged mounts are left alone (a list refresh
   * must not churn live backends).
   */
  async sync(uis: ReadonlyArray<RegisteredUi>): Promise<void> {
    const wanted = new Map<string, { ui: RegisteredUi; spec: BackendMountSpec }>();
    for (const ui of uis) {
      const spec = mountSpecFor(ui);
      if (spec) wanted.set(spec.name, { ui, spec });
    }
    for (const name of [...this.mounts.keys()]) {
      const next = wanted.get(name);
      if (!next) {
        await this.unmount(name);
        continue;
      }
      const current = this.mounts.get(name);
      if (current && specChanged(current.spec, next.spec)) {
        await this.unmount(name);
      }
    }
    for (const { ui } of wanted.values()) {
      if (!this.mounts.has(ui.meta.name)) {
        await this.mount(ui);
      }
    }
  }

  /**
   * Mount one backed surface: resolve + import the entry, call the factory
   * under try/catch. Failure → `backend-error` record (the routing layer
   * 503s the api namespace; the static bundle is untouched).
   */
  async mount(ui: RegisteredUi): Promise<void> {
    const spec = mountSpecFor(ui);
    if (!spec) return;
    if (this.mounts.has(spec.name)) await this.unmount(spec.name);

    const controller = new AbortController();
    const generation = ++this.generationCounter;
    const rec: MountRecord = {
      spec,
      status: "backend-error",
      failures: [],
      controller,
      generation,
    };
    this.mounts.set(spec.name, rec);

    // Entry containment — defense in depth behind the meta-schema validator.
    const uiRoot = path.resolve(spec.uiDir);
    const entryPath = path.resolve(uiRoot, spec.server.entry);
    if (entryPath !== uiRoot && !entryPath.startsWith(`${uiRoot}${path.sep}`)) {
      rec.reason = "server.entry escapes the surface directory";
      this.logger.error(`[app] backend ${spec.name}: ${rec.reason} (${spec.server.entry})`);
      return;
    }
    if (!existsSync(entryPath)) {
      rec.reason = `server entry not found: ${spec.server.entry}`;
      this.logger.error(`[app] backend ${spec.name}: ${rec.reason}`);
      return;
    }

    // Credential gate (#101) — AFTER the structural checks (a broken entry
    // honestly reads backend-error, never pending) but BEFORE any module
    // execution: a factory that awaits a vault token at startup must not
    // run until the credential exists, or it blocks the add/boot path.
    const pendingReason = this.pendingCredentialReason?.(ui) ?? null;
    if (pendingReason !== null) {
      rec.status = "pending-credential";
      rec.reason = pendingReason;
      this.logger.log(`[app] backend ${spec.name}: mount deferred — ${pendingReason}`);
      return;
    }

    let factory: SurfaceBackendFactory;
    try {
      // Fresh-module discipline for reload, belt and suspenders:
      //   1. Bun caches modules by PATH and ignores URL queries — deleting
      //      the require.cache entry is what actually re-evaluates an
      //      edited entry (verified on Bun 1.3.13).
      //   2. The generation-stamped query is kept for Node-ESM semantics
      //      (where distinct specifiers yield distinct instances) so the
      //      behavior holds if the host ever runs outside Bun.
      try {
        if (typeof require !== "undefined" && require.cache) {
          delete require.cache[entryPath];
          // Bun keys require.cache by REALPATH. When any segment of the
          // uis dir is a symlink (macOS /tmp → /private/tmp; a symlinked
          // $PARACHUTE_HOME), the literal entryPath misses the entry and a
          // rapid same-mtime replace (#103's force-add) keeps serving the
          // OLD module. Delete the realpath key too.
          try {
            delete require.cache[realpathSync(entryPath)];
          } catch {
            // entry vanished mid-mount — the existsSync gate above already
            // covered the honest-missing case; the import below reports it
          }
        }
      } catch {
        // no require.cache in this runtime — the query stamp covers it
      }
      const specifier = `${pathToFileURL(entryPath).href}?gen=${generation}`;
      const mod = (await this.importFn(specifier)) as { default?: unknown };
      if (typeof mod?.default !== "function") {
        rec.reason = "server entry has no default-export factory";
        this.logger.error(`[app] backend ${spec.name}: ${rec.reason}`);
        return;
      }
      factory = mod.default as SurfaceBackendFactory;
    } catch (e) {
      rec.reason = `server entry failed to import: ${errMsg(e)}`;
      this.logger.error(`[app] backend ${spec.name}: ${rec.reason}`);
      return;
    }

    try {
      const ctx = this.buildContext(ui, controller.signal);
      const backend = await factory(ctx);
      if (!backend || typeof backend.fetch !== "function") {
        rec.reason = "factory did not return a backend with a fetch handler";
        this.logger.error(`[app] backend ${spec.name}: ${rec.reason}`);
        return;
      }
      rec.backend = backend;
      rec.status = "active";
      rec.reason = undefined;
      this.logger.log(`[app] backend ${spec.name}: mounted (${spec.server.entry})`);
    } catch (e) {
      rec.reason = `backend factory threw: ${errMsg(e)}`;
      this.logger.error(`[app] backend ${spec.name}: ${rec.reason}`);
    }
  }

  /**
   * Unmount: abort the context signal FIRST, then await a bounded
   * `shutdown()`. Always removes the record (even when shutdown misbehaves
   * — the mount is gone either way; a hung shutdown is logged).
   */
  async unmount(name: string): Promise<void> {
    const rec = this.mounts.get(name);
    if (!rec) return;
    this.mounts.delete(name);
    try {
      rec.controller.abort();
    } catch {
      // an abort listener threw — backend's problem, not the host's
    }
    const shutdown = rec.backend?.shutdown;
    if (shutdown) {
      try {
        const result = await withTimeout(shutdown.call(rec.backend), this.shutdownTimeoutMs);
        if (result.timedOut) {
          this.logger.warn(
            `[app] backend ${name}: shutdown() exceeded ${this.shutdownTimeoutMs}ms — abandoned`,
          );
        }
      } catch (e) {
        this.logger.warn(`[app] backend ${name}: shutdown() threw: ${errMsg(e)}`);
      }
    }
    this.logger.log(`[app] backend ${name}: unmounted`);
  }

  /** Operator reload: full unmount + remount. Resets the crash-loop window. */
  async reload(ui: RegisteredUi): Promise<void> {
    await this.unmount(ui.meta.name);
    await this.mount(ui);
  }

  /**
   * Re-attempt the deferred factory mount for every record parked in
   * `pending-credential` (#101). Called when a credential lands (the hub
   * delivery endpoint) and after a `credential_connections` binding change;
   * harmless any time — records whose gate still refuses stay pending
   * untouched. Returns the names whose mount was retried (their status now
   * reflects the real factory outcome).
   */
  async retryPendingCredentialMounts(uis: ReadonlyArray<RegisteredUi>): Promise<string[]> {
    const retried: string[] = [];
    for (const [name, rec] of [...this.mounts]) {
      if (rec.status !== "pending-credential") continue;
      const ui = uis.find((u) => u.meta.name === name);
      if (!ui?.meta.server) continue; // removed/de-backed since — sync()'s job
      if ((this.pendingCredentialReason?.(ui) ?? null) !== null) continue; // still gated
      await this.mount(ui);
      retried.push(name);
    }
    return retried;
  }

  /** Unmount everything (daemon shutdown). */
  async stop(): Promise<void> {
    for (const name of [...this.mounts.keys()]) {
      await this.unmount(name);
    }
  }

  /**
   * The containment middleware (NON-OPTIONAL, §11): every request the
   * routing layer forwards to a backend goes through here.
   */
  async handleRequest(ui: RegisteredUi, req: Request): Promise<Response> {
    const rec = this.mounts.get(ui.meta.name);
    if (!rec) {
      return jsonError(503, "backend_unavailable", "this surface's backend is not mounted");
    }
    this.pruneFailures(rec);
    if (rec.status === "backend-disabled") {
      return jsonError(
        503,
        "backend_disabled",
        "this surface's backend is quarantined after repeated failures — reload it from the surface admin",
      );
    }
    if (rec.status === "pending-credential") {
      return jsonError(
        503,
        "credential_pending",
        "this surface's backend is waiting for a vault credential — approve a credential connection in the hub admin",
      );
    }
    if (!rec.backend) {
      return jsonError(503, "backend_unavailable", "this surface's backend failed to mount");
    }

    const timeoutMs = rec.spec.server.timeoutMs;
    try {
      // Promise.resolve inside the try block — a SYNC throw from
      // backend.fetch lands in the catch, same as a rejection.
      const raced = await withTimeout(Promise.resolve(rec.backend.fetch(req)), timeoutMs);
      if (raced.timedOut) {
        this.recordFailure(rec, `request timed out after ${timeoutMs}ms`);
        return jsonError(504, "backend_timeout", "the surface backend did not respond in time");
      }
      const res = raced.value;
      if (!(res instanceof Response)) {
        this.recordFailure(rec, "fetch returned a non-Response value");
        return jsonError(500, "backend_error", "the surface backend returned an invalid response");
      }
      return res;
    } catch (e) {
      // The generic body is deliberate: no message, no stack, no path — the
      // real error goes to the daemon log only.
      this.recordFailure(rec, errMsg(e));
      return jsonError(500, "backend_error", "the surface backend failed to handle this request");
    }
  }

  /**
   * Record one contained failure; quarantine at the threshold. Exposed for
   * the WS pump (commit 5), whose handler errors share the same window.
   */
  recordContainedFailure(name: string, detail: string): void {
    const rec = this.mounts.get(name);
    if (rec) this.recordFailure(rec, detail);
  }

  private recordFailure(rec: MountRecord, detail: string): void {
    const now = this.now();
    rec.failures.push(now);
    this.pruneFailures(rec, now);
    this.logger.warn(
      `[app] backend ${rec.spec.name}: contained failure (${rec.failures.length}/${this.crashLoopMax} in window): ${detail}`,
    );
    if (rec.status === "backend-disabled") return;
    if (rec.failures.length >= this.crashLoopMax) {
      rec.status = "backend-disabled";
      rec.reason = `quarantined after ${rec.failures.length} failures within ${this.crashLoopWindowMs}ms — reload to recover`;
      this.logger.error(`[app] backend ${rec.spec.name}: ${rec.reason}`);
    } else if (rec.backend) {
      rec.status = "failing";
    }
  }

  /** Drop window-expired failures; recover "failing" → "active" when clear. */
  private pruneFailures(rec: MountRecord, now = this.now()): void {
    const cutoff = now - this.crashLoopWindowMs;
    rec.failures = rec.failures.filter((t) => t > cutoff);
    if (rec.status === "failing" && rec.failures.length === 0) {
      rec.status = "active";
    }
  }
}

/** Did anything the mount depends on change? (entry, dir, timeout, caps) */
function specChanged(a: BackendMountSpec, b: BackendMountSpec): boolean {
  return (
    a.uiDir !== b.uiDir ||
    a.mount !== b.mount ||
    a.server.entry !== b.server.entry ||
    a.server.format !== b.server.format ||
    a.server.timeoutMs !== b.server.timeoutMs ||
    a.server.capabilities.join(",") !== b.server.capabilities.join(",")
  );
}
