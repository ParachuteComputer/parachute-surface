// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultClient } from "./client";
import { NOTES_REQUIRED_SCHEMA } from "./schema";
import { _resetEnsuredVaultsForTesting, ensureNotesSchema } from "./schema-ensure";

const CAPTURE_DECL = NOTES_REQUIRED_SCHEMA.tags[0]!;

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

// Routes the two endpoints the lazy-ensure touches: the audit's
// `GET /api/tags?include_schema=true` (answered with `tagRows`) and the
// apply path's `PUT /api/tags/:name` (204). Every call is recorded.
function makeClient(opts: {
  tagRows?: unknown[] | (() => unknown[]);
  failList?: boolean;
  failPut?: boolean;
  calls?: RecordedCall[];
}): VaultClient {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    opts.calls?.push({
      method,
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (method === "GET" && url.includes("/api/tags")) {
      if (opts.failList) return new Response("boom", { status: 500 });
      const rows = typeof opts.tagRows === "function" ? opts.tagRows() : (opts.tagRows ?? []);
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "PUT") {
      if (opts.failPut) return new Response("boom", { status: 500 });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  });
  return new VaultClient({
    vaultUrl: "http://localhost:1940",
    accessToken: "tok_test",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function captureRow(overrides: Record<string, unknown> = {}) {
  return {
    name: CAPTURE_DECL.name,
    count: 0,
    description: CAPTURE_DECL.description,
    parent_names: null,
    ...overrides,
  };
}

describe("ensureNotesSchema (quiet lazy-ensure)", () => {
  beforeEach(() => {
    _resetEnsuredVaultsForTesting();
  });
  afterEach(() => {
    _resetEnsuredVaultsForTesting();
  });

  it("creates the `capture` tag when the vault lacks it", async () => {
    const calls: RecordedCall[] = [];
    const client = makeClient({ tagRows: [], calls });

    await ensureNotesSchema("v1", client);

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(
      `http://localhost:1940/api/tags/${encodeURIComponent(CAPTURE_DECL.name)}`,
    );
    expect(puts[0]!.body).toMatchObject({ description: CAPTURE_DECL.description });
    // The declared tag has no parents — the payload must not invent any.
    expect(puts[0]!.body).not.toHaveProperty("parent_names");
  });

  it("leaves an existing tag row alone — even when its description differs", async () => {
    // Once the row exists it belongs to the operator; a customized
    // description must never be clobbered back to the declared text.
    const calls: RecordedCall[] = [];
    const client = makeClient({
      tagRows: [captureRow({ description: "my own words about captures" })],
      calls,
    });

    await ensureNotesSchema("v1", client);

    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    // The audit read still happened.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("is idempotent per-session per-vault (second call is a no-op, no network)", async () => {
    const calls: RecordedCall[] = [];
    const client = makeClient({ tagRows: [], calls });

    await ensureNotesSchema("v1", client);
    const after = calls.length;
    expect(after).toBeGreaterThan(0);

    await ensureNotesSchema("v1", client);
    expect(calls.length).toBe(after);
  });

  it("tracks vaults independently — ensures per-vault separately", async () => {
    const calls: RecordedCall[] = [];
    const client = makeClient({ tagRows: [], calls });

    await ensureNotesSchema("v1", client);
    await ensureNotesSchema("v2", client);

    // 2 vaults × (1 audit GET + 1 create PUT) each.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("rolls back the guard when the audit read fails, so the next capture retries", async () => {
    const calls: RecordedCall[] = [];
    let fail = true;
    const client = makeClient({
      tagRows: () => {
        if (fail) throw Object.assign(new Error("boom"), { synthetic: true });
        return [];
      },
      calls,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureNotesSchema("v1", client)).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    fail = false;
    await ensureNotesSchema("v1", client);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it("rolls back the guard when the create write fails, so the next capture retries", async () => {
    const calls: RecordedCall[] = [];
    const client = makeClient({ tagRows: [], failPut: true, calls });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureNotesSchema("v1", client)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    // Retry allowed — the guard was rolled back.
    const okClient = makeClient({ tagRows: [], calls });
    await ensureNotesSchema("v1", okClient);
    const puts = calls.filter((c) => c.method === "PUT");
    // One failed PUT from the first attempt + one successful from the retry.
    expect(puts).toHaveLength(2);

    warnSpy.mockRestore();
  });

  it("swallows failures (never throws to the capture path)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = new VaultClient({
      vaultUrl: "http://localhost:1940",
      accessToken: "tok_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureNotesSchema("v1", client)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
