/**
 * Typed notes-query builder — `NotesQuery` → the exact query-string grammar
 * vault's `parseNotesQueryOpts` parses (`parachute-vault/src/routes.ts`).
 *
 * `VaultClient.queryNotes` historically took `URLSearchParams |
 * Record<string, string>`, which forced every consumer to memorize the wire
 * grammar (`tag_match`, `meta[field][op]=…` brackets, comma-joined tag
 * lists…). `NotesQuery` is the typed alternative; the raw forms remain
 * accepted everywhere for back-compat and for grammar corners the type
 * doesn't model.
 *
 * Wire-format notes (each pinned by tests against the vault parser's
 * behavior):
 *
 *   - **`tag` / `exclude_tag` are comma-joined into ONE param** — vault's
 *     `parseQueryList` reads only the *first* occurrence of the param and
 *     splits on commas, so repeated `tag=` params would silently drop all
 *     but the first. (`extension` is the opposite: vault `getAll`s it, so
 *     we emit repeated params — values stay intact even with commas.)
 *   - **Metadata**: a scalar value serializes to the shorthand
 *     `meta[field]=value` (JSON-scan equality — works on *non-indexed*
 *     fields). An operator object serializes to `meta[field][op]=value`
 *     brackets, which route through the indexed generated column — vault
 *     raises `FIELD_NOT_INDEXED` if the field isn't declared in a tag
 *     schema. `in`/`not_in` use the `[]` array form
 *     (`meta[f][in][]=a&meta[f][in][]=b`) so values containing commas
 *     survive.
 *   - **Date filter**: serializes to the canonical bracket bridge
 *     `meta[<field>][gte]=from` / `meta[<field>][lt]=to` (half-open:
 *     `from` inclusive, `to` exclusive). The flat
 *     `date_field`/`date_from`/`date_to` params are deprecated vault-side
 *     (vault#288), so the builder never emits them.
 *   - **Unknown keys with string values pass through verbatim** — the
 *     escape hatch for grammar the type doesn't model (and the safety net
 *     for callers mixing typed keys with raw `meta[...]` params). Unknown
 *     keys with non-string values throw.
 */

import type { TagExpandMode } from "./vault-types.js";

/** Scalar metadata value — serialized with `String(...)`. */
export type MetadataScalar = string | number | boolean;

/**
 * Operator query on one (indexed) metadata field. Mirrors vault's engine
 * operators exactly. Multiple ops on one field AND together
 * (`{ gte: 1, lt: 5 }` → a range).
 */
export interface MetadataOps {
  eq?: MetadataScalar;
  ne?: MetadataScalar;
  gt?: MetadataScalar;
  gte?: MetadataScalar;
  lt?: MetadataScalar;
  lte?: MetadataScalar;
  in?: MetadataScalar[];
  not_in?: MetadataScalar[];
  exists?: boolean;
}

/**
 * Per-field metadata filter: a scalar (shorthand equality — JSON-scan, no
 * indexed-field declaration needed) or a {@link MetadataOps} object
 * (operator query — requires the field be indexed via a tag schema).
 */
export type MetadataFilter = MetadataScalar | MetadataOps;

/**
 * Date-range filter on the real `created_at` / `updated_at` columns.
 * Half-open by design: `from` is inclusive (`gte`), `to` is exclusive
 * (`lt`). One column per query — vault rejects spanning both.
 */
export interface NotesDateFilter {
  field: "created_at" | "updated_at";
  /** Inclusive lower bound (ISO timestamp). */
  from?: string;
  /** Exclusive upper bound (ISO timestamp). */
  to?: string;
}

/**
 * Typed notes query — accepted by `queryNotes` / `queryNotesCursor` /
 * `subscribe` alongside the raw `URLSearchParams | Record<string,string>`
 * forms. Covers vault's structured-query grammar; `search` (FTS) and
 * `near` (graph neighborhood) are deliberately *not* modeled here — they
 * are separate query shapes (and rejected for subscriptions); pass them
 * via the raw forms when needed.
 */
