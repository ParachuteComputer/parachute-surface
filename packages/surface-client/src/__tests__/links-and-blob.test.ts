/**
 * Tests for R2 commit 3 — typed link payloads + the base-client
 * `fetchAttachmentBlob`.
 *
 *   - `UpdateNotePayload.links` (add with metadata / remove) serializes
 *     onto the PATCH body exactly as vault's handler reads it.
 *   - `CreateNotePayload.links` is the FLAT array vault's POST branch
 *     reads (no add/remove envelope — verified shape difference).
 *   - `fetchAttachmentBlob` on the BASE VaultClient: URL resolution
 *     (bare path / vault-relative / absolute), Authorization header,
 *     refresh-on-401 retry, structured errors. This is the deliberate
 *     fetch-blob seam for surface-render's `vaultClientFetchBlob`
 *     adapter (which prefers `client.fetchAttachmentBlob`) — chosen over
 *     a `getAccessToken` accessor so the token never leaves the client
 *     (keeps R3's ScopedVaultClient no-token contract intact).
 */

import { describe, expect, test } from "bun:test";

import { VaultAuthError, VaultClient, VaultNotFoundError } from "../vault-client.ts";
import type { CreateNotePayload, UpdateNotePayload } from "../vault-types.ts";

type Captured = { url: string; init?: RequestInit };

function clientCapturing(
  calls: Captured[],
  respond: (url: string, init?: RequestInit) => Response = () =>
    new Response(JSON.stringify({ id: "n1", createdAt: "2026-01-01" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  extra: Partial<ConstructorParameters<typeof VaultClient>[0]> = {},
): VaultClient {
  return new VaultClient({
    vaultUrl: "https://hub.example/vault/default",
    accessToken: "tok-1",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch,
    ...extra,
  });
}

describe("typed link payloads", () => {
  test("updateNote carries links.add (with metadata) + links.remove on the PATCH body", async () => {
    const calls: Captured[] = [];
    const payload: UpdateNotePayload = {
      links: {
        add: [
          { target: "Work/target-note", relationship: "drives" },
          { target: "note-id-2", relationship: "affects", metadata: { weight: 2 } },
        ],
        remove: [{ target: "old-note", relationship: "wikilink" }],
      },
      if_updated_at: "2026-06-01T00:00:00Z",
    };
    await clientCapturing(calls).updateNote("n1", payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("PATCH");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.links).toEqual({
      add: [
        { target: "Work/target-note", relationship: "drives" },
        { target: "note-id-2", relationship: "affects", metadata: { weight: 2 } },
      ],
      remove: [{ target: "old-note", relationship: "wikilink" }],
    });
    expect(body.if_updated_at).toBe("2026-06-01T00:00:00Z");
  });

  test("createNote carries the FLAT links array vault's POST branch reads", async () => {
    const calls: Captured[] = [];
    const payload: CreateNotePayload = {
      content: "hello",
      tags: ["#work"],
      links: [{ target: "Work/parent", relationship: "part-of" }],
    };
    await clientCapturing(calls).createNote(payload);
    const body = JSON.parse(calls[0]!.init?.body as string);
    // Flat array — NOT the {add, remove} envelope (POST has nothing to remove).
    expect(body.links).toEqual([{ target: "Work/parent", relationship: "part-of" }]);
  });
});

describe("VaultClient.fetchAttachmentBlob (base client)", () => {
  const BYTES = new Uint8Array([1, 2, 3, 4]);
  const blobResponse = () =>
    new Response(BYTES, { status: 200, headers: { "Content-Type": "image/png" } });

  test("resolves a /api/storage path against the vault base URL with the bearer", async () => {
    const calls: Captured[] = [];
    const blob = await clientCapturing(calls, blobResponse).fetchAttachmentBlob(
      "/api/storage/att/img.png",
    );
    expect(calls[0]!.url).toBe("https://hub.example/vault/default/api/storage/att/img.png");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tok-1");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(BYTES);
  });

  test("resolves a bare relative path (no leading slash)", async () => {
    const calls: Captured[] = [];
    await clientCapturing(calls, blobResponse).fetchAttachmentBlob("api/storage/att/img.png");
    expect(calls[0]!.url).toBe("https://hub.example/vault/default/api/storage/att/img.png");
  });

  test("passes absolute URLs through untouched (still authenticated)", async () => {
    const calls: Captured[] = [];
    await clientCapturing(calls, blobResponse).fetchAttachmentBlob(
      "https://cdn.example/vault/default/api/storage/x.png",
    );
    expect(calls[0]!.url).toBe("https://cdn.example/vault/default/api/storage/x.png");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tok-1");
  });

  test("401 → onAuthError refresh → retried once with the fresh token", async () => {
    const calls: Captured[] = [];
    let refreshes = 0;
    const client = clientCapturing(
      calls,
      (_url, init) =>
        new Headers(init?.headers).get("authorization") === "Bearer tok-2"
          ? blobResponse()
          : new Response(JSON.stringify({ error_type: "expired" }), { status: 401 }),
      {
        onAuthError: async () => {
          refreshes++;
          return "tok-2";
        },
      },
    );
    const blob = await client.fetchAttachmentBlob("/api/storage/a.png");
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer tok-2");
    expect(blob.size).toBe(BYTES.length);
  });

  test("unrecoverable 401 throws VaultAuthError with the structured error_type", async () => {
    const calls: Captured[] = [];
    const client = clientCapturing(
      calls,
      () =>
        new Response(JSON.stringify({ error_type: "insufficient_scope", message: "nope" }), {
          status: 401,
        }),
    );
    expect(client.fetchAttachmentBlob("/api/storage/a.png")).rejects.toThrow(VaultAuthError);
  });

  test("404 throws VaultNotFoundError", async () => {
    const calls: Captured[] = [];
    const client = clientCapturing(calls, () => new Response("missing", { status: 404 }));
    expect(client.fetchAttachmentBlob("/api/storage/gone.png")).rejects.toThrow(
      VaultNotFoundError,
    );
  });

  test("satisfies surface-render's BlobCapableClient preferred shape", () => {
    // The adapter contract: `fetchAttachmentBlob?: (url: string) => Promise<Blob>`.
    // Pin that the base client now structurally provides it, so
    // `vaultClientFetchBlob(client)` takes the preferred branch with no
    // token accessor needed.
    const client = clientCapturing([]);
    expect(typeof client.fetchAttachmentBlob).toBe("function");
    const shaped: { fetchAttachmentBlob?: (url: string) => Promise<Blob> } = client;
    expect(shaped.fetchAttachmentBlob).toBeDefined();
    // And the token deliberately does NOT leak via an accessor.
    expect((client as Record<string, unknown>).getAccessToken).toBeUndefined();
  });
});
