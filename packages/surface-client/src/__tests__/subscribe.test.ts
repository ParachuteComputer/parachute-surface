/**
 * Tests for the live-query subscription CONTRACT surface in `subscribe.ts` —
 * the client-side query guard (`assertSubscribableQuery`, reached synchronously
 * via `VaultClient.subscribe` before any transport work).
 *
 * The transport itself is WebSocket-only and is covered end-to-end in
 * `ws-transport.test.ts` (handshake, dispatch, liveness, close-code map,
 * degrade-to-polling). There is no SSE transport to test — SSE was retired when
 * the live-query client went WebSocket-only.
 */

import { describe, expect, test } from "bun:test";

import { assertSubscribableQuery } from "../subscribe.ts";
import { VaultClient } from "../vault-client.ts";

describe("assertSubscribableQuery — unsupported live shapes", () => {
  test("rejects search / near / cursor, accepts the supported grammar", () => {
    expect(() => assertSubscribableQuery(new URLSearchParams({ search: "x" }))).toThrow(/search/);
    expect(() => assertSubscribableQuery(new URLSearchParams({ "near[note_id]": "abc" }))).toThrow(/near/);
    expect(() => assertSubscribableQuery(new URLSearchParams({ cursor: "abc" }))).toThrow(/cursor/);
    expect(() =>
      assertSubscribableQuery(new URLSearchParams({ tag: "#a,#b", "meta[status][eq]": "open", path_prefix: "Work/" })),
    ).not.toThrow();
  });
});

describe("VaultClient.subscribe — client-side query validation", () => {
  // A WebSocket ctor that never connects — proves the query guard throws
  // SYNCHRONOUSLY, before any transport is touched.
  const inertWs = class {
    readyState = 0;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_url: string) {}
    send() {}
    close() {}
  } as unknown as ConstructorParameters<typeof VaultClient>[0]["webSocketImpl"];

  const client = new VaultClient({ vaultUrl: "http://localhost:9", accessToken: "t", webSocketImpl: inertWs });
  const handlers = { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} };

  test("rejects search", () => {
    expect(() => client.subscribe({ search: "x" }, handlers)).toThrow(/search/);
  });
  test("rejects near", () => {
    expect(() => client.subscribe({ "near[note_id]": "abc" }, handlers)).toThrow(/near/);
  });
  test("rejects cursor", () => {
    expect(() => client.subscribe({ cursor: "abc" }, handlers)).toThrow(/cursor/);
  });
  test("accepts the supported grammar untouched (no throw before connect)", () => {
    const unsub = client.subscribe(
      { tag: "#a,#b", "meta[status][eq]": "open", path_prefix: "Work/" },
      { ...handlers, onError: () => {} },
      { initialBackoffMs: 5 },
    );
    unsub();
  });
});
