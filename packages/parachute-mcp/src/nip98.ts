/**
 * NIP-98 HTTP Auth event construction — one signed event per HTTP request.
 *
 * Adapted from the proven loopback signing proxy (nip98-proxy) with one
 * deliberate difference: there the `u` tag was the LOOPBACK url (the URL the
 * hub saw after the proxy hop); here the bridge calls the hub directly, so
 * `u` is the real hub door URL — exactly the URL handed to `fetch`.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Event, type EventTemplate, finalizeEvent } from "nostr-tools/pure";

/** NIP-98 HTTP Auth event kind. */
export const NIP98_KIND = 27235;

export function sha256Hex(body: ArrayBuffer | Uint8Array): string {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the unsigned NIP-98 event for one request.
 *
 * The `nonce` tag is MANDATORY, not decorative: event ids are single-use on
 * the hub and burn even on FAILED auth, so two identical requests in the same
 * second would collide on id and the second would be rejected as "already been
 * used". MCP clients repeat calls. Every request — including a retry of a
 * byte-identical payload — gets a fresh nonce and a fresh created_at.
 */
export function buildAuthEvent(opts: {
  url: string;
  method: string;
  body?: ArrayBuffer | Uint8Array | null;
}): EventTemplate {
  const tags: string[][] = [
    ["u", opts.url],
    ["method", opts.method.toUpperCase()],
    ["nonce", randomBytes(16).toString("hex")],
  ];
  const len = opts.body ? opts.body.byteLength : 0;
  if (len > 0) tags.push(["payload", sha256Hex(opts.body!)]);
  return {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags,
  };
}

/** Sign an event template and render the `Authorization: Nostr <base64>` value. */
export function signAuthHeader(sk: Uint8Array, template: EventTemplate): string {
  // Copy: nostr-tools' finalizeEvent writes id/pubkey/sig onto the object it is given.
  const event = finalizeEvent({ ...template, tags: template.tags.map((t) => [...t]) }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

/** Inverse of signAuthHeader — used by tests and never on the request path. */
export function decodeAuthHeader(header: string): Event {
  const b64 = header.replace(/^Nostr\s+/i, "");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Event;
}

export function tagValue(event: EventTemplate | Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}
