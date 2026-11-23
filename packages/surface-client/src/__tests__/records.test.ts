/**
 * Record words (records.ts): what goes on the wire for each record call, and
 * what comes back renamed. An app and a Parachute applet written against
 * queryRecords / getRecord / createRecord / updateRecord read alike.
 */
import { describe, expect, test } from "bun:test";

import { VaultClient, VaultConflictError } from "../vault-client.js";

type Seen = { url: string; method: string; body: unknown };
function client(answer: (s: Seen) => unknown, status = 200) {
  const seen: Seen[] = [];
  const c = new VaultClient({
    vaultUrl: "http://vault.test",
    accessToken: "t",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const s = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      seen.push(s);
      return new Response(JSON.stringify(answer(s)), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { c, seen };
}
const NOTE = {
  id: "n1",
  path: "Books/Dune",
  createdAt: "2026-11-01T00:00:00Z",
  content: "# Dune",
  metadata: { rating: 5 },
  tags: ["book"],
  links: [
    {
      sourceId: "n1",
      targetId: "n2",
      relationship: "mentions",
      metadata: { weight: 2 },
      targetNote: { id: "n2", path: "Books/Arrakis", metadata: { kind: "place" } },
    },
  ],
};

describe("record words", () => {
  test("queryRecords: record words on the wire as the notes route's, records back", async () => {
    const { c, seen } = client(() => [NOTE]);
    const rows = await c.queryRecords({
      pathPrefix: "Books/",
      includeBody: true,
      includeFields: true,
      fields: { rating: { gte: 4 } },
      orderBy: "rating",
      sort: "desc",
      offset: 50,
      limit: 50,
      search: "spice",
    });
    const q = new URL(seen[0]!.url).searchParams;
    expect(new URL(seen[0]!.url).pathname).toBe("/api/notes");
    expect(q.get("path_prefix")).toBe("Books/");
    expect(q.get("include_content")).toBe("true");
    expect(q.get("include_metadata")).toBe("true");
    expect(q.get("meta[rating][gte]")).toBe("4");
    expect(q.get("order_by")).toBe("rating");
    expect(q.get("sort")).toBe("desc");
    expect(q.get("offset")).toBe("50");
    expect(q.get("search")).toBe("spice");
    // no camelCase leaks through as a raw param
    expect([...q.keys()].some((k) => /[A-Z]/.test(k))).toBe(false);
    expect(rows[0]!).toMatchObject({ id: "n1", body: "# Dune", fields: { rating: 5 } });
    expect(rows[0]!).not.toHaveProperty("content");
    expect(rows[0]!).not.toHaveProperty("metadata");
    // a link's own data, and its ends, in record words too
    expect(rows[0]!.links?.[0]).toMatchObject({ fields: { weight: 2 } });
    expect(rows[0]!.links?.[0]).not.toHaveProperty("metadata");
    expect(rows[0]!.links?.[0]?.targetNote).toEqual({
      id: "n2",
      path: "Books/Arrakis",
      fields: { kind: "place" },
    });
  });

  test("getRecord: by path, with its body and links when asked; null when there is none", async () => {
    const { c, seen } = client(() => [NOTE]);
    const r = await c.getRecord("Books/Dune", { includeLinks: true });
    const q = new URL(seen[0]!.url).searchParams;
    expect(q.get("id")).toBe("Books/Dune");
    expect(q.get("include_links")).toBe("true");
    expect(r?.body).toBe("# Dune");
    expect(await client(() => []).c.getRecord("gone")).toBeNull();
    // a hub answers a missing ?id= with a 404: still null, as an applet's getRecord answers
    expect(await client(() => ({ error: "not_found" }), 404).c.getRecord("gone")).toBeNull();
  });

  test("createRecord and updateRecord send body and fields as content and metadata", async () => {
    const { c, seen } = client((s) => ({
      ...NOTE,
      content: undefined,
      ...(s.method === "PATCH" ? { metadata: { rating: 4 } } : {}),
    }));
    const made = await c.createRecord({
      path: "Books/Dune",
      body: "# Dune",
      fields: { rating: 5 },
      tags: ["book"],
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      body: { path: "Books/Dune", content: "# Dune", metadata: { rating: 5 }, tags: ["book"] },
    });
    expect(seen[0]!.body).not.toHaveProperty("body");
    expect(made.fields).toEqual({ rating: 5 });
    const changed = await c.updateRecord("n1", {
      if_updated_at: "2026-11-01T00:00:00Z",
      fields: { rating: 4 },
    });
    expect(seen[1]).toMatchObject({
      method: "PATCH",
      body: { if_updated_at: "2026-11-01T00:00:00Z", metadata: { rating: 4 } },
    });
    expect(seen[1]!.body).not.toHaveProperty("content");
    expect(changed.fields).toEqual({ rating: 4 });
  });

  test("a change to a record someone else changed still rejects with VaultConflictError", async () => {
    const { c } = client(() => ({ error: "conflict", current_updated_at: "x" }), 409);
    await expect(c.updateRecord("n1", { if_updated_at: "old", body: "x" })).rejects.toBeInstanceOf(
      VaultConflictError,
    );
  });
});
