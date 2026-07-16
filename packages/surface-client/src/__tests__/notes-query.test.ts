/**
 * Wire-format pins for the typed notes-query builder. Every `NotesQuery`
 * field must serialize to the EXACT param string vault's
 * `parseNotesQueryOpts` (`parachute-vault/src/routes.ts`) parses — these
 * tests pin against literal query strings, not round-trip identities.
 *
 * Grammar facts being pinned (verified against the vault parser source):
 *   - `tag` / `exclude_tag`: vault reads ONE param and splits on commas
 *     (`parseQueryList` uses `.get`, not `.getAll`) → comma-joined.
 *   - `extension`: vault `getAll`s + flattens commas → repeated params.
 *   - metadata scalar → `meta[field]=v` shorthand; ops → `meta[field][op]=v`
 *     brackets; in/not_in → the `[]` array form.
 *   - date → the canonical `meta[<col>][gte]` / `meta[<col>][lt]` bridge
 *     (flat date_field/date_from/date_to is deprecated, never emitted).
 */

import { describe, expect, test } from "bun:test";

import {
  buildNotesQuery,
  isNotesQuery,
  toNotesSearchParams,
  type NotesQuery,
} from "../notes-query.ts";
import { VaultClient } from "../vault-client.ts";

function wire(q: NotesQuery): string {
  return buildNotesQuery(q).toString();
}

