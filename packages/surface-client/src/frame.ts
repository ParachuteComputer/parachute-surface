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
 */

const PROTOCOL = 1;
const DEFAULT_CHANNEL = "parachute-frame";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PATH_LENGTH = 4096;
const MAX_HEADERS = 8;
const FORWARDED_HEADERS = ["content-type", "accept"] as const;

/** A request as seen by the host `handler` (already policy-checked). */
export interface FrameRequest {
  method: string;
  /** Path + query, always starting with a single `/`. */
  path: string;
  /** Lower-cased, allowlisted headers only (`content-type`, `accept`). */
  headers: Record<string, string>;
  body?: string;
}

/** What the host `handler` returns; becomes a real `Response` in the frame. */
export interface FrameResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FramePolicy {
  /** Allowed requests. `pattern` is tested against the path WITHOUT the query string. */
  routes: Array<{ method: string; pattern: RegExp }>;
  /** Max request body in UTF-8 bytes. Default 65536. */
  maxBodyBytes?: number;
  /** Max concurrent in-flight handler calls. Default 8. */
  maxPending?: number;
  /** Max messages from the frame per window. Default 60. */
  ratePerWindow?: number;
  /** Rate window length in ms. Default 10000. */
  windowMs?: number;
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
          const nullBody = NULL_BODY_STATUS.has(res.status);
          resolve(
            new Response(nullBody ? null : res.body, {
              status: res.status,
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
 * (silent drop, counted before any parsing) → cheap shape/size checks →
 * route allowlist (403, handler never called) → pending cap (429) → handler.
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

  let disposed = false;
  let pending = 0;
  let windowStart = 0;
  let windowCount = 0;

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

  const onMessage = (event: MessageEvent) => {
    if (disposed) return;
    const target = frame();
    if (!target || event.source !== target) return;

    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > ratePerWindow) return;

    const req = parseWireRequest(event.data, channel);
    if (!req) return;

    if (req.path.length > MAX_PATH_LENGTH || !bodyWithinLimit(req.body, maxBodyBytes)) {
      reply(target, req.id, 413, { error_type: "frame_body_too_large" });
      return;
    }

    const pathname = req.path.split(/[?#]/, 1)[0] ?? "";
    const allowed = policy.routes.some((r) => {
      if (r.method !== req.method) return false;
      r.pattern.lastIndex = 0;
      return r.pattern.test(pathname);
    });
    if (!allowed) {
      reply(target, req.id, 403, { error_type: "frame_route_denied" });
      return;
    }

    if (pending >= maxPending) {
      reply(target, req.id, 429, { error_type: "frame_busy" });
      return;
    }

    const frameReq: FrameRequest = { method: req.method, path: req.path, headers: req.headers };
    if (req.body !== undefined) frameReq.body = req.body;

    pending++;
    let run: Promise<FrameResponse>;
    try {
      run = Promise.resolve(handler(frameReq));
    } catch (err) {
      run = Promise.reject(err);
    }
    run
      .then(
        (res) => {
          if (!validFrameResponse(res)) {
            reply(target, req.id, 500, { error_type: "frame_handler_error" });
            return;
          }
          reply(target, req.id, res.status, res.body ?? "", {
            statusText: res.statusText ?? "",
            headers: res.headers ?? {},
          });
        },
        () => reply(target, req.id, 500, { error_type: "frame_handler_error" }),
      )
      .finally(() => {
        pending--;
      });
  };

  globalThis.addEventListener("message", onMessage as EventListener);
  return () => {
    disposed = true;
    globalThis.removeEventListener("message", onMessage as EventListener);
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

function parseWireRequest(data: unknown, channel: string): WireRequest | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (!hasExactKeys(d, ["pfr", "channel", "id", "method", "path", "headers"], ["body"])) {
    return null;
  }
  if (d.pfr !== PROTOCOL || d.channel !== channel) return null;
  if (typeof d.id !== "string" || d.id.length === 0 || d.id.length > 128) return null;
  if (typeof d.method !== "string" || d.method.length > 16) return null;
  if (typeof d.path !== "string" || !d.path.startsWith("/") || d.path.startsWith("//")) {
    return null;
  }
  if (!isStringRecord(d.headers) || Object.keys(d.headers).length > MAX_HEADERS) return null;
  if (d.body !== undefined && typeof d.body !== "string") return null;
  return d as unknown as WireRequest;
}
