import { describe, expect, test } from "bun:test";
import { paramsJsonSchema, parseParams, validateParamsDecl } from "../projection/params.ts";
import { defineProjection, kebabCase } from "../projection/projection.ts";

describe("param declaration validation (define time)", () => {
  test("valid declarations pass", () => {
    expect(() =>
      validateParamsDecl({ from: "date?", body: "string?", limit: "number", flag: "boolean?" }),
    ).not.toThrow();
  });

  test("invalid spec strings throw", () => {
    expect(() => validateParamsDecl({ from: "datetime?" as never })).toThrow("invalid spec");
    expect(() => validateParamsDecl({ from: "Date" as never })).toThrow("invalid spec");
    expect(() => validateParamsDecl({ from: "" as never })).toThrow("invalid spec");
  });

  test("invalid param names throw", () => {
    expect(() => validateParamsDecl({ "from-date": "date?" })).toThrow("invalid");
    expect(() => validateParamsDecl({ "1st": "string" })).toThrow("invalid");
  });
});

describe("parseParams — coercion + strictness", () => {
  const decl = {
    q: "string",
    from: "date?",
    limit: "number?",
    archived: "boolean?",
  } as const;

  test("happy path: REST-style all-string values coerce per declaration", () => {
    const res = parseParams(decl, { q: "tea", from: "2026-06-10", limit: "5", archived: "true" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.params).toEqual({ q: "tea", from: "2026-06-10", limit: 5, archived: true });
    }
  });

  test("happy path: MCP-style native JSON values pass through", () => {
    const res = parseParams(decl, { q: "tea", limit: 5, archived: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.params).toEqual({ q: "tea", limit: 5, archived: false });
  });

  test("missing required is an issue; missing optionals are simply absent", () => {
    const res = parseParams(decl, {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([{ param: "q", message: "required" }]);
    }
  });

  test("null counts as absent (MCP clients null omitted optionals)", () => {
    const res = parseParams(decl, { q: "tea", from: null });
    expect(res.ok).toBe(true);
    if (res.ok) expect("from" in res.params).toBe(false);
  });

  test("unknown params are an issue (strict — a typo never silently widens)", () => {
    const res = parseParams(decl, { q: "tea", form: "2026-06-10" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([{ param: "form", message: "unknown parameter" }]);
    }
  });

  test("bad number / boolean / date values are issues, never throws", () => {
    const res = parseParams(decl, {
      q: "tea",
      from: "not-a-date",
      limit: "many",
      archived: "yep",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((i) => i.param).sort()).toEqual(["archived", "from", "limit"]);
    }
  });

  test("date accepts full ISO datetimes, rejects impossible calendar dates", () => {
    expect(parseParams({ at: "date" }, { at: "2026-06-10T14:30:00Z" }).ok).toBe(true);
    expect(parseParams({ at: "date" }, { at: "2026-06-10T14:30+02:00" }).ok).toBe(true);
    expect(parseParams({ at: "date" }, { at: "2026-13-01" }).ok).toBe(false);
    expect(parseParams({ at: "date" }, { at: "2026-6-1" }).ok).toBe(false);
  });

  test("non-string for a string param is an issue (no implicit stringify)", () => {
    const res = parseParams(decl, { q: 42 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]?.param).toBe("q");
  });
});

describe("paramsJsonSchema — the MCP inputSchema is generated, not hand-kept", () => {
  test("types map, optionality maps to required[], date documents its format", () => {
    const schema = paramsJsonSchema({
      q: "string",
      from: "date?",
      limit: "number?",
      archived: "boolean",
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        q: { type: "string" },
        from: { type: "string", description: "ISO date (YYYY-MM-DD) or ISO datetime" },
        limit: { type: "number" },
        archived: { type: "boolean" },
      },
      required: ["q", "archived"],
      additionalProperties: false,
    });
  });

  test("empty declaration is a valid no-arg schema", () => {
    expect(paramsJsonSchema({})).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});

describe("defineProjection — name + shape validation", () => {
  const base = {
    query: () => ({ tag: "meeting" }),
    shape: (n: { id: string }) => ({ id: n.id }),
    describe: "Test projection.",
  };

  test("camelCase derives kebab REST path + tool name; kebab passes through", () => {
    const p = defineProjection({ name: "upcomingMeetings", ...base });
    expect(p.kebabName).toBe("upcoming-meetings");
    expect(p.restPath).toBe("/api/upcoming-meetings");
    const k = defineProjection({ name: "upcoming-meetings", ...base });
    expect(k.kebabName).toBe("upcoming-meetings");
  });

  test("kebabCase handles digits and single words", () => {
    expect(kebabCase("top10Posts")).toBe("top10-posts");
    expect(kebabCase("meetings")).toBe("meetings");
  });

  test("access defaults to audience (deny-by-default); explicit values honored", () => {
    expect(defineProjection({ name: "x", ...base }).access).toBe("audience");
    expect(defineProjection({ name: "x", access: "public", ...base }).access).toBe("public");
  });

  test("reserved kit namespaces are rejected", () => {
    expect(() => defineProjection({ name: "mcp", ...base })).toThrow("reserved");
    expect(() => defineProjection({ name: "a", ...base })).toThrow("reserved");
  });

  test("invalid names and empty describe are rejected", () => {
    expect(() => defineProjection({ name: "9lives", ...base })).toThrow("invalid");
    expect(() => defineProjection({ name: "has space", ...base })).toThrow("invalid");
    expect(() => defineProjection({ name: "ok", ...base, describe: "  " })).toThrow("describe");
  });
});
