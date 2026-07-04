import {
  DEFAULT_AUDIO_RETENTION,
  clearRetentionChoice,
  loadRetentionChoiceMade,
  markRetentionChoiceMade,
  useAudioRetention,
  useSetAudioRetention,
} from "@/lib/vault/audio-retention";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-vault "choice made" flag (localStorage, `lens:path-tree:` pattern)
// ---------------------------------------------------------------------------

describe("audio-retention choice flag storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to not-made", () => {
    expect(loadRetentionChoiceMade("v1")).toBe(false);
  });

  it("round-trips mark → made", () => {
    markRetentionChoiceMade("v1");
    expect(loadRetentionChoiceMade("v1")).toBe(true);
  });

  it("scopes the flag by vaultId", () => {
    markRetentionChoiceMade("v1");
    expect(loadRetentionChoiceMade("v1")).toBe(true);
    expect(loadRetentionChoiceMade("v2")).toBe(false);
  });

  it("clear removes the flag", () => {
    markRetentionChoiceMade("v1");
    clearRetentionChoice("v1");
    expect(loadRetentionChoiceMade("v1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hooks — read piggybacks the cached /api/vault; write verifies the echo
// ---------------------------------------------------------------------------

function seedStore() {
  useVaultStore.setState({
    vaults: {
      dev: {
        id: "dev",
        url: "http://localhost:1940",
        name: "dev",
        issuer: "http://localhost:1940",
        clientId: "client-test",
        scope: "full",
        addedAt: "2026-04-18T00:00:00.000Z",
        lastUsedAt: "2026-04-18T00:00:00.000Z",
      },
    },
    activeVaultId: "dev",
  });
  localStorage.setItem(
    "lens:token:dev",
    JSON.stringify({ accessToken: "pvt_abc", scope: "full", vault: "default" }),
  );
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function stubVaultFetch(opts: {
  getBody: unknown;
  patch?: { status?: number; body: unknown };
}) {
  const patchCalls: unknown[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/vault") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => opts.getBody,
        text: async () => "",
      } as Response;
    }
    if (url.includes("/api/vault") && method === "PATCH") {
      patchCalls.push(JSON.parse(String(init?.body)));
      const status = opts.patch?.status ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => opts.patch?.body ?? null,
        text: async () => "",
      } as Response;
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, patchCalls };
}

describe("useAudioRetention / useSetAudioRetention", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("reads the value from /api/vault's config block (supported)", async () => {
    stubVaultFetch({
      getBody: {
        name: "dev",
        description: "",
        config: { audio_retention: "until_transcribed", auto_transcribe: { enabled: true } },
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result } = renderHook(() => useAudioRetention(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.value).toBe("until_transcribed");
    expect(result.current.supported).toBe(true);
  });

  it("absent config (older vault) → keep, unsupported (back-compat)", async () => {
    stubVaultFetch({ getBody: { name: "dev", description: "" } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result } = renderHook(() => useAudioRetention(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.value).toBe(DEFAULT_AUDIO_RETENTION);
    expect(result.current.supported).toBe(false);
  });

  it("PATCH sends { config: { audio_retention } } and merges the echo into the cached vaultInfo", async () => {
    const { patchCalls } = stubVaultFetch({
      getBody: {
        name: "dev",
        description: "",
        transcription: { enabled: true, provider: "scribe-http" },
        config: { audio_retention: "keep", auto_transcribe: { enabled: true } },
      },
      patch: {
        body: {
          name: "dev",
          description: null,
          config: { audio_retention: "never", auto_transcribe: { enabled: true } },
        },
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = makeWrapper(qc);
    const read = renderHook(() => useAudioRetention(), { wrapper });
    await waitFor(() => expect(read.result.current.isLoading).toBe(false));
    expect(read.result.current.value).toBe("keep");

    const write = renderHook(() => useSetAudioRetention(), { wrapper });
    await write.result.current.mutateAsync("never");

    expect(patchCalls).toEqual([{ config: { audio_retention: "never" } }]);
    // Cache MERGED, not replaced: the new value lands while the fields the
    // PATCH response doesn't carry (transcription) survive.
    await waitFor(() => expect(read.result.current.value).toBe("never"));
    const cached = qc.getQueryData<{ transcription?: unknown }>(["vaultInfo", "dev"]);
    expect(cached?.transcription).toEqual({ enabled: true, provider: "scribe-http" });
  });

  it("old-vault accept-and-ignore (200 without echo) surfaces as an error, never a phantom success", async () => {
    stubVaultFetch({
      getBody: { name: "dev", description: "" },
      // Old handler: 200, but the response has no config block at all.
      patch: { body: { name: "dev", description: null } },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const write = renderHook(() => useSetAudioRetention(), { wrapper: makeWrapper(qc) });

    await expect(write.result.current.mutateAsync("until_transcribed")).rejects.toThrow(
      /doesn't support/i,
    );
  });
});
