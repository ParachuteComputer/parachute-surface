/**
 * P1 — `meta.json` `server` block + `audience` field (surface-runtime
 * design, R3a commit 1).
 *
 * Covers:
 *   - server block parsing: defaults, entry no-traversal, format enum,
 *     capabilities enum + dedupe, timeoutMs bounds
 *   - audience parsing: canonical enum, default, legacy `public` alias
 *     (true → "public") + deprecation diagnostics, contradiction rejection
 *   - transport: `audience` (+ scopes_required) flow into the services.json
 *     `uis{}` map; the row-level `websocket` flag flips on/off with the
 *     installed surfaces' declared capabilities
 */
import { describe, expect, test } from "bun:test";

import { buildSelfRegisterExtraFields } from "../admin-routes.ts";
import {
  DEFAULT_AUDIENCE,
  InvalidMetaError,
  SERVER_TIMEOUT_DEFAULT_MS,
  SERVER_TIMEOUT_MAX_MS,
  SERVER_TIMEOUT_MIN_MS,
  SURFACE_AUDIENCE_HUB_HINT,
  metaSchemaJson,
  parseMeta,
  parseMetaWithDiagnostics,
} from "../meta-schema.ts";
import type { RegisteredUi } from "../ui-registry.ts";

const BASE = { name: "demo", displayName: "Demo", path: "/surface/demo" };

function regUi(meta: Record<string, unknown>): RegisteredUi {
  const parsed = parseMeta({ ...BASE, ...meta });
  return {
    dirName: parsed.name,
    uiDir: `/nonexistent/${parsed.name}`,
    distDir: `/nonexistent/${parsed.name}/dist`,
    meta: parsed,
  };
}

describe("server block (P1)", () => {
  test("absent server → undefined (static surface)", () => {
    expect(parseMeta(BASE).server).toBeUndefined();
  });

  test("minimal server block fills defaults", () => {
    const m = parseMeta({ ...BASE, server: { entry: "server/index.js" } });
    expect(m.server).toEqual({
      entry: "server/index.js",
      format: "markdown",
      capabilities: [],
      timeoutMs: SERVER_TIMEOUT_DEFAULT_MS,
    });
  });

  test("full server block round-trips", () => {
    const m = parseMeta({
      ...BASE,
      server: {
        entry: "server/index.js",
        format: "opaque",
        capabilities: ["websocket"],
        timeoutMs: 5_000,
      },
    });
    expect(m.server?.format).toBe("opaque");
    expect(m.server?.capabilities).toEqual(["websocket"]);
    expect(m.server?.timeoutMs).toBe(5_000);
  });

  test("entry traversal shapes are rejected", () => {
    for (const entry of [
      "/abs/path.js",
      "../outside.js",
      "server/../../outside.js",
      "server\\index.js",
      "server//index.js",
      "a/\0/b.js",
      "",
    ]) {
      expect(() => parseMeta({ ...BASE, server: { entry } })).toThrow(InvalidMetaError);
    }
  });

  test("`.` segments and nested relative paths are fine", () => {
    const m = parseMeta({ ...BASE, server: { entry: "dist/server/entry.mjs" } });
    expect(m.server?.entry).toBe("dist/server/entry.mjs");
  });

  test("format must be markdown|opaque", () => {
    expect(() => parseMeta({ ...BASE, server: { entry: "s.js", format: "html" } })).toThrow(
      InvalidMetaError,
    );
  });

  test("capabilities must be declared values; dedupes", () => {
    expect(() =>
      parseMeta({ ...BASE, server: { entry: "s.js", capabilities: ["telnet"] } }),
    ).toThrow(InvalidMetaError);
    const m = parseMeta({
      ...BASE,
      server: { entry: "s.js", capabilities: ["websocket", "websocket"] },
    });
    expect(m.server?.capabilities).toEqual(["websocket"]);
  });

  test("timeoutMs bounds enforced (1s–120s)", () => {
    for (const timeoutMs of [SERVER_TIMEOUT_MIN_MS - 1, SERVER_TIMEOUT_MAX_MS + 1, 1.5, "30s"]) {
      expect(() => parseMeta({ ...BASE, server: { entry: "s.js", timeoutMs } })).toThrow(
        InvalidMetaError,
      );
    }
    expect(
      parseMeta({ ...BASE, server: { entry: "s.js", timeoutMs: SERVER_TIMEOUT_MIN_MS } }).server
        ?.timeoutMs,
    ).toBe(SERVER_TIMEOUT_MIN_MS);
    expect(
      parseMeta({ ...BASE, server: { entry: "s.js", timeoutMs: SERVER_TIMEOUT_MAX_MS } }).server
        ?.timeoutMs,
    ).toBe(SERVER_TIMEOUT_MAX_MS);
  });

  test("server must be an object", () => {
    expect(() => parseMeta({ ...BASE, server: "server/index.js" })).toThrow(InvalidMetaError);
    expect(() => parseMeta({ ...BASE, server: ["server/index.js"] })).toThrow(InvalidMetaError);
  });
});

