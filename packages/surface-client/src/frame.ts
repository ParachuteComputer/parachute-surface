/**
 * Sandboxed-frame transport — run the stock `VaultClient` inside an
 * `<iframe sandbox="allow-scripts">` that has `connect-src 'none'`.
 *
 * `VaultClient` routes every REST call through `fetchImpl`, so a
 * postMessage-backed `fetch` lets identical surface code run standalone
 * (OAuth) or sandboxed (host-mediated):
 *
 *   - frame: `createFrameFetch()` → `new VaultClient({ vaultUrl: "frame:", ... })`
 *   - host:  `serveFrameFetch(() => iframe.contentWindow, handler, policy)`
 *
 * The host is the trust boundary. It accepts only messages from the frame
 * window, enforces an explicit route allowlist plus size / concurrency / rate
 * limits, and holds the real credentials inside its `handler`. The frame never
 * sees a token; `Authorization` is never forwarded.
 *
 * Swapping the interface: call the disposer and create a new `serveFrameFetch`
 * whenever the iframe's content is swapped or navigated. Replies are posted to
 * the captured `Window`, which survives navigation, so a long-lived server
 * would hand the old interface's responses to the new document.
 */

const PROTOCOL = 1;
const DEFAULT_CHANNEL = "parachute-frame";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PATH_LENGTH = 4096;
const MAX_HEADERS = 8;
const MAX_HEADER_VALUE = 256;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const FORWARDED_HEADERS = ["content-type", "accept"] as const;

/**
 * Host-policy `error_type` → the status `createFrameFetch` hands to the caller.
 * Statuses 401/403 would make `VaultClient` fire `onAuthRevoked` / `onAuthError`
 * for what is only a policy deny, so these are re-mapped frame-side. The
 * `error_type` body is kept.
 */
const FRAME_ERROR_STATUS: Record<string, number> = {
  frame_route_denied: 400,
  frame_body_too_large: 400,
  frame_path_too_long: 400,
  frame_bad_path: 400,
  frame_bad_headers: 400,
  frame_bad_request: 400,
  frame_busy: 503,
  frame_rate_limited: 503,
  frame_handler_timeout: 504,
};

/** A request as seen by the host `handler` (already policy-checked). */
export interface FrameRequest {
  method: string;
  /**
   * Canonical path + query (no fragment), always starting with a single `/`.
   * Already checked on the host: no backslash, whitespace/control characters,
   * `.` / `..` segments or `%2e` / `%2f` / `%5c` escapes.
   */
  path: string;
  /** Rebuilt on the host: lower-cased `content-type` / `accept` only, values ≤ 256 chars. */
  headers: Record<string, string>;
  body?: string;
  /**
   * Aborted when the request times out (`handlerTimeoutMs`) or the server is
   * disposed. Pass it to your upstream `fetch` so abandoned work is cancelled.
   */
  signal: AbortSignal;
}

/** What the host `handler` returns; becomes a real `Response` in the frame. */
export interface FrameResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FramePolicy {
  /**
   * Allowed requests. `pattern` is tested against the canonical path WITHOUT
   * the query string. `method` is normalised to upper case.
   */
  routes: Array<{ method: string; pattern: RegExp }>;
  /** Max request body in UTF-8 bytes. Default 65536. */
  maxBodyBytes?: number;
  /** Max concurrent in-flight handler calls. Default 8. */
  maxPending?: number;
  /** Max messages from the frame per window. Default 60. */
  ratePerWindow?: number;
  /** Rate window length in ms (fixed window, so a 2× burst is possible at a boundary). Default 10000. */
  windowMs?: number;
  /**
   * Max time a handler may run before the frame gets `504 frame_handler_timeout`,
   * the pending slot is freed and a late settle is ignored. Default 30000.
   */
  handlerTimeoutMs?: number;
  /**
   * Called for every request the host refuses or fails (host-side logging).
   * `reason` is one of `malformed`, `channel_mismatch`, `rate_limited`,
   * `path_too_long`, `bad_path`, `bad_headers`, `bad_request`, `body_too_large`,
   * `route_denied`, `busy`, `handler_timeout`, `handler_error`. Must not throw
   * (if it does, the error is swallowed).
   */
  onReject?: (reason: string, req: { id?: string; method?: string; path?: string }) => void;
  /** Must match the frame's `channel`. Default `"parachute-frame"`. */
  channel?: string;
}

