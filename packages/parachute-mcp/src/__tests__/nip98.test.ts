/**
 * NIP-98 event construction — adapted from the proven nip98-proxy suite. The
 * one semantic difference from the proxy: `u` is the REAL hub door URL (the
 * bridge calls the hub directly), not a loopback proxy URL.
 *
 * All keys are throwaways generated in-test. Never a real key.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  NIP98_KIND,
  buildAuthEvent,
  decodeAuthHeader,
  sha256Hex,
  signAuthHeader,
  tagValue,
} from "../nip98.js";

const TARGET = "https://hub.example.test/mcp";
const BODY = new TextEncoder().encode(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
);

describe("event shape", () => {
  const ev = buildAuthEvent({ url: TARGET, method: "post", body: BODY });

  test("kind is 27235 with empty content", () => {
    expect(ev.kind).toBe(NIP98_KIND);
    expect(ev.content).toBe("");
  });

  test("carries u, method, nonce and payload tags", () => {
    expect(tagValue(ev, "u")).toBe(TARGET);
    expect(tagValue(ev, "method")).toBe("POST"); // uppercased
    expect(tagValue(ev, "nonce")).toMatch(/^[0-9a-f]{32}$/);
    expect(tagValue(ev, "payload")).toBeString();
  });

  test("u equals the exact target hub URL", () => {
    const other = buildAuthEvent({ url: "https://parachute.techne.coop/mcp", method: "POST" });
    expect(tagValue(other, "u")).toBe("https://parachute.techne.coop/mcp");
  });

  test("payload tag is the sha256 hex of the body", () => {
    const expected = createHash("sha256").update(BODY).digest("hex");
    expect(tagValue(ev, "payload")).toBe(expected);
    expect(sha256Hex(BODY)).toBe(expected);
  });

  test("created_at is unix seconds, not millis", () => {
    expect(Math.abs(ev.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  test("no payload tag when there is no body", () => {
    const bodiless = buildAuthEvent({ url: TARGET, method: "GET" });
    expect(tagValue(bodiless, "payload")).toBeUndefined();
    expect(tagValue(bodiless, "nonce")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an empty body is treated as no payload", () => {
    const empty = buildAuthEvent({ url: TARGET, method: "POST", body: new Uint8Array(0) });
    expect(tagValue(empty, "payload")).toBeUndefined();
  });
});

describe("nonce uniqueness (event-id burn guard)", () => {
  test("two builds of the identical request differ in nonce", () => {
    const a = buildAuthEvent({ url: TARGET, method: "POST", body: BODY });
    const b = buildAuthEvent({ url: TARGET, method: "POST", body: BODY });
    expect(tagValue(a, "nonce")).not.toBe(tagValue(b, "nonce"));
    // Everything else about the two requests is identical...
    expect(tagValue(a, "payload")).toBe(tagValue(b, "payload"));
    expect(tagValue(a, "u")).toBe(tagValue(b, "u"));
  });

  test("...so the signed event ids differ, even signed in the same second", () => {
    const sk = generateSecretKey();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ev = decodeAuthHeader(
        signAuthHeader(sk, buildAuthEvent({ url: TARGET, method: "POST", body: BODY })),
      );
      ids.add(ev.id);
    }
    expect(ids.size).toBe(50);
  });
});

describe("base64 round-trip", () => {
  const sk = generateSecretKey();
  const header = signAuthHeader(sk, buildAuthEvent({ url: TARGET, method: "POST", body: BODY }));

  test("header is `Nostr <base64>`", () => {
    expect(header).toStartWith("Nostr ");
    expect(header.slice(6)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("decodes back to a valid, correctly-signed event", () => {
    const ev = decodeAuthHeader(header);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(ev.kind).toBe(NIP98_KIND);
    expect(tagValue(ev, "payload")).toBe(sha256Hex(BODY));
    expect(verifyEvent(ev)).toBe(true);
  });

  test("round-trip is stable across repeated decodes", () => {
    expect(JSON.stringify(decodeAuthHeader(header))).toBe(JSON.stringify(decodeAuthHeader(header)));
  });

  test("signing does not mutate the caller's template", () => {
    const template = buildAuthEvent({ url: TARGET, method: "POST", body: BODY });
    const before = JSON.stringify(template);
    signAuthHeader(sk, template);
    expect(JSON.stringify(template)).toBe(before);
  });
});
