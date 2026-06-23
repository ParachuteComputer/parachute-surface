import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { VaultClient } from "./client";
import {
  isSubscribableParams,
  reconcileRemove,
  reconcileUpsert,
  useLiveNotesQuery,
} from "./live-query";
import type { Note } from "./types";

const note = (id: string, extra: Record<string, unknown> = {}): Note =>
  ({ id, ...extra }) as unknown as Note;

describe("reconcileUpsert", () => {
  it("replaces a row in place by id, leaving the input untouched (pure)", () => {
    const list = [note("a", { content: "1" }), note("b")];
    const next = reconcileUpsert(list, note("a", { content: "2" }));
    expect(next.map((n) => n.id)).toEqual(["a", "b"]);
    expect((next[0] as unknown as { content: string }).content).toBe("2");
    expect((list[0] as unknown as { content: string }).content).toBe("1");
  });
  it("prepends a new row", () => {
    expect(reconcileUpsert([note("a")], note("z")).map((n) => n.id)).toEqual(["z", "a"]);
  });
});

describe("reconcileRemove", () => {
  it("drops by id", () => {
    expect(reconcileRemove([note("a"), note("b")], "a").map((n) => n.id)).toEqual(["b"]);
  });
  it("is idempotent — returns the same ref when the id is absent", () => {
    const l = [note("a")];
    expect(reconcileRemove(l, "x")).toBe(l);
  });
});

describe("isSubscribableParams", () => {
  it("true for tag/path queries", () => {
    expect(isSubscribableParams(new URLSearchParams("tag=%23x"))).toBe(true);
  });
  it("false for search / near / cursor (unsubscribable)", () => {
    expect(isSubscribableParams(new URLSearchParams("search=foo"))).toBe(false);
    expect(isSubscribableParams(new URLSearchParams("cursor=abc"))).toBe(false);
  });
});

function makeClient() {
  const ref: { handlers: Record<string, (arg: unknown) => void> | null } = { handlers: null };
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_p: URLSearchParams, h: Record<string, (arg: unknown) => void>) => {
    ref.handlers = h;
    return unsubscribe;
  });
  return { client: { subscribe } as unknown as VaultClient, ref, unsubscribe, subscribe };
}

const KEY = ["notes", "v", {}];

function setup(params: URLSearchParams, client: VaultClient | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => useLiveNotesQuery({ queryKey: KEY, params, client }), { wrapper });
  return { qc, ...rendered };
}

describe("useLiveNotesQuery", () => {
  it("subscribes, seeds cache on snapshot, reconciles upsert/remove, tracks isLive", () => {
    const m = makeClient();
    const { qc, result } = setup(new URLSearchParams("tag=%23x"), m.client);
    expect(m.subscribe).toHaveBeenCalledOnce();
    expect(result.current.isLive).toBe(false); // not live until status:open

    act(() => m.ref.handlers!.onStatus("open" as unknown as never));
    expect(result.current.isLive).toBe(true);

    act(() => m.ref.handlers!.onSnapshot([note("a"), note("b")] as unknown as never));
    expect(qc.getQueryData<Note[]>(KEY)?.map((n) => n.id)).toEqual(["a", "b"]);

    act(() => m.ref.handlers!.onUpsert(note("c") as unknown as never));
    expect(qc.getQueryData<Note[]>(KEY)?.map((n) => n.id)).toEqual(["c", "a", "b"]);

    act(() => m.ref.handlers!.onRemove("a" as unknown as never));
    expect(qc.getQueryData<Note[]>(KEY)?.map((n) => n.id)).toEqual(["c", "b"]);

    act(() => m.ref.handlers!.onStatus("closed" as unknown as never));
    expect(result.current.isLive).toBe(false); // closed → fall back to polling
  });

  it("does NOT subscribe for an unsubscribable query — stays on polling", () => {
    const m = makeClient();
    const { result } = setup(new URLSearchParams("search=foo"), m.client);
    expect(m.subscribe).not.toHaveBeenCalled();
    expect(result.current.isLive).toBe(false);
  });

  it("is inert with no client", () => {
    const m = makeClient();
    const { result } = setup(new URLSearchParams("tag=%23x"), null);
    expect(m.subscribe).not.toHaveBeenCalled();
    expect(result.current.isLive).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const m = makeClient();
    const { unmount } = setup(new URLSearchParams("tag=%23x"), m.client);
    unmount();
    expect(m.unsubscribe).toHaveBeenCalled();
  });

  it("a transient error never clears the cache (fallback guarantee)", () => {
    const m = makeClient();
    const { qc } = setup(new URLSearchParams("tag=%23x"), m.client);
    act(() => m.ref.handlers!.onSnapshot([note("a")] as unknown as never));
    act(() => m.ref.handlers!.onError(new Error("blip") as unknown as never));
    expect(qc.getQueryData<Note[]>(KEY)?.map((n) => n.id)).toEqual(["a"]); // unchanged
  });
});
