/**
 * A `fetch` wrapper that signs EVERY outgoing request with a fresh NIP-98
 * event. Handed to the SDK's `StreamableHTTPClientTransport` as its custom
 * `fetch`, so all of the transport's traffic — POST messages, the GET/SSE
 * stream, session DELETE, and every internal retry/reconnect — carries a
 * fresh signature. Signing inside fetch (rather than static headers) is the
 * whole point: the hub burns event ids even on FAILED auth, so a re-sent
 * header is a rejected header.
 *
 * The NIP-98 `u` tag is exactly the URL being fetched — the hub verifies
 * `u === <url the hub sees>`, and the bridge calls the hub directly.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildAuthEvent, signAuthHeader } from "./nip98.js";

function bodyBytes(body: unknown): Uint8Array | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // The SDK transport only ever sends JSON strings; anything else (streams,
  // FormData…) cannot be hashed without consuming it. Fail loudly rather than
  // sign a wrong payload tag.
  const kind = (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body;
  throw new Error(`parachute-mcp: cannot NIP-98-sign a ${kind} body`);
}

/** Wrap `baseFetch` so every request carries a fresh NIP-98 Authorization. */
export function makeSigningFetch(sk: Uint8Array, baseFetch: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const target = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";
    const body = bodyBytes(init?.body);
    // Fresh nonce + fresh created_at per call — see nip98.ts.
    const auth = signAuthHeader(sk, buildAuthEvent({ url: target, method, body }));
    const headers = new Headers(init?.headers);
    headers.set("authorization", auth);
    return baseFetch(url, { ...init, headers });
  };
}