describe("buildNotesQuery — exact wire format", () => {
  test("tag: single", () => {
    expect(wire({ tag: "#work" })).toBe("tag=%23work");
  });

  test("tag: array comma-joins into ONE param (vault reads only the first tag param)", () => {
    const params = buildNotesQuery({ tag: ["#work", "#decision"] });
    expect(params.getAll("tag")).toEqual(["#work,#decision"]);
    expect(params.toString()).toBe("tag=%23work%2C%23decision");
  });

  test("tagMatch → tag_match", () => {
    expect(wire({ tag: ["a", "b"], tagMatch: "all" })).toBe("tag=a%2Cb&tag_match=all");
  });

  test("expand", () => {
    expect(wire({ tag: "a", expand: "exact" })).toBe("tag=a&expand=exact");
    expect(wire({ tag: "a", expand: "namespace" })).toBe("tag=a&expand=namespace");
  });

  test("excludeTag → exclude_tag (comma grammar, same as tag)", () => {
    expect(wire({ excludeTag: "#archived" })).toBe("exclude_tag=%23archived");
    expect(wire({ excludeTag: ["#a", "#b"] })).toBe("exclude_tag=%23a%2C%23b");
  });

  test("hasTags / hasLinks → has_tags / has_links booleans", () => {
    expect(wire({ hasTags: true })).toBe("has_tags=true");
    expect(wire({ hasTags: false })).toBe("has_tags=false");
    expect(wire({ hasLinks: true })).toBe("has_links=true");
  });

  test("path / pathPrefix → path / path_prefix", () => {
    expect(wire({ path: "Current/Parachute" })).toBe("path=Current%2FParachute");
    expect(wire({ pathPrefix: "Work/" })).toBe("path_prefix=Work%2F");
  });

  test("extension: repeated params (vault getAlls this one)", () => {
    expect(wire({ extension: "csv" })).toBe("extension=csv");
    const params = buildNotesQuery({ extension: ["csv", "yaml"] });
    expect(params.getAll("extension")).toEqual(["csv", "yaml"]);
    expect(params.toString()).toBe("extension=csv&extension=yaml");
  });

  test("metadata scalar → shorthand meta[field]=value", () => {
    expect(wire({ metadata: { status: "open" } })).toBe("meta%5Bstatus%5D=open");
    expect(buildNotesQuery({ metadata: { status: "open" } }).get("meta[status]")).toBe("open");
  });

  test("metadata scalar: numbers and booleans stringify", () => {
    const params = buildNotesQuery({ metadata: { priority: 2, done: false } });
    expect(params.get("meta[priority]")).toBe("2");
    expect(params.get("meta[done]")).toBe("false");
  });

  test("metadata operator object → meta[field][op]=value brackets", () => {
    const params = buildNotesQuery({
      metadata: { status: { eq: "in-progress" }, score: { gte: 3, lt: 10 } },
    });
    expect(params.get("meta[status][eq]")).toBe("in-progress");
    expect(params.get("meta[score][gte]")).toBe("3");
    expect(params.get("meta[score][lt]")).toBe("10");
  });

  test("every single-value operator serializes", () => {
    const params = buildNotesQuery({
      metadata: {
        a: { eq: "1" },
        b: { ne: "2" },
        c: { gt: 3 },
        d: { gte: 4 },
        e: { lt: 5 },
        f: { lte: 6 },
      },
    });
    expect(params.get("meta[a][eq]")).toBe("1");
    expect(params.get("meta[b][ne]")).toBe("2");
    expect(params.get("meta[c][gt]")).toBe("3");
    expect(params.get("meta[d][gte]")).toBe("4");
    expect(params.get("meta[e][lt]")).toBe("5");
    expect(params.get("meta[f][lte]")).toBe("6");
  });

  test("in / not_in → []-array form (comma-bearing values survive)", () => {
    const params = buildNotesQuery({
      metadata: { kind: { in: ["bug", "feat,ure"] }, status: { not_in: ["done"] } },
    });
    expect(params.getAll("meta[kind][in][]")).toEqual(["bug", "feat,ure"]);
    expect(params.getAll("meta[status][not_in][]")).toEqual(["done"]);
  });

  test("exists → meta[field][exists]=true|false", () => {
    expect(buildNotesQuery({ metadata: { due: { exists: true } } }).get("meta[due][exists]")).toBe(
      "true",
    );
    expect(
      buildNotesQuery({ metadata: { due: { exists: false } } }).get("meta[due][exists]"),
    ).toBe("false");
  });

  test("in/not_in with a non-array throws loudly", () => {
    expect(() =>
      buildNotesQuery({ metadata: { kind: { in: "bug" as unknown as string[] } } }),
    ).toThrow(/requires an array/);
  });

  test("date → canonical meta[<col>][gte]/[lt] bridge (never flat date_* params)", () => {
    const params = buildNotesQuery({
      date: { field: "updated_at", from: "2026-06-01", to: "2026-06-08" },
    });
    expect(params.get("meta[updated_at][gte]")).toBe("2026-06-01");
    expect(params.get("meta[updated_at][lt]")).toBe("2026-06-08");
    expect(params.get("date_field")).toBeNull();
    expect(params.get("date_from")).toBeNull();
    expect(params.get("date_to")).toBeNull();
  });

  test("date: open-ended bounds", () => {
    expect(wire({ date: { field: "created_at", from: "2026-01-01" } })).toBe(
      "meta%5Bcreated_at%5D%5Bgte%5D=2026-01-01",
    );
    expect(wire({ date: { field: "created_at", to: "2026-02-01" } })).toBe(
      "meta%5Bcreated_at%5D%5Blt%5D=2026-02-01",
    );
  });

  test("orderBy / sort / limit / offset", () => {
    expect(wire({ orderBy: "updated_at", sort: "desc", limit: 20, offset: 40 })).toBe(
      "order_by=updated_at&sort=desc&limit=20&offset=40",
    );
  });

  test("include_* flags + link_count_direction", () => {
    const params = buildNotesQuery({
      includeContent: true,
      includeLinks: true,
      includeAttachments: false,
      includeLinkCount: true,
      linkCountDirection: "outbound",
    });
    expect(params.get("include_content")).toBe("true");
    expect(params.get("include_links")).toBe("true");
    expect(params.get("include_attachments")).toBe("false");
    expect(params.get("include_link_count")).toBe("true");
    expect(params.get("link_count_direction")).toBe("outbound");
  });

  test("includeMetadata: boolean and field-list forms", () => {
    expect(buildNotesQuery({ includeMetadata: false }).get("include_metadata")).toBe("false");
    expect(
      buildNotesQuery({ includeMetadata: ["summary", "status"] }).get("include_metadata"),
    ).toBe("summary,status");
  });

  test("unknown string keys pass through verbatim (escape hatch)", () => {
    const params = buildNotesQuery({
      tag: "#x",
      "meta[weird][eq]": "raw",
      search: "full text",
    } as NotesQuery);
    expect(params.get("tag")).toBe("#x");
    expect(params.get("meta[weird][eq]")).toBe("raw");
    expect(params.get("search")).toBe("full text");
  });

  test("unknown non-string keys throw", () => {
    expect(() => buildNotesQuery({ bogus: 42 } as unknown as NotesQuery)).toThrow(/unknown key/);
  });

  test("the kitchen sink — full deterministic wire string", () => {
    const params = buildNotesQuery({
      tag: ["#work", "#repo/parachute-surface"],
      tagMatch: "all",
      expand: "subtypes",
      excludeTag: "#archived",
      pathPrefix: "Work/",
      metadata: { status: { in: ["in-progress", "in-review"] }, priority: "now" },
      date: { field: "updated_at", from: "2026-06-01" },
      orderBy: "updated_at",
      sort: "desc",
      limit: 50,
    });
    expect(params.toString()).toBe(
      new URLSearchParams([
        ["tag", "#work,#repo/parachute-surface"],
        ["tag_match", "all"],
        ["expand", "subtypes"],
        ["exclude_tag", "#archived"],
        ["path_prefix", "Work/"],
        ["meta[status][in][]", "in-progress"],
        ["meta[status][in][]", "in-review"],
        ["meta[priority]", "now"],
        ["meta[updated_at][gte]", "2026-06-01"],
        ["order_by", "updated_at"],
        ["sort", "desc"],
        ["limit", "50"],
      ]).toString(),
    );
  });
});