export interface CreateFrameFetchOpts {
  /** Window to post to. Default `parent`. */
  target?: Window;
  /** Per-request timeout. Default 30000. */
  timeoutMs?: number;
  channel?: string;
}

interface WireRequest {
  pfr: 1;
  channel: string;
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

interface WireResponse {
  pfr: 1;
  channel: string;
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function hasExactKeys(o: object, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  if (!required.every((k) => keys.includes(k))) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === "string");
}

let idCounter = 0;
function newId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${++idCounter}-${rand}`;
}

// ---------------------------------------------------------------- frame side

/**
 * Frame side: a `fetch` that tunnels requests to the host over postMessage.
 * Pair with `vaultUrl: "frame:"` — only path + query cross the boundary.
 */
export function createFrameFetch(opts: CreateFrameFetchOpts = {}): typeof fetch {
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return ((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    let path: string;
    try {
      path = toFramePath(input);
    } catch (err) {
      return Promise.reject(err);
    }

    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      return Promise.reject(
        new TypeError(
          "frame fetch: body must be a string (Blob, FormData, streams, buffers and URLSearchParams are not supported)",
        ),
      );
    }

    const headers: Record<string, string> = {};
    const h = new Headers(init.headers);
    for (const name of FORWARDED_HEADERS) {
      const v = h.get(name);
      if (v !== null) headers[name] = v;
    }

    const id = newId();
    const msg: WireRequest = {
      pfr: PROTOCOL,
      channel,
      id,
      method: (init.method ?? "GET").toUpperCase(),
      path,
      headers,
    };
    if (typeof body === "string") msg.body = body;

    const target = opts.target ?? parent;
    const signal = init.signal;
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new TypeError("frame fetch timeout"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        globalThis.removeEventListener("message", onMessage as EventListener);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== target) return;
        const res = parseWireResponse(event.data, channel, id);
        if (!res) return;
        cleanup();
        try {
          const status = remapPolicyStatus(res.status, res.body);
          const nullBody = NULL_BODY_STATUS.has(status);
          resolve(
            new Response(nullBody ? null : res.body, {
              status,
              statusText: res.statusText,
              headers: res.headers,
            }),
          );
        } catch {
          reject(new TypeError("frame fetch: host sent an invalid response"));
        }
      };

      globalThis.addEventListener("message", onMessage as EventListener);
      signal?.addEventListener("abort", onAbort);

      try {
        // "*" is required: a sandboxed (no allow-same-origin) frame's parent
        // origin is not nameable from inside. Safe because the payload carries
        // no credentials and only the frame's own parent is `target`.
        target.postMessage(msg, "*");
      } catch (err) {
        cleanup();
        reject(new TypeError(`frame fetch: postMessage failed: ${String(err)}`));
      }
    });
  }) as typeof fetch;
}

function remapPolicyStatus(status: number, body: string): number {
  if (status < 400 || !body.includes("frame_")) return status;
  let errorType: unknown;
  try {
    errorType = (JSON.parse(body) as { error_type?: unknown }).error_type;
  } catch {
    return status;
  }
  if (typeof errorType !== "string" || !errorType.startsWith("frame_")) return status;
  const mapped = FRAME_ERROR_STATUS[errorType];
  if (mapped !== undefined) return mapped;
  return status === 401 || status === 403 ? 400 : status;
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function toFramePath(input: RequestInfo | URL): string {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else throw new TypeError("frame fetch: request input must be a string or URL");
  const path = raw.startsWith("frame:") ? raw.slice("frame:".length) : raw;
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError(`frame fetch: unsupported URL (expected "frame:/path"): ${raw}`);
  }
  return path;
}

function parseWireResponse(data: unknown, channel: string, id: string): WireResponse | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.pfr !== PROTOCOL || d.channel !== channel || d.id !== id) return null;
  if (!hasExactKeys(d, ["pfr", "channel", "id", "status", "statusText", "headers", "body"])) {
    return null;
  }
  if (typeof d.status !== "number" || !Number.isInteger(d.status)) return null;
  if (typeof d.statusText !== "string" || typeof d.body !== "string") return null;
  if (!isStringRecord(d.headers)) return null;
  return d as unknown as WireResponse;
}

// ----------------------------------------------------------------- host side

/**
 * Host side: serve a sandboxed frame's tunnelled requests. Returns a disposer.
 *
 * Order of defences per message: source check (silent drop) → rate limit
 * (counted before any parsing; 429 only when the message carries an id) →
 * shape parse → path canonicalization → header rebuild → body checks → route
 * allowlist (handler never called) → pending cap → handler (with a timeout and
 * an `AbortSignal`). Every refusal is reported to `policy.onReject`.
 *
 * Call the disposer and create a new server when you swap the iframe's
 * interface: it drops pending replies AND aborts in-flight handlers (a POST
 * whose upstream request already left may still take effect), and a server
 * kept across a swap would deliver the old interface's replies to the new one.
 * A reply that never arrives (e.g. a `channel` mismatch) looks like a
 * `timeoutMs` hang in the frame — check `channel` first and use `onReject`.
 */
export function serveFrameFetch(
  frame: () => Window | null,
  handler: (req: FrameRequest) => Promise<FrameResponse>,
  policy: FramePolicy,
): () => void {
  const channel = policy.channel ?? DEFAULT_CHANNEL;
  const maxBodyBytes = policy.maxBodyBytes ?? 64 * 1024;
  const maxPending = policy.maxPending ?? 8;
  const ratePerWindow = policy.ratePerWindow ?? 60;
  const windowMs = policy.windowMs ?? 10_000;
  const handlerTimeoutMs = policy.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const routes = policy.routes.map((r) => ({ method: r.method.toUpperCase(), pattern: r.pattern }));

  let disposed = false;
  let pending = 0;
  // Monotonic: a stepped wall clock must not freeze or skip the window.
  let windowStart = Number.NEGATIVE_INFINITY;
  let windowCount = 0;
  const inflight = new Set<() => void>();

  const reject = (reason: string, req: { id?: string; method?: string; path?: string } = {}) => {
    try {
      policy.onReject?.(reason, req);
    } catch {
      // host logging must never break serving
    }
  };

  const reply = (
    target: Window,
    id: string,
    status: number,
    body: unknown,
    extra: { statusText?: string; headers?: Record<string, string> } = {},
  ) => {
    if (disposed) return;
    const out: WireResponse = {
      pfr: PROTOCOL,
      channel,
      id,
      status,
      statusText: extra.statusText ?? "",
      headers: extra.headers ?? { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
    try {
      target.postMessage(out, "*");
    } catch {
      // frame went away
    }
  };

  const refuse = (
    target: Window,
    req: { id: string; method: string; path: string },
    reason: string,
    status: number,
    errorType: string,
  ) => {
    reject(reason, { id: req.id, method: req.method, path: req.path.slice(0, 256) });
    reply(target, req.id, status, { error_type: errorType });
  };

  const onMessage = (event: MessageEvent) => {
    if (disposed) return;
    const target = frame();
    if (!target || event.source !== target) return;

    const now = performance.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > ratePerWindow) {
      const peek = peekRequest(event.data);
      reject("rate_limited", peek ?? {});
      if (peek?.id !== undefined) {
        reply(target, peek.id, 429, { error_type: "frame_rate_limited" });
      }
      return;
    }

    const parsed = parseWireRequest(event.data, channel);
    if (parsed.kind === "invalid") {
      reject(parsed.reason, peekRequest(event.data) ?? {});
      if (parsed.reason === "channel_mismatch") {
        console.debug(
          `[parachute-frame] ignored a message on a different channel (host expects "${channel}")`,
        );
      }
      return;
    }
    const req = parsed.req;

    if (req.path.length > MAX_PATH_LENGTH) {
      refuse(target, req, "path_too_long", 413, "frame_path_too_long");
      return;
    }
    const path = canonicalPath(req.path);
    if (path === null) {
      refuse(target, req, "bad_path", 400, "frame_bad_path");
      return;
    }
    const headers = rebuildHeaders(req.headers);
    if (headers === null) {
      refuse(target, req, "bad_headers", 400, "frame_bad_headers");
      return;
    }
    const upper = req.method.toUpperCase();
    if (req.body !== undefined && (upper === "GET" || upper === "HEAD")) {
      refuse(target, req, "bad_request", 400, "frame_bad_request");
      return;
    }
    if (!bodyWithinLimit(req.body, maxBodyBytes)) {
      refuse(target, req, "body_too_large", 413, "frame_body_too_large");
      return;
    }

    const pathname = path.split("?", 1)[0] ?? "";
    const allowed = routes.some((r) => {
      if (r.method !== req.method) return false;
      r.pattern.lastIndex = 0;
      return r.pattern.test(pathname);
    });
    if (!allowed) {
      refuse(target, req, "route_denied", 403, "frame_route_denied");
      return;
    }

    if (pending >= maxPending) {
      refuse(target, req, "busy", 429, "frame_busy");
      return;
    }

    const ac = new AbortController();
    const frameReq: FrameRequest = {
      method: req.method,
      path,
      headers,
      signal: ac.signal,
    };
    if (req.body !== undefined) frameReq.body = req.body;

    pending++;
    let done = false;
    // Idempotent: frees the slot exactly once (settle, timeout or dispose).
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      pending--;
      clearTimeout(timer);
      inflight.delete(onDispose);
      return true;
    };
    const onDispose = () => {
      if (finish()) ac.abort();
    };
    const timer = setTimeout(() => {
      if (!finish()) return;
      ac.abort();
      refuse(target, req, "handler_timeout", 504, "frame_handler_timeout");
    }, handlerTimeoutMs);
    inflight.add(onDispose);

    let run: Promise<FrameResponse>;
    try {
      run = Promise.resolve(handler(frameReq));
    } catch (err) {
      run = Promise.reject(err);
    }
    run.then(
      (res) => {
        if (!finish()) return; // timed out / disposed: late settle ignored
        if (!validFrameResponse(res)) {
          console.warn(
            "[parachute-frame] handler returned something that is not a FrameResponse " +
              "({status: 200-599, statusText?, headers?: string map, body?: string}); " +
              "a real Response (stream body) is not accepted — await res.text() first",
          );
          refuse(target, req, "handler_error", 500, "frame_handler_error");
          return;
        }
        reply(target, req.id, res.status, res.body ?? "", {
          statusText: res.statusText ?? "",
          headers: res.headers ?? {},
        });
      },
      () => {
        if (!finish()) return;
        refuse(target, req, "handler_error", 500, "frame_handler_error");
      },
    );
  };

  globalThis.addEventListener("message", onMessage as EventListener);
  return () => {
    disposed = true;
    globalThis.removeEventListener("message", onMessage as EventListener);
    for (const abort of [...inflight]) abort();
  };
}

function bodyWithinLimit(body: string | undefined, max: number): boolean {
  if (body === undefined) return true;
  if (body.length > max) return false; // UTF-8 bytes >= UTF-16 units
  if (body.length * 3 <= max) return true; // cannot exceed even at 3 bytes/unit
  return new TextEncoder().encode(body).length <= max;
}

function validFrameResponse(res: unknown): res is FrameResponse {
  if (typeof res !== "object" || res === null) return false;
  const r = res as Record<string, unknown>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status)) return false;
  if (r.status < 200 || r.status > 599) return false;
  if (r.statusText !== undefined && typeof r.statusText !== "string") return false;
  if (r.body !== undefined && typeof r.body !== "string") return false;
  if (r.headers !== undefined && !isStringRecord(r.headers)) return false;
  return true;
}

/** Cheap, non-validating read of a message's id/method/path for replies and logging. */
function peekRequest(data: unknown): { id?: string; method?: string; path?: string } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.pfr !== PROTOCOL) return null;
  const out: { id?: string; method?: string; path?: string } = {};
  if (typeof d.id === "string" && d.id.length > 0 && d.id.length <= 128) out.id = d.id;
  if (typeof d.method === "string") out.method = d.method.slice(0, 16);
  if (typeof d.path === "string") out.path = d.path.slice(0, 256);
  return out;
}

const FRAME_ORIGIN = "http://frame.invalid";
// `\` (WHATWG treats it as `/`), whitespace and C0/C1 controls (the URL parser
// strips tab/LF/CR), and encoded dot / slash / backslash.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const FORBIDDEN_PATH = /[\\\u0000-\u0020\u007f-\u009f]|%2e|%2f|%5c/i;

/**
 * The regex allowlist and the eventual `fetch` must see the same path. Reject
 * anything the URL parser would rewrite, then hand back `pathname + search`
 * with the fragment removed; null if the path is not canonical.
 */
function canonicalPath(raw: string): string | null {
  const hash = raw.indexOf("#");
  const noFragment = hash === -1 ? raw : raw.slice(0, hash);
  const q = noFragment.indexOf("?");
  const pathPart = q === -1 ? noFragment : noFragment.slice(0, q);
  if (FORBIDDEN_PATH.test(noFragment)) return null;
  if (pathPart.split("/").some((seg) => seg === "." || seg === "..")) return null;
  let url: URL;
  try {
    url = new URL(noFragment, FRAME_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== FRAME_ORIGIN) return null;
  const canonical = url.pathname + url.search;
  return canonical === noFragment ? canonical : null;
}

/** Allowlisted, lower-cased, length-capped copy; null on an oversize value or a case-variant duplicate. */
function rebuildHeaders(wire: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(wire)) {
    const name = key.toLowerCase();
    if (!(FORWARDED_HEADERS as readonly string[]).includes(name)) continue;
    if (value.length > MAX_HEADER_VALUE || name in out) return null;
    out[name] = value;
  }
  return out;
}

type ParsedRequest =
  | { kind: "ok"; req: WireRequest }
  | { kind: "invalid"; reason: "malformed" | "channel_mismatch" };

function parseWireRequest(data: unknown, channel: string): ParsedRequest {
  const malformed = { kind: "invalid", reason: "malformed" } as const;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return malformed;
  const d = data as Record<string, unknown>;
  if (!hasExactKeys(d, ["pfr", "channel", "id", "method", "path", "headers"], ["body"])) {
    return malformed;
  }
  if (d.pfr !== PROTOCOL) return malformed;
  if (d.channel !== channel) {
    return typeof d.channel === "string"
      ? { kind: "invalid", reason: "channel_mismatch" }
      : malformed;
  }
  if (typeof d.id !== "string" || d.id.length === 0 || d.id.length > 128) return malformed;
  if (typeof d.method !== "string" || d.method.length > 16) return malformed;
  if (typeof d.path !== "string" || !d.path.startsWith("/") || d.path.startsWith("//")) {
    return malformed;
  }
  if (!isStringRecord(d.headers) || Object.keys(d.headers).length > MAX_HEADERS) return malformed;
  if (d.body !== undefined && typeof d.body !== "string") return malformed;
  return { kind: "ok", req: d as unknown as WireRequest };
}