export interface NotesQuery {
  /** Tag filter. An array means multiple tags (see {@link NotesQuery.tagMatch}). */
  tag?: string | string[];
  /**
   * Multi-tag semantics: `"any"` (OR — vault's default for >1 tag) or
   * `"all"` (AND).
   */
  tagMatch?: "all" | "any";
  /**
   * Tag-expansion axis: `"subtypes"` (default — parent_names descendants),
   * `"namespace"` (slash-prefix children), `"both"`, or `"exact"`.
   */
  expand?: TagExpandMode;
  /** Exclude notes carrying any of these tags. */
  excludeTag?: string | string[];
  /** Filter on whether the note has any tags at all. */
  hasTags?: boolean;
  /** Filter on whether the note has any links. */
  hasLinks?: boolean;
  /** Exact path match. */
  path?: string;
  /** Path prefix match. */
  pathPrefix?: string;
  /** Extension filter — single value or any-of list. */
  extension?: string | string[];
  /**
   * Metadata filters, ANDed across fields. Scalar = shorthand equality
   * (non-indexed OK); object = operator query (field must be indexed).
   * Fields named `created_at`/`updated_at` route to the date-filter
   * bridge vault-side (only `gte`/`lt` allowed there) — prefer
   * {@link NotesQuery.date} for those.
   */
  metadata?: Record<string, MetadataFilter>;
  /** Date-range filter on `created_at` / `updated_at`. */
  date?: NotesDateFilter;
  /** Sort column (vault validates — non-indexed columns 400). */
  orderBy?: string;
  sort?: "asc" | "desc";
  limit?: number;
  offset?: number;
  /** Include full note content in list results (default false vault-side). */
  includeContent?: boolean;
  /**
   * `true`/`false` = all/none; a field list = only those metadata keys.
   */
  includeMetadata?: boolean | string[];
  includeLinks?: boolean;
  includeAttachments?: boolean;
  includeLinkCount?: boolean;
  linkCountDirection?: "both" | "outbound" | "inbound";
}

/** The raw query forms `queryNotes` has always accepted. */
export type RawNotesQuery = URLSearchParams | Record<string, string>;

/** Anything the query methods accept. */
export type NotesQueryInput = NotesQuery | RawNotesQuery;

const META_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "exists"]);

/**
 * Keys that only exist in the typed `NotesQuery` shape (their wire
 * equivalents are spelled differently). Used by {@link isNotesQuery} to
 * classify an all-string object: if any of these keys is present, the
 * object is a `NotesQuery`, not a raw wire-param record.
 */
const NOTES_QUERY_ONLY_KEYS = new Set([
  "tagMatch",
  "excludeTag",
  "pathPrefix",
  "orderBy",
  "linkCountDirection",
  "hasTags",
  "hasLinks",
  "includeContent",
  "includeMetadata",
  "includeLinks",
  "includeAttachments",
  "includeLinkCount",
  "date",
]);

/**
 * Classify a query input. `URLSearchParams` is always raw. A plain object
 * is a `NotesQuery` when any value is non-string (raw records are
 * string-valued by definition) or any key is typed-shape-only. All-string
 * objects without typed-only keys are treated as raw wire params
 * (back-compat) — for the overlapping keys (`tag`, `path`, `expand`,
 * `sort`, `limit`, …) the two interpretations serialize identically, so
 * the ambiguity is harmless.
 */
export function isNotesQuery(input: NotesQueryInput): input is NotesQuery {
  if (input instanceof URLSearchParams) return false;
  for (const value of Object.values(input)) {
    if (typeof value !== "string") return true;
  }
  return Object.keys(input).some((k) => NOTES_QUERY_ONLY_KEYS.has(k));
}

/**
 * Normalize any accepted query input to `URLSearchParams`. The shared
 * entry point for `queryNotes` / `queryNotesCursor` / `subscribe`.
 */
export function toNotesSearchParams(input: NotesQueryInput): URLSearchParams {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  if (isNotesQuery(input)) return buildNotesQuery(input);
  return new URLSearchParams(input);
}

function joinList(value: string | string[]): string {
  return Array.isArray(value) ? value.join(",") : value;
}

/**
 * Serialize a {@link NotesQuery} to the exact wire format vault parses.
 * See the module header for the grammar decisions; tests pin every field
 * against the literal param strings.
 */
