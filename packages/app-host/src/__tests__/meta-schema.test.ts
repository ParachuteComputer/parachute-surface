/**
 * Tests for `src/meta-schema.ts` — the meta.json shape validator.
 *
 * Coverage:
 *   - Required fields present + correctly-typed → valid
 *   - Defaults applied: scopes_required → ["vault:read"], pwa/public → false
 *   - name pattern rejects uppercase, leading digit, special chars
 *   - path pattern rejects bare /app, /app/, multi-segment, missing-leading-slash
 *   - pwa: true without pwa_service_worker → invalid
 *   - pwa_service_worker leading slash → invalid
 *   - InvalidMetaError exposes a flat details array
 *   - metaSchemaJson() exposes the documented surface
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SCOPES_REQUIRED,
  InvalidMetaError,
  NAME_PATTERN,
  PATH_PATTERN,
  metaSchemaJson,
  parseMeta,
} from "../meta-schema.ts";

describe("parseMeta — required fields + defaults", () => {
  test("minimum valid meta", () => {
    const meta = parseMeta({
      name: "test-ui",
      displayName: "Test UI",
      path: "/app/test-ui",
    });
    expect(meta.name).toBe("test-ui");
    expect(meta.displayName).toBe("Test UI");
    expect(meta.path).toBe("/app/test-ui");
    // Defaults
    expect(meta.scopes_required).toEqual([...DEFAULT_SCOPES_REQUIRED]);
    expect(meta.pwa).toBe(false);
    expect(meta.public).toBe(false);
    // Optionals omitted
    expect(meta.tagline).toBeUndefined();
    expect(meta.version).toBeUndefined();
    expect(meta.iconUrl).toBeUndefined();
    expect(meta.pwa_service_worker).toBeUndefined();
    expect(meta.vault_default).toBeUndefined();
  });

  test("full valid meta", () => {
    const meta = parseMeta({
      name: "notes",
      displayName: "Notes",
      tagline: "Edit your vault offline.",
      path: "/app/notes",
      version: "0.5.0",
      iconUrl: "icon.svg",
      scopes_required: ["vault:read", "vault:write"],
      vault_default: "default",
      pwa: true,
      pwa_service_worker: "sw.js",
      public: false,
    });
    expect(meta.tagline).toBe("Edit your vault offline.");
    expect(meta.version).toBe("0.5.0");
    expect(meta.iconUrl).toBe("icon.svg");
    expect(meta.scopes_required).toEqual(["vault:read", "vault:write"]);
    expect(meta.vault_default).toBe("default");
    expect(meta.pwa).toBe(true);
    expect(meta.pwa_service_worker).toBe("sw.js");
    expect(meta.public).toBe(false);
  });
});

describe("parseMeta — invalid shape", () => {
  test("missing name", () => {
    expect(() => parseMeta({ displayName: "X", path: "/app/x" })).toThrow(InvalidMetaError);
  });

  test("missing displayName", () => {
    expect(() => parseMeta({ name: "x", path: "/app/x" })).toThrow(InvalidMetaError);
  });

  test("missing path", () => {
    expect(() => parseMeta({ name: "x", displayName: "X" })).toThrow(InvalidMetaError);
  });

  test("non-object root", () => {
    expect(() => parseMeta(null)).toThrow(InvalidMetaError);
    expect(() => parseMeta("string")).toThrow(InvalidMetaError);
    expect(() => parseMeta([])).toThrow(InvalidMetaError);
  });

  test("InvalidMetaError exposes details list", () => {
    try {
      parseMeta({});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMetaError);
      const err = e as InvalidMetaError;
      const paths = err.details.map((d) => d.path).sort();
      expect(paths).toEqual(["displayName", "name", "path"]);
    }
  });
});

describe("parseMeta — name pattern", () => {
  test("rejects uppercase", () => {
    expect(() => parseMeta({ name: "TestUi", displayName: "X", path: "/app/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects leading digit", () => {
    expect(() => parseMeta({ name: "1ui", displayName: "X", path: "/app/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects special chars", () => {
    expect(() => parseMeta({ name: "u_i", displayName: "X", path: "/app/x" })).toThrow(
      InvalidMetaError,
    );
    expect(() => parseMeta({ name: "u.i", displayName: "X", path: "/app/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("accepts lowercase + digits + hyphens", () => {
    const m = parseMeta({ name: "gitcoin-brain-2", displayName: "X", path: "/app/x" });
    expect(m.name).toBe("gitcoin-brain-2");
  });

  test("NAME_PATTERN is exported and works", () => {
    expect(NAME_PATTERN.test("good-name")).toBe(true);
    expect(NAME_PATTERN.test("Bad")).toBe(false);
  });
});

describe("parseMeta — path pattern", () => {
  test("rejects bare /app", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/app" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects /app/ trailing slash", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/app/" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects multi-segment path", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/app/x/y" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects path without leading slash", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "app/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects non-/app prefix", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/other/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("PATH_PATTERN is exported and works", () => {
    expect(PATH_PATTERN.test("/app/foo")).toBe(true);
    expect(PATH_PATTERN.test("/app/foo-bar")).toBe(true);
    expect(PATH_PATTERN.test("/app/foo/bar")).toBe(false);
  });
});

describe("parseMeta — pwa constraints", () => {
  test("pwa true without pwa_service_worker → invalid", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/app/x", pwa: true })).toThrow(
      InvalidMetaError,
    );
  });

  test("pwa false without pwa_service_worker → valid", () => {
    const m = parseMeta({ name: "x", displayName: "X", path: "/app/x", pwa: false });
    expect(m.pwa).toBe(false);
  });

  test("pwa_service_worker with leading slash → invalid", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/app/x",
        pwa: true,
        pwa_service_worker: "/sw.js",
      }),
    ).toThrow(InvalidMetaError);
  });

  test("pwa with relative SW path → valid", () => {
    const m = parseMeta({
      name: "x",
      displayName: "X",
      path: "/app/x",
      pwa: true,
      pwa_service_worker: "sw.js",
    });
    expect(m.pwa_service_worker).toBe("sw.js");
  });
});

describe("parseMeta — scopes_required", () => {
  test("default applied when absent", () => {
    const m = parseMeta({ name: "x", displayName: "X", path: "/app/x" });
    expect(m.scopes_required).toEqual([...DEFAULT_SCOPES_REQUIRED]);
  });

  test("non-array rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/app/x",
        scopes_required: "vault:read",
      }),
    ).toThrow(InvalidMetaError);
  });

  test("array of non-strings rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/app/x",
        scopes_required: ["ok", 123],
      }),
    ).toThrow(InvalidMetaError);
  });

  test("empty string in array rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/app/x",
        scopes_required: [""],
      }),
    ).toThrow(InvalidMetaError);
  });

  test("empty array is allowed (no scopes)", () => {
    const m = parseMeta({
      name: "x",
      displayName: "X",
      path: "/app/x",
      scopes_required: [],
    });
    expect(m.scopes_required).toEqual([]);
  });
});

describe("metaSchemaJson", () => {
  test("exposes required + properties", () => {
    const schema = metaSchemaJson();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.required).toEqual(["name", "displayName", "path"]);
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      [
        "displayName",
        "iconUrl",
        "name",
        "path",
        "public",
        "pwa",
        "pwa_service_worker",
        "scopes_required",
        "tagline",
        "vault_default",
        "version",
      ].sort(),
    );
  });
});