describe("audience field (§12 transport)", () => {
  test("default is hub-users (public derived false)", () => {
    const m = parseMeta(BASE);
    expect(m.audience).toBe(DEFAULT_AUDIENCE);
    expect(m.public).toBe(false);
  });

  test("canonical values parse; public derives", () => {
    expect(parseMeta({ ...BASE, audience: "public" }).public).toBe(true);
    expect(parseMeta({ ...BASE, audience: "operator" }).public).toBe(false);
    expect(parseMeta({ ...BASE, audience: "hub-users" }).audience).toBe("hub-users");
  });

  test("unknown audience rejected", () => {
    expect(() => parseMeta({ ...BASE, audience: "everyone" })).toThrow(InvalidMetaError);
    expect(() => parseMeta({ ...BASE, audience: true })).toThrow(InvalidMetaError);
  });

  test("legacy public:true aliases to 'public' with a deprecation note", () => {
    const { meta, warnings } = parseMetaWithDiagnostics({ ...BASE, public: true });
    expect(meta.audience).toBe("public");
    expect(meta.public).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("deprecated");
  });

  test("legacy public:false aliases to the default with a deprecation note", () => {
    const { meta, warnings } = parseMetaWithDiagnostics({ ...BASE, public: false });
    expect(meta.audience).toBe(DEFAULT_AUDIENCE);
    expect(warnings.length).toBe(1);
  });

  test("consistent audience+public pair parses without warning", () => {
    const { meta, warnings } = parseMetaWithDiagnostics({
      ...BASE,
      audience: "public",
      public: true,
    });
    expect(meta.audience).toBe("public");
    expect(warnings).toEqual([]);
  });

  test("contradictory audience+public pair is refused", () => {
    expect(() => parseMeta({ ...BASE, audience: "operator", public: true })).toThrow(
      InvalidMetaError,
    );
    expect(() => parseMeta({ ...BASE, audience: "public", public: false })).toThrow(
      InvalidMetaError,
    );
  });

  test('audience: "surface" parses (backend-owned admission — needs the hub tier)', () => {
    const meta = parseMeta({ ...BASE, audience: "surface" });
    expect(meta.audience).toBe("surface");
    expect(meta.public).toBe(false); // never the legacy-public alias
  });

  test('audience: "surface" emits the hub-tier diagnostic (#99 — unconditional, no cheap probe)', () => {
    const { meta, warnings } = parseMetaWithDiagnostics({ ...BASE, audience: "surface" });
    expect(meta.audience).toBe("surface");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(SURFACE_AUDIENCE_HUB_HINT);
    // Every other audience stays warning-free.
    for (const audience of ["public", "hub-users", "operator"]) {
      expect(parseMetaWithDiagnostics({ ...BASE, audience }).warnings).toEqual([]);
    }
  });

  test("metaSchemaJson exposes audience + server", () => {
    const props = metaSchemaJson().properties as Record<string, Record<string, unknown>>;
    expect(props.audience?.enum).toEqual(["public", "hub-users", "operator", "surface"]);
    expect((props.server?.properties as Record<string, unknown>) ?? {}).toHaveProperty("entry");
  });
});

describe("uis{} transport + websocket row flag", () => {
  test("audience + scopes_required flow into the uis map", () => {
    const extras = buildSelfRegisterExtraFields([
      regUi({ audience: "public", scopes_required: ["vault:default:read"] }),
    ]);
    const uis = extras.uis as Record<string, Record<string, unknown>>;
    expect(uis.demo?.audience).toBe("public");
    expect(uis.demo?.scopes_required).toEqual(["vault:default:read"]);
  });

  test("websocket=true iff any surface declares the capability", () => {
    const wsUi = regUi({
      name: "wsapp",
      path: "/surface/wsapp",
      server: { entry: "server/index.js", capabilities: ["websocket"] },
    });
    const plainBacked = regUi({
      name: "plain",
      path: "/surface/plain",
      server: { entry: "server/index.js" },
    });
    const staticUi = regUi({ name: "staticy", path: "/surface/staticy" });

    expect(buildSelfRegisterExtraFields([wsUi, staticUi]).websocket).toBe(true);
    expect(buildSelfRegisterExtraFields([plainBacked, staticUi]).websocket).toBe(false);
    // Explicit false (not absent) so the merge-style upsert CLEARS a stale true.
    expect(buildSelfRegisterExtraFields([]).websocket).toBe(false);
  });
});
