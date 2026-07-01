import { describe, expect, test } from "bun:test";
import type { Note, NotesQueryInput } from "@openparachute/surface-client";
import {
  type DeclaredSurface,
  discoverDeclaredSurfaces,
  parseSurfaceNote,
  registerDeclaredSurfaces,
  runSurfaceDiscovery,
} from "../surface-discovery.ts";

const quietLogger = { log() {}, warn() {}, error() {} };

function note(partial: Partial<Note> & { id: string }): Note {
  return { createdAt: "2026-06-30T00:00:00Z", ...partial };
}

describe("parseSurfaceNote", () => {
  test("uses an explicit metadata.name", () => {
    const r = parseSurfaceNote(
      note({ id: "n1", path: "Surfaces/whatever", metadata: { name: "gitcoin-brain" } }),
    );
    expect("error" in r).toBe(false);
    const s = r as DeclaredSurface;
    expect(s.name).toBe("gitcoin-brain");
    expect(s.mount).toBe("/surface/gitcoin-brain");
    expect(s.mode).toBe("prod");
    expect(s.noteId).toBe("n1");
  });

  test("derives the name from metadata.mount when name is absent", () => {
    const r = parseSurfaceNote(
      note({ id: "n2", metadata: { mount: "/surface/brain" } }),
    ) as DeclaredSurface;
    expect(r.name).toBe("brain");
    expect(r.mount).toBe("/surface/brain");
  });

  test("derives the name from the note path as a last resort", () => {
    const r = parseSurfaceNote(note({ id: "n3", path: "Surfaces/my-app" })) as DeclaredSurface;
    expect(r.name).toBe("my-app");
    expect(r.mount).toBe("/surface/my-app");
  });

  test("honors mode: dev + source.ref + scopes", () => {
    const r = parseSurfaceNote(
      note({
        id: "n4",
        metadata: {
          name: "brain",
          mode: "dev",
          source: { ref: "main" },
          scopes: ["vault:default:read", ""],
        },
      }),
    ) as DeclaredSurface;
    expect(r.mode).toBe("dev");
    expect(r.sourceRef).toBe("main");
    expect(r.scopes).toEqual(["vault:default:read"]);
  });

  test("rejects a name that isn't servable (uppercase / underscore / traversal)", () => {
    // metadata.name "Brain" (uppercase) + mount/path also non-servable → error.
    const r = parseSurfaceNote(
      note({ id: "n5", path: "Surfaces/Bad_Name", metadata: { name: "Brain" } }),
    );
    expect("error" in r).toBe(true);
  });

  test("falls through a bad metadata.name to a servable path segment", () => {
    const r = parseSurfaceNote(
      note({ id: "n6", path: "Surfaces/good-name", metadata: { name: "BAD" } }),
    ) as DeclaredSurface;
    expect(r.name).toBe("good-name");
  });
});

describe("discoverDeclaredSurfaces", () => {
  test("parses valid notes, skips malformed, dedups by name", async () => {
    const notes: Note[] = [
      note({ id: "ok1", metadata: { name: "alpha" } }),
      note({ id: "bad", metadata: { name: "BAD" }, path: "x/ALSO-BAD" }),
      note({ id: "dup", metadata: { name: "alpha" } }), // duplicate
      note({ id: "ok2", metadata: { name: "beta" } }),
    ];
    const { declared, skipped } = await discoverDeclaredSurfaces({
      queryNotes: async () => notes,
      logger: quietLogger,
    });
    expect(declared.map((d) => d.name)).toEqual(["alpha", "beta"]);
    expect(skipped.map((s) => s.noteId).sort()).toEqual(["bad", "dup"]);
  });

  test("passes the surface tag + includeMetadata to the query", async () => {
    let captured: NotesQueryInput | undefined;
    await discoverDeclaredSurfaces({
      queryNotes: async (q) => {
        captured = q;
        return [];
      },
      logger: quietLogger,
    });
    expect(captured).toEqual({ tag: "surface", includeMetadata: true });
  });

  test("a query failure returns empty (best-effort), never throws", async () => {
    const { declared, skipped } = await discoverDeclaredSurfaces({
      queryNotes: async () => {
        throw new Error("vault down");
      },
      logger: quietLogger,
    });
    expect(declared).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe("registerDeclaredSurfaces", () => {
  const surfaces: DeclaredSurface[] = [
    { name: "alpha", mount: "/surface/alpha", mode: "prod", noteId: "a" },
    { name: "beta", mount: "/surface/beta", mode: "dev", noteId: "b" },
  ];

  test("POSTs each to /admin/surfaces with the operator bearer + body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const out = await registerDeclaredSurfaces({
      surfaces,
      hubOrigin: "http://127.0.0.1:1939/",
      operatorToken: "op-token",
      fetchImpl,
      logger: quietLogger,
    });
    expect(out.registered).toEqual(["alpha", "beta"]);
    expect(out.failed).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:1939/admin/surfaces");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer op-token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "alpha",
      mount: "/surface/alpha",
      mode: "prod",
    });
  });

  test("a non-OK response marks that surface failed, others still register", async () => {
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { name: string };
      if (body.name === "alpha") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const out = await registerDeclaredSurfaces({
      surfaces,
      hubOrigin: "http://127.0.0.1:1939",
      operatorToken: "op",
      fetchImpl,
      logger: quietLogger,
    });
    expect(out.registered).toEqual(["beta"]);
    expect(out.failed.map((f) => f.name)).toEqual(["alpha"]);
  });

  test("a thrown fetch marks that surface failed", async () => {
    const fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const out = await registerDeclaredSurfaces({
      surfaces: [surfaces[0]!],
      hubOrigin: "http://127.0.0.1:1939",
      operatorToken: "op",
      fetchImpl,
      logger: quietLogger,
    });
    expect(out.registered).toEqual([]);
    expect(out.failed[0]?.reason).toContain("ECONNREFUSED");
  });
});

describe("runSurfaceDiscovery", () => {
  test("skips when no queryNotes (no read credential)", async () => {
    const r = await runSurfaceDiscovery({
      hubOrigin: "http://127.0.0.1:1939",
      operatorToken: "op",
      logger: quietLogger,
    });
    expect(r.skipReason).toContain("no vault read credential");
    expect(r.registered).toEqual([]);
  });

  test("skips when no operator token", async () => {
    const r = await runSurfaceDiscovery({
      hubOrigin: "http://127.0.0.1:1939",
      queryNotes: async () => [],
      logger: quietLogger,
    });
    expect(r.skipReason).toContain("no operator token");
  });

  test("happy path: discovers + registers", async () => {
    const registered: string[] = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      registered.push((JSON.parse(String(init?.body)) as { name: string }).name);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const r = await runSurfaceDiscovery({
      queryNotes: async () => [note({ id: "n", metadata: { name: "brain" } })],
      hubOrigin: "http://127.0.0.1:1939",
      operatorToken: "op",
      fetchImpl,
      logger: quietLogger,
    });
    expect(r.declared.map((d) => d.name)).toEqual(["brain"]);
    expect(r.registered).toEqual(["brain"]);
    expect(registered).toEqual(["brain"]);
  });

  test("no declared surfaces → no register calls", async () => {
    let called = 0;
    const r = await runSurfaceDiscovery({
      queryNotes: async () => [],
      hubOrigin: "http://127.0.0.1:1939",
      operatorToken: "op",
      fetchImpl: async () => {
        called++;
        return new Response("{}", { status: 200 });
      },
      logger: quietLogger,
    });
    expect(r.declared).toEqual([]);
    expect(called).toBe(0);
  });
});
