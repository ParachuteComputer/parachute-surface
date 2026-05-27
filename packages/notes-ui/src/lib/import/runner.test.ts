import { type VaultClient, VaultConflictError, VaultUnreachableError } from "@/lib/vault/client";
import { describe, expect, it, vi } from "vitest";
import { runImport } from "./runner";
import type { ParsedNote } from "./types";

function makeNote(overrides: Partial<ParsedNote> = {}): ParsedNote {
  return {
    sourcePath: "x.md",
    path: "x",
    content: "body",
    tags: [],
    metadata: {},
    ...overrides,
  };
}

/**
 * Build a mock VaultClient whose `createNote` returns / throws on demand.
 * We don't go through `new VaultClient({...})` here because constructing
 * one requires a token + URL + the full options shape; the runner only
 * touches `createNote`, so a typed-cast stub is the leanest fixture.
 */
function makeClient(createNote: (i: number) => Promise<{ id: string }>): VaultClient {
  let call = 0;
  return {
    createNote: vi.fn(async () => {
      const i = call++;
      return createNote(i);
    }),
  } as unknown as VaultClient;
}

describe("runImport", () => {
  it("creates every note when the vault returns 201 each time", async () => {
    const client = makeClient(async (i) => ({ id: `id-${i}` }));
    const notes = [makeNote({ path: "a" }), makeNote({ path: "b" }), makeNote({ path: "c" })];
    const report = await runImport({ client, notes });
    expect(report.created).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.outcomes.map((o) => o.status)).toEqual(["created", "created", "created"]);
  });

  it("classifies 409 conflicts as skipped (not errored)", async () => {
    const client = makeClient(async (i) => {
      if (i === 1) throw new VaultConflictError({ message: "path already used" });
      return { id: `id-${i}` };
    });
    const notes = [makeNote({ path: "a" }), makeNote({ path: "b" }), makeNote({ path: "c" })];
    const report = await runImport({ client, notes, concurrency: 1 });
    expect(report.created).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.errored).toBe(0);
    const skipped = report.outcomes.find((o) => o.status === "skipped");
    expect(skipped?.sourcePath).toBe("x.md"); // every note shares sourcePath in this fixture
  });

  it("retries once on 5xx (unreachable), then surfaces the failure", async () => {
    // First call to createNote 5xx'es, second succeeds.
    let attempts = 0;
    const client = {
      createNote: vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new VaultUnreachableError("HTTP 503", 503);
        return { id: "id-retry" };
      }),
    } as unknown as VaultClient;
    const report = await runImport({ client, notes: [makeNote()], concurrency: 1 });
    expect(attempts).toBe(2); // initial + 1 retry
    expect(report.created).toBe(1);
    expect(report.errored).toBe(0);
  });

  it("gives up after one retry and marks the note errored", async () => {
    const client = {
      createNote: vi.fn(async () => {
        throw new VaultUnreachableError("HTTP 503", 503);
      }),
    } as unknown as VaultClient;
    const report = await runImport({ client, notes: [makeNote()], concurrency: 1 });
    expect(report.errored).toBe(1);
    expect((client.createNote as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(report.outcomes[0]?.status).toBe("errored");
    if (report.outcomes[0]?.status === "errored") {
      expect(report.outcomes[0].reason).toContain("vault unreachable");
    }
  });

  it("continues past individual errors (partial success > all-or-nothing)", async () => {
    const client = makeClient(async (i) => {
      if (i === 0) throw new Error("validation failed");
      if (i === 2) throw new VaultConflictError({ message: "dup" });
      return { id: `id-${i}` };
    });
    const notes = [
      makeNote({ path: "a", sourcePath: "a.md" }),
      makeNote({ path: "b", sourcePath: "b.md" }),
      makeNote({ path: "c", sourcePath: "c.md" }),
      makeNote({ path: "d", sourcePath: "d.md" }),
    ];
    const report = await runImport({ client, notes, concurrency: 1 });
    expect(report.created).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.errored).toBe(1);
  });

  it("calls onProgress after each note (any outcome)", async () => {
    const client = makeClient(async (i) => ({ id: `id-${i}` }));
    const notes = [makeNote(), makeNote(), makeNote()];
    const onProgress = vi.fn();
    await runImport({ client, notes, onProgress, concurrency: 1 });
    expect(onProgress).toHaveBeenCalledTimes(3);
    // Last call is { done: 3, total: 3 }.
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual({ done: 3, total: 3 });
  });

  it("respects an abort signal — finishes in-flight, skips the rest", async () => {
    const ctrl = new AbortController();
    let started = 0;
    const client = {
      createNote: vi.fn(async () => {
        started++;
        if (started === 1) {
          ctrl.abort();
          return { id: "id-0" };
        }
        return { id: `id-${started}` };
      }),
    } as unknown as VaultClient;
    const notes = [
      makeNote({ sourcePath: "a.md" }),
      makeNote({ sourcePath: "b.md" }),
      makeNote({ sourcePath: "c.md" }),
    ];
    const report = await runImport({ client, notes, concurrency: 1, signal: ctrl.signal });
    // First completed before abort; remaining flushed as errored.
    expect(report.created).toBe(1);
    expect(report.errored).toBe(2);
    expect(report.outcomes[1]?.status).toBe("errored");
    if (report.outcomes[1]?.status === "errored") {
      expect(report.outcomes[1].reason).toContain("cancelled");
    }
  });

  it("sends id + created_at on the wire when frontmatter declared them", async () => {
    // Capture the payload to assert id passthrough — this is the load-bearing
    // contract with vault (it reads `item.id` / `item.created_at` directly).
    const captured: unknown[] = [];
    const client = {
      createNote: vi.fn(async (payload: unknown) => {
        captured.push(payload);
        return { id: "server-id" };
      }),
    } as unknown as VaultClient;
    const notes = [
      makeNote({
        path: "x",
        id: "user-id-abc",
        createdAt: "2024-05-01T10:00:00Z",
      }),
    ];
    await runImport({ client, notes });
    expect(captured[0]).toMatchObject({
      content: "body",
      path: "x",
      id: "user-id-abc",
      created_at: "2024-05-01T10:00:00Z",
    });
  });
});
