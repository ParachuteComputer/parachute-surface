/**
 * Projection parameter declarations — ONE validator behind BOTH derived
 * faces of a projection (design P9).
 *
 * A projection declares its params as `{ name: spec }` where spec is a
 * base type with an optional `?` suffix: `'date?'` → an optional ISO
 * date. The SAME declaration drives:
 *
 *   - **REST** — query-string values (`?from=2026-06-10`) parsed +
 *     coerced; bad input is a 400 with per-param issues, never a 500.
 *   - **MCP** — the tool's JSON-Schema `inputSchema` is GENERATED from
 *     the declaration, and tool-call arguments run through the same
 *     validator; bad input is an in-band tool error, never a thrown 500.
 *
 * Validation is STRICT both ways: unknown keys are an issue (a typo'd
 * param should fail loudly, not silently widen a query), missing
 * required params are an issue, and `date` values must actually parse.
 * Coercion is deliberately narrow — REST strings coerce to their
 * declared scalar; everything else must already be the right JSON type.
 */

/** The declarable base types. `date` stays a STRING (ISO) after parsing. */
export const PARAM_TYPES = ["string", "number", "boolean", "date"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** A base type, or `'<type>?'` for optional. */
export type ParamSpec = ParamType | `${ParamType}?`;

/** The params declaration: `{ from: 'date?', body: 'string?' }`. */
export type ParamsDecl = Record<string, ParamSpec>;

type BaseValue<T extends string> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "date"
        ? string
        : never;

/** The parsed value type for one spec (`'date?'` → `string | undefined`). */
export type ParamValue<S extends ParamSpec> = S extends `${infer T}?`
  ? BaseValue<T> | undefined
  : BaseValue<S>;

/** The fully parsed params object for a declaration. */
export type ParamsOf<D extends ParamsDecl> = { [K in keyof D]: ParamValue<D[K]> };

export interface ParamIssue {
  param: string;
  message: string;
}

export type ParseParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; issues: ParamIssue[] };

/** Split a spec into its base type + optionality. Throws on a bad spec. */
export function parseParamSpec(name: string, spec: string): { type: ParamType; optional: boolean } {
  const optional = spec.endsWith("?");
  const base = optional ? spec.slice(0, -1) : spec;
  if (!(PARAM_TYPES as readonly string[]).includes(base)) {
    throw new Error(
      `defineProjection: param "${name}" has invalid spec "${spec}" — expected one of ${PARAM_TYPES.join(
        "/",
      )} with an optional '?' suffix`,
    );
  }
  return { type: base as ParamType, optional };
}

/** Validate a whole declaration at define time (throws — a coding error). */
export function validateParamsDecl(decl: ParamsDecl): void {
  for (const [name, spec] of Object.entries(decl)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(
        `defineProjection: param name "${name}" is invalid — letters/digits/underscore, starting with a letter`,
      );
    }
    parseParamSpec(name, spec);
  }
}

/**
 * ISO date (`YYYY-MM-DD`) or ISO datetime (`...THH:mm[:ss[.sss]][Z|±hh:mm]`).
 * The regex pins the SHAPE; `Date.parse` then rejects impossible values
 * (month 13, Feb 30) the shape alone would admit.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Coerce one raw value (REST string or MCP JSON value) to its declared
 * type. Returns `{ ok: false }` with a caller-facing message on mismatch.
 */
function coerce(
  type: ParamType,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (type) {
    case "string": {
      if (typeof raw === "string") return { ok: true, value: raw };
      return { ok: false, message: "expected a string" };
    }
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: raw };
      if (typeof raw === "string" && raw.trim().length > 0) {
        const n = Number(raw);
        if (Number.isFinite(n)) return { ok: true, value: n };
      }
      return { ok: false, message: "expected a finite number" };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, message: "expected a boolean (true/false)" };
    }
    case "date": {
      if (typeof raw === "string" && isIsoDate(raw)) return { ok: true, value: raw };
      return {
        ok: false,
        message: "expected an ISO date (YYYY-MM-DD) or ISO datetime",
      };
    }
  }
}

/**
 * Validate + coerce raw inputs against a declaration. The shared entry
 * point for the REST handler (query-string record) and the MCP tool
 * dispatch (JSON arguments). `null` counts as absent (MCP clients send
 * explicit nulls for omitted optionals).
 */
export function parseParams(decl: ParamsDecl, raw: Record<string, unknown>): ParseParamsResult {
  const issues: ParamIssue[] = [];
  const params: Record<string, unknown> = {};

  for (const key of Object.keys(raw)) {
    if (!(key in decl)) issues.push({ param: key, message: "unknown parameter" });
  }

  for (const [name, spec] of Object.entries(decl)) {
    const { type, optional } = parseParamSpec(name, spec);
    const value = raw[name];
    if (value === undefined || value === null) {
      if (!optional) issues.push({ param: name, message: "required" });
      continue;
    }
    const result = coerce(type, value);
    if (result.ok) {
      params[name] = result.value;
    } else {
      issues.push({ param: name, message: result.message });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, params };
}

/** The generated JSON-Schema shape for an MCP tool's `inputSchema`. */
export interface ParamsJsonSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean"; description?: string }>;
  required: string[];
  additionalProperties: false;
}

/**
 * Derive the MCP tool `inputSchema` from a declaration — the "one
 * definition, two projections" guarantee made literal: the schema an AI
 * client sees is GENERATED from the same record the REST endpoint
 * validates with, so they can never drift.
 */
export function paramsJsonSchema(decl: ParamsDecl): ParamsJsonSchema {
  const properties: ParamsJsonSchema["properties"] = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(decl)) {
    const { type, optional } = parseParamSpec(name, spec);
    properties[name] =
      type === "date"
        ? { type: "string", description: "ISO date (YYYY-MM-DD) or ISO datetime" }
        : { type };
    if (!optional) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
