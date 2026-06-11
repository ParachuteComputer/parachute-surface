/**
 * Tests for `src/meta-schema.ts` — the meta.json shape validator.
 *
 * Coverage:
 *   - Required fields present + correctly-typed → valid
 *   - Defaults applied: scopes_required → ["vault:read"], pwa/public → false
 *   - name pattern rejects uppercase, leading digit, special chars
 *   - path pattern rejects bare /surface, /surface/, multi-segment, missing-leading-slash
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
      path: "/surface/test-ui",
    });
    expect(meta.name).toBe("test-ui");
    expect(meta.displayName).toBe("Test UI");
    expect(meta.path).toBe("/surface/test-ui");
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
      path: "/surface/notes",
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
    expect(() => parseMeta({ displayName: "X", path: "/surface/x" })).toThrow(InvalidMetaError);
  });

  test("missing displayName", () => {
    expect(() => parseMeta({ name: "x", path: "/surface/x" })).toThrow(InvalidMetaError);
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
    expect(() => parseMeta({ name: "TestUi", displayName: "X", path: "/surface/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects leading digit", () => {
    expect(() => parseMeta({ name: "1ui", displayName: "X", path: "/surface/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects special chars", () => {
    expect(() => parseMeta({ name: "u_i", displayName: "X", path: "/surface/x" })).toThrow(
      InvalidMetaError,
    );
    expect(() => parseMeta({ name: "u.i", displayName: "X", path: "/surface/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("accepts lowercase + digits + hyphens", () => {
    const m = parseMeta({ name: "gitcoin-brain-2", displayName: "X", path: "/surface/x" });
    expect(m.name).toBe("gitcoin-brain-2");
  });

  test("NAME_PATTERN is exported and works", () => {
    expect(NAME_PATTERN.test("good-name")).toBe(true);
    expect(NAME_PATTERN.test("Bad")).toBe(false);
  });
});

describe("parseMeta — path pattern", () => {
  test("rejects bare /surface", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/surface" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects /surface/ trailing slash", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/surface/" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects multi-segment path", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/surface/x/y" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects path without leading slash", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "app/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("rejects non-/surface prefix", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/other/x" })).toThrow(
      InvalidMetaError,
    );
  });

  test("PATH_PATTERN is exported and works", () => {
    expect(PATH_PATTERN.test("/surface/foo")).toBe(true);
    expect(PATH_PATTERN.test("/surface/foo-bar")).toBe(true);
    expect(PATH_PATTERN.test("/surface/foo/bar")).toBe(false);
  });
});

describe("parseMeta — pwa constraints", () => {
  test("pwa true without pwa_service_worker → invalid", () => {
    expect(() => parseMeta({ name: "x", displayName: "X", path: "/surface/x", pwa: true })).toThrow(
      InvalidMetaError,
    );
  });

  test("pwa false without pwa_service_worker → valid", () => {
    const m = parseMeta({ name: "x", displayName: "X", path: "/surface/x", pwa: false });
    expect(m.pwa).toBe(false);
  });

  test("pwa_service_worker with leading slash → invalid", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        pwa: true,
        pwa_service_worker: "/sw.js",
      }),
    ).toThrow(InvalidMetaError);
  });

  test("pwa with relative SW path → valid", () => {
    const m = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
      pwa: true,
      pwa_service_worker: "sw.js",
    });
    expect(m.pwa_service_worker).toBe("sw.js");
  });
});

describe("parseMeta — scopes_required", () => {
  test("default applied when absent", () => {
    const m = parseMeta({ name: "x", displayName: "X", path: "/surface/x" });
    expect(m.scopes_required).toEqual([...DEFAULT_SCOPES_REQUIRED]);
  });

  test("non-array rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        scopes_required: "vault:read",
      }),
    ).toThrow(InvalidMetaError);
  });

  test("array of non-strings rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        scopes_required: ["ok", 123],
      }),
    ).toThrow(InvalidMetaError);
  });

  test("empty string in array rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        scopes_required: [""],
      }),
    ).toThrow(InvalidMetaError);
  });

  test("empty array is allowed (no scopes)", () => {
    const m = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
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
        "audience",
        "dev_build_cmd",
        "dev_debounce_ms",
        "dev_watch_dir",
        "displayName",
        "iconUrl",
        "name",
        "path",
        "public",
        "pwa",
        "pwa_service_worker",
        "required_schema",
        "scopes_required",
        "server",
        "tagline",
        "vault_default",
        "version",
      ].sort(),
    );
  });

  test("Phase 3.0 dev fields appear in the schema", () => {
    const schema = metaSchemaJson();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.dev_watch_dir?.type).toBe("string");
    expect(props.dev_build_cmd?.type).toBe("string");
    expect(props.dev_debounce_ms?.type).toBe("integer");
    expect(props.dev_debounce_ms?.minimum).toBe(50);
  });

  test("required_schema property describes the tag-role shape", () => {
    const schema = metaSchemaJson();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const rs = props.required_schema!;
    expect(rs.type).toBe("object");
    expect(rs.additionalProperties).toBe(false);
    const rsProps = rs.properties as Record<string, Record<string, unknown>>;
    expect(rsProps.tags?.type).toBe("array");
  });
});

describe("parseMeta — Phase 3.0 dev-mode fields", () => {
  test("accepts dev_watch_dir + dev_build_cmd + dev_debounce_ms", () => {
    const m = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
      dev_watch_dir: "../src",
      dev_build_cmd: "bun run build",
      dev_debounce_ms: 500,
    });
    expect(m.dev_watch_dir).toBe("../src");
    expect(m.dev_build_cmd).toBe("bun run build");
    expect(m.dev_debounce_ms).toBe(500);
  });

  test("omitted dev fields leave the props undefined", () => {
    const m = parseMeta({ name: "x", displayName: "X", path: "/surface/x" });
    expect(m.dev_watch_dir).toBeUndefined();
    expect(m.dev_build_cmd).toBeUndefined();
    expect(m.dev_debounce_ms).toBeUndefined();
  });

  test("rejects non-string dev_watch_dir", () => {
    expect(() =>
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_watch_dir: 1 as unknown }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects empty-string dev_watch_dir", () => {
    expect(() =>
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_watch_dir: "" }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects absolute-path dev_watch_dir (operator footgun guard)", () => {
    // dev_watch_dir is resolved relative to the UI's root directory.
    // Allowing absolute paths like "/etc" or "/" would let a misconfigured
    // meta.json arm a recursive FSWatcher on the host filesystem.
    // Mirrors pwa_service_worker's leading-slash rejection.
    expect(() =>
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_watch_dir: "/etc" }),
    ).toThrow(InvalidMetaError);
    expect(() =>
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_watch_dir: "/" }),
    ).toThrow(InvalidMetaError);
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        dev_watch_dir: "/Users/alice/code",
      }),
    ).toThrow(InvalidMetaError);
  });

  test("accepts relative dev_watch_dir variants", () => {
    // Relative forms — including `..`-escaping the bundle (the documented
    // "watch a checkout next to the install" use case) and `./`-prefixed.
    expect(
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_watch_dir: "src" })
        .dev_watch_dir,
    ).toBe("src");
    expect(
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_watch_dir: "./src" })
        .dev_watch_dir,
    ).toBe("./src");
    expect(
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        dev_watch_dir: "../gitcoin-brain-ui/src",
      }).dev_watch_dir,
    ).toBe("../gitcoin-brain-ui/src");
  });

  test("rejects non-string dev_build_cmd", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        dev_build_cmd: true as unknown,
      }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects dev_debounce_ms below the 50ms floor", () => {
    expect(() =>
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_debounce_ms: 10 }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects non-integer dev_debounce_ms", () => {
    expect(() =>
      parseMeta({ name: "x", displayName: "X", path: "/surface/x", dev_debounce_ms: 250.5 }),
    ).toThrow(InvalidMetaError);
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        dev_debounce_ms: "250" as unknown,
      }),
    ).toThrow(InvalidMetaError);
  });
});

describe("parseMeta — required_schema (patterns#57)", () => {
  // Phase 2.0 SHAPE test: validator accepts a UI with required_schema
  // declared; the auto-provisioner (Phase 2.1+) is out of scope.

  test("accepts a meta.json with required_schema.tags declared", () => {
    const meta = parseMeta({
      name: "notes",
      displayName: "Notes",
      path: "/surface/notes",
      required_schema: {
        tags: [
          {
            name: "capture",
            description: "Quick captures from voice or text",
            fields: {
              source: {
                type: "string",
                required: true,
                description: "Where the capture came from",
              },
              count: { type: "number" },
              archived: { type: "boolean", required: false },
              createdAt: { type: "date" },
            },
          },
          {
            name: "pinned",
          },
        ],
      },
    });
    expect(meta.required_schema?.tags?.length).toBe(2);
    expect(meta.required_schema?.tags?.[0]?.name).toBe("capture");
    expect(meta.required_schema?.tags?.[0]?.fields?.source?.type).toBe("string");
    expect(meta.required_schema?.tags?.[0]?.fields?.source?.required).toBe(true);
    expect(meta.required_schema?.tags?.[1]?.name).toBe("pinned");
    expect(meta.required_schema?.tags?.[1]?.fields).toBeUndefined();
  });

  test("accepts an explicit empty required_schema (deliberate 'no schema needed')", () => {
    const meta = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
      required_schema: {},
    });
    expect(meta.required_schema).toEqual({});
  });

  test("absent required_schema leaves field undefined", () => {
    const meta = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
    });
    expect(meta.required_schema).toBeUndefined();
  });

  test("rejects non-object required_schema", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: "tags",
      }),
    ).toThrow(InvalidMetaError);
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: [],
      }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects non-array required_schema.tags", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: { tags: { name: "x" } },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects tag entry without name", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: { tags: [{ description: "missing name" }] },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects tag fields with disallowed type", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", fields: { foo: { type: "object" } } }],
        },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects tag fields with non-boolean required", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", fields: { foo: { type: "string", required: "yes" } } }],
        },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("rejects tag fields container that isn't an object", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", fields: [] }],
        },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("InvalidMetaError.details point at the field path", () => {
    try {
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", fields: { foo: { type: "garbage" } } }],
        },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMetaError);
      const err = e as InvalidMetaError;
      const paths = err.details.map((d) => d.path);
      expect(paths.some((p) => p.includes("required_schema.tags[0].fields.foo.type"))).toBe(true);
    }
  });
});

describe("parseMeta — required_schema.tags[].parent_names (app#19)", () => {
  // Phase 2.0 SHAPE: validator accepts/passes-through `parent_names` so apps'
  // hierarchical tag declarations (e.g. `capture/text` -> parent `capture`)
  // survive the parse. Cross-reference validation ("does this parent exist?")
  // is the Phase 2.1+ auto-provisioner's job — out of scope here.

  test("parent_names present → preserved in the parsed UiMeta", () => {
    const meta = parseMeta({
      name: "notes",
      displayName: "Notes",
      path: "/surface/notes",
      required_schema: {
        tags: [
          { name: "capture", description: "User-captured notes." },
          { name: "capture/text", parent_names: ["capture"], description: "Text capture." },
          { name: "capture/voice", parent_names: ["capture"], description: "Voice capture." },
        ],
      },
    });
    expect(meta.required_schema?.tags?.[0]?.parent_names).toBeUndefined();
    expect(meta.required_schema?.tags?.[1]?.parent_names).toEqual(["capture"]);
    expect(meta.required_schema?.tags?.[2]?.parent_names).toEqual(["capture"]);
  });

  test("parent_names absent → field stays undefined (no default to empty)", () => {
    const meta = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
      required_schema: { tags: [{ name: "c" }] },
    });
    expect(meta.required_schema?.tags?.[0]?.parent_names).toBeUndefined();
    // Sanity: `in` check too — explicit absence, not just falsy.
    expect("parent_names" in (meta.required_schema!.tags![0] as object)).toBe(false);
  });

  test("parent_names explicit empty array → accepted, preserved", () => {
    // Explicit `[]` is a deliberate operator signal ("no parents") and
    // we preserve the distinction from `undefined` so the admin SPA /
    // auto-provisioner can tell them apart.
    const meta = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
      required_schema: { tags: [{ name: "c", parent_names: [] }] },
    });
    expect(meta.required_schema?.tags?.[0]?.parent_names).toEqual([]);
  });

  test("parent_names with multiple parents → all preserved in order", () => {
    const meta = parseMeta({
      name: "x",
      displayName: "X",
      path: "/surface/x",
      required_schema: {
        tags: [{ name: "a/b/c", parent_names: ["a", "a/b"] }],
      },
    });
    expect(meta.required_schema?.tags?.[0]?.parent_names).toEqual(["a", "a/b"]);
  });

  test("parent_names with non-string entry → rejected", () => {
    try {
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", parent_names: ["capture", 42] }],
        },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMetaError);
      const err = e as InvalidMetaError;
      const paths = err.details.map((d) => d.path);
      expect(paths.some((p) => p.includes("required_schema.tags[0].parent_names[1]"))).toBe(true);
    }
  });

  test("parent_names with null entry → rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", parent_names: [null] }],
        },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("parent_names with empty-string entry → rejected", () => {
    try {
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", parent_names: [""] }],
        },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMetaError);
      const err = e as InvalidMetaError;
      const paths = err.details.map((d) => d.path);
      expect(paths.some((p) => p.includes("required_schema.tags[0].parent_names[0]"))).toBe(true);
    }
  });

  test("parent_names that is not an array → rejected", () => {
    expect(() =>
      parseMeta({
        name: "x",
        displayName: "X",
        path: "/surface/x",
        required_schema: {
          tags: [{ name: "c", parent_names: "capture" }],
        },
      }),
    ).toThrow(InvalidMetaError);
  });

  test("notes' canonical case: capture/text with parent_names ['capture'] parses cleanly", () => {
    // Mirrors NOTES_REQUIRED_SCHEMA in parachute-notes/packages/notes-ui/src/lib/vault/schema.ts.
    // The motivating use case for app#19 — notes' real hierarchy declares
    // capture, capture/text -> [capture], capture/voice -> [capture].
    const meta = parseMeta({
      name: "notes",
      displayName: "Notes",
      path: "/surface/notes",
      required_schema: {
        tags: [
          {
            name: "capture",
            description: "Notes captured directly by the user (text or voice).",
          },
          {
            name: "capture/text",
            parent_names: ["capture"],
            description: "Text capture.",
          },
          {
            name: "capture/voice",
            parent_names: ["capture"],
            description: "Voice capture.",
          },
        ],
      },
    });
    const tags = meta.required_schema?.tags ?? [];
    expect(tags.length).toBe(3);
    expect(tags[0]?.name).toBe("capture");
    expect(tags[0]?.parent_names).toBeUndefined();
    expect(tags[1]?.name).toBe("capture/text");
    expect(tags[1]?.parent_names).toEqual(["capture"]);
    expect(tags[2]?.name).toBe("capture/voice");
    expect(tags[2]?.parent_names).toEqual(["capture"]);
  });

  test("metaSchemaJson() surfaces parent_names on the tag item shape", () => {
    const schema = metaSchemaJson();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const tags = (props.required_schema!.properties as Record<string, Record<string, unknown>>)
      .tags!;
    const item = tags.items as Record<string, unknown>;
    const itemProps = item.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.parent_names?.type).toBe("array");
    const items = itemProps.parent_names?.items as Record<string, unknown>;
    expect(items.type).toBe("string");
  });
});
