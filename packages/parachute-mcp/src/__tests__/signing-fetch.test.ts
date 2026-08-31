/**
 * The signing fetch wrapper — every call out of it must carry a fresh,
 * verifiable NIP-98 Authorization for exactly the URL being fetched.
 */
import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { decodeAuthHeader, sha256Hex, tagValue } from "../nip98.js";
import { makeSigningFetch } from "../signing-fetch.js";

const sk = generateSecretKey();

function capture() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const baseFetch = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetch: makeSigningFetch(sk, baseFetch) };
}

function authEvent(init: RequestInit | undefined) {
  const header = new Headers(init?.headers).get("authorization");
  expect(header).toStartWith("Nostr ");
  return decodeAuthHeader(header!);
}

describe("makeSigningFetch", () => {
  test("signs a POST with u = exact URL, method, payload hash", async () => {
    const { calls, fetch } = capture();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await fetch("https://hub.example.test/mcp", { method: "POST", body });
    const ev = authEvent(calls[0]!.init);
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(tagValue(ev, "u")).toBe("https://hub.example.test/mcp");
    expect(tagValue(ev, "method")).toBe("POST");
    expect(tagValue(ev, "payload")).toBe(sha256Hex(new TextEncoder().encode(body)));
  });

  test("a bodiless GET signs with no payload tag", async () => {
    const { calls, fetch } = capture();
    await fetch(new URL("https://hub.example.test/mcp"));
    const ev = authEvent(calls[0]!.init);
    expect(tagValue(ev, "method")).toBe("GET");
    expect(tagValue(ev, "payload")).toBeUndefined();
  });

  test("byte-identical retries get fresh event ids (id-burn guard)", async () => {
    const { calls, fetch } = capture();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    await fetch("https://hub.example.test/mcp", { method: "POST", body });
    await fetch("https://hub.example.test/mcp", { method: "POST", body });
    const [a, b] = [authEvent(calls[0]!.init), authEvent(calls[1]!.init)];
    expect(a.id).not.toBe(b.id);
    expect(tagValue(a, "payload")).toBe(tagValue(b, "payload"));
  });

  test("preserves existing headers and replaces any inbound authorization", async () => {
    const { calls, fetch } = capture();
    await fetch("https://hub.example.test/mcp", {
      method: "POST",
      body: "{}",
      headers: { accept: "application/json, text/event-stream", authorization: "Bearer stale" },
    });
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("authorization")).toStartWith("Nostr ");
  });

  test("refuses body types it cannot hash", async () => {
    const { fetch } = capture();
    const stream = new ReadableStream();
    expect(fetch("https://hub.example.test/mcp", { method: "POST", body: stream })).rejects.toThrow(
      /cannot NIP-98-sign/,
    );
  });
});
