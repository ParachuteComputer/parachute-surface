/**
 * Rate-limit middleware — FAIL-CLOSED, keyed off `ctx.clientIp(req)`
 * (design P7; trust signals come from the substrate, §10).
 *
 * Key derivation:
 *   - hub-stamped client IP present → per-IP bucket.
 *   - **null clientIp** → the request is unattributable. It shares ONE
 *     collective bucket per trust layer (`anon:<layer>`) — limited, never
 *     unlimited. On the `public` layer that bucket is all unattributed
 *     traffic together, so an attribution gap can never become a bypass;
 *     on `loopback`/`tailnet` (hub-stamped trusted layers) the shared
 *     bucket keeps local tooling working while still bounded.
 *
 * Implementation: fixed-window counters, in-memory (rate state is
 * operational and per-process; a supervisor restart starts fresh windows
 * — momentary leniency, no standing grant). The key table is capped:
 * when full, UNSEEN keys are refused outright (fail-closed under a
 * table-exhaustion attack) rather than evicting live counters (which
 * would fail open).
 */

export interface RateLimitOptions {
  /** Window length. Default 60s. */
  windowMs?: number;
  /** Requests allowed per key per window. Default 120. */
  max?: number;
  /** Max distinct keys tracked. Default 10_000. */
  maxKeys?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window resets (for Retry-After). */
  retryAfterSeconds: number;
}

interface Window {
  start: number;
  count: number;
}

export class RateLimiter {
  readonly #windowMs: number;
  readonly #max: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(opts: RateLimitOptions = {}) {
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#max = opts.max ?? 120;
    this.#maxKeys = opts.maxKeys ?? 10_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Derive the bucket key — see the module header. */
  static keyFor(clientIp: string | null, layer: string): string {
    return clientIp ?? `anon:${layer}`;
  }

  check(key: string): RateLimitVerdict {
    const now = this.#now();
    let win = this.#windows.get(key);
    if (win && now - win.start >= this.#windowMs) {
      win = undefined;
      this.#windows.delete(key);
    }
    if (!win) {
      if (this.#windows.size >= this.#maxKeys) {
        this.#prune(now);
      }
      if (this.#windows.size >= this.#maxKeys) {
        // Table exhausted by live windows: refuse unseen keys (fail-closed).
        return { allowed: false, retryAfterSeconds: Math.ceil(this.#windowMs / 1000) };
      }
      win = { start: now, count: 0 };
      this.#windows.set(key, win);
    }
    win.count++;
    if (win.count > this.#max) {
      const retryMs = win.start + this.#windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop windows that have lapsed. */
  #prune(now: number): void {
    for (const [key, win] of this.#windows) {
      if (now - win.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}

/** 429 with Retry-After — the refusal every limited path returns. */
export function rateLimitedResponse(verdict: RateLimitVerdict): Response {
  return Response.json(
    { error: "rate_limited", message: "Too many requests — slow down." },
    { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
  );
}