describe("isNotesQuery / toNotesSearchParams — input classification", () => {
  test("URLSearchParams is raw (and is copied, not mutated)", () => {
    const original = new URLSearchParams({ tag: "#x" });
    const out = toNotesSearchParams(original);
    out.set("cursor", "c");
    expect(original.get("cursor")).toBeNull();
    expect(out.get("tag")).toBe("#x");
  });

  test("all-string records without typed-only keys stay raw wire params", () => {
    const raw = { tag: "#x", tag_match: "all", "meta[status][eq]": "open", limit: "5" };
    expect(isNotesQuery(raw)).toBe(false);
    const out = toNotesSearchParams(raw);
    expect(out.get("tag_match")).toBe("all");
    expect(out.get("meta[status][eq]")).toBe("open");
  });

  test("the metadata= JSON alias survives as a raw record (string-valued)", () => {
    const raw = { metadata: '{"status":{"eq":"open"}}' };
    expect(isNotesQuery(raw)).toBe(false);
    expect(toNotesSearchParams(raw).get("metadata")).toBe('{"status":{"eq":"open"}}');
  });

  test("any non-string value classifies as NotesQuery", () => {
    expect(isNotesQuery({ tag: ["a", "b"] })).toBe(true);
    expect(isNotesQuery({ limit: 5 })).toBe(true);
    expect(isNotesQuery({ metadata: { s: "x" } })).toBe(true);
  });

  test("typed-only keys classify all-string objects as NotesQuery", () => {
    expect(isNotesQuery({ tagMatch: "all" })).toBe(true);
    expect(isNotesQuery({ pathPrefix: "Work/" })).toBe(true);
    expect(isNotesQuery({ orderBy: "updated_at" })).toBe(true);
    const out = toNotesSearchParams({ tagMatch: "all", tag: "#x" });
    expect(out.get("tag_match")).toBe("all");
    expect(out.get("tagMatch")).toBeNull();
  });

  test("overlapping string keys serialize identically under either interpretation", () => {
    for (const obj of [
      { tag: "#x" },
      { path: "a/b" },
      { expand: "exact" },
      { sort: "desc" },
    ] as Record<string, string>[]) {
      const asRaw = new URLSearchParams(obj).toString();
      const asTyped = buildNotesQuery(obj as NotesQuery).toString();
      expect(asTyped).toBe(asRaw);
    }
  });
});

describe("VaultClient query methods accept NotesQuery", () => {
  function clientCapturing(urls: string[]): VaultClient {
    return new VaultClient({
      vaultUrl: "https://hub.example/vault/default",
      accessToken: "t",
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
  }

  test("queryNotes serializes a NotesQuery onto the request URL", async () => {
    const urls: string[] = [];
    await clientCapturing(urls).queryNotes({
      tag: ["#work"],
      metadata: { status: { eq: "open" } },
      limit: 5,
    });
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/vault/default/api/notes");
    expect(url.searchParams.get("tag")).toBe("#work");
    expect(url.searchParams.get("meta[status][eq]")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  test("queryNotes raw Record stays byte-compatible (back-compat)", async () => {
    const urls: string[] = [];
    await clientCapturing(urls).queryNotes({ tag: "#x", "meta[a][eq]": "1" });
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("tag")).toBe("#x");
    expect(url.searchParams.get("meta[a][eq]")).toBe("1");
  });

  test("queryNotesCursor merges cursor + limit onto a NotesQuery", async () => {
    const urls: string[] = [];
    // `sort` is omitted here (defaults to ascending) — `sort: "desc"`
    // alongside `cursor` is mutually exclusive per the wire contract and is
    // rejected client-side (see vault-client.test.ts's guard tests).
    await clientCapturing(urls).queryNotesCursor({ tag: "#x" }, "CURSOR123", 10);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("tag")).toBe("#x");
    expect(url.searchParams.get("cursor")).toBe("CURSOR123");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  test("subscribe accepts a NotesQuery and applies the same validation", () => {
    const c = new VaultClient({ vaultUrl: "http://localhost:9", accessToken: "t" });
    const handlers = { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} };
    // search via the raw escape hatch must still be rejected.
    expect(() => c.subscribe({ search: "x" } as Record<string, string>, handlers)).toThrow(
      /search/,
    );
    const unsub = c.subscribe(
      { tag: "#a", metadata: { channel: { eq: "general" } } },
      { ...handlers, onError: () => {} },
      { initialBackoffMs: 5 },
    );
    unsub();
  });
});