export function buildNotesQuery(q: NotesQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (q.tag !== undefined) params.set("tag", joinList(q.tag));
  if (q.tagMatch !== undefined) params.set("tag_match", q.tagMatch);
  if (q.expand !== undefined) params.set("expand", q.expand);
  if (q.excludeTag !== undefined) params.set("exclude_tag", joinList(q.excludeTag));
  if (q.hasTags !== undefined) params.set("has_tags", String(q.hasTags));
  if (q.hasLinks !== undefined) params.set("has_links", String(q.hasLinks));
  if (q.path !== undefined) params.set("path", q.path);
  if (q.pathPrefix !== undefined) params.set("path_prefix", q.pathPrefix);
  if (q.extension !== undefined) {
    // Vault getAll()s `extension` — repeated params keep comma-bearing
    // values intact (unlike tag/exclude_tag, which are comma-grammar).
    for (const ext of Array.isArray(q.extension) ? q.extension : [q.extension]) {
      params.append("extension", ext);
    }
  }

  if (q.metadata !== undefined) {
    for (const [field, filter] of Object.entries(q.metadata)) {
      if (filter !== null && typeof filter === "object") {
        for (const [op, value] of Object.entries(filter)) {
          if (value === undefined) continue;
          if (!META_OPS.has(op)) {
            throw new TypeError(
              `buildNotesQuery: unknown metadata operator "${op}" on field "${field}" — supported: ${[...META_OPS].join(", ")}.`,
            );
          }
          if (op === "in" || op === "not_in") {
            if (!Array.isArray(value)) {
              throw new TypeError(
                `buildNotesQuery: metadata "${field}".${op} requires an array.`,
              );
            }
            // `[]` array form (not the comma form) — values containing
            // commas survive.
            for (const v of value) params.append(`meta[${field}][${op}][]`, String(v));
          } else {
            params.set(`meta[${field}][${op}]`, String(value));
          }
        }
      } else {
        // Shorthand equality — JSON-scan, no indexed declaration required.
        params.set(`meta[${field}]`, String(filter));
      }
    }
  }

  if (q.date !== undefined) {
    // Canonical bracket bridge (flat date_field/date_from/date_to are
    // deprecated vault-side). gte = inclusive from, lt = exclusive to.
    if (q.date.from !== undefined) params.set(`meta[${q.date.field}][gte]`, q.date.from);
    if (q.date.to !== undefined) params.set(`meta[${q.date.field}][lt]`, q.date.to);
  }

  if (q.orderBy !== undefined) params.set("order_by", q.orderBy);
  if (q.sort !== undefined) params.set("sort", q.sort);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.offset !== undefined) params.set("offset", String(q.offset));

  if (q.includeContent !== undefined) params.set("include_content", String(q.includeContent));
  if (q.includeMetadata !== undefined) {
    params.set(
      "include_metadata",
      Array.isArray(q.includeMetadata) ? q.includeMetadata.join(",") : String(q.includeMetadata),
    );
  }
  if (q.includeLinks !== undefined) params.set("include_links", String(q.includeLinks));
  if (q.includeAttachments !== undefined) {
    params.set("include_attachments", String(q.includeAttachments));
  }
  if (q.includeLinkCount !== undefined) {
    params.set("include_link_count", String(q.includeLinkCount));
  }
  if (q.linkCountDirection !== undefined) {
    params.set("link_count_direction", q.linkCountDirection);
  }

  // Unknown keys: string values pass through verbatim (escape hatch for
  // grammar corners the type doesn't model — raw `meta[...]`, `search`,
  // `near[...]`, future params). Non-string unknowns are a shape error.
  for (const [key, value] of Object.entries(q)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (typeof value === "string") {
      params.set(key, value);
    } else if (value !== undefined) {
      throw new TypeError(
        `buildNotesQuery: unknown key "${key}" must be a string to pass through verbatim (got ${typeof value}).`,
      );
    }
  }

  return params;
}

const KNOWN_KEYS = new Set([
  "tag",
  "tagMatch",
  "expand",
  "excludeTag",
  "hasTags",
  "hasLinks",
  "path",
  "pathPrefix",
  "extension",
  "metadata",
  "date",
  "orderBy",
  "sort",
  "limit",
  "offset",
  "includeContent",
  "includeMetadata",
  "includeLinks",
  "includeAttachments",
  "includeLinkCount",
  "linkCountDirection",
]);
