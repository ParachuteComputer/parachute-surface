/**
 * The Meeting MCP surface's domain projections (design P9) — the ONLY
 * thing this surface exposes.
 *
 * Each `defineProjection` declares ONE domain query and the kit derives
 * BOTH consumer faces from it (see `@openparachute/surface-server`'s
 * `createSurfaceProjections`):
 *
 *   - REST: `GET {mount}/api/<kebab-name>`
 *   - MCP:  a tool `<kebab-name>` on `{mount}/api/mcp` (stateless
 *           Streamable HTTP), `describe` → the tool description, the
 *           params declaration → the tool `inputSchema`.
 *
 * THE DISCLOSURE BOUNDARY (the whole point of this template): the only
 * data that ever leaves a projection is `notes.map(shape)`. The raw vault
 * note — its full body, its other tags, its path, every metadata field
 * the shape doesn't copy — NEVER rides out. A consumer (browser or AI)
 * sees domain vocabulary ("recent meetings"), curated to exactly the
 * fields the `shape` function returns. The `shape` functions below are
 * that boundary; `projections.test.ts` proves a raw field outside a shape
 * never appears in output.
 *
 * ACCESS — the one-line knob. Every projection here is `access: "public"`
 * (the end-user MCP use case: anyone may query the curated projection,
 * and the shape is the disclosure boundary). Flip any projection to
 * `access: "audience"` to require a link/capability session (a gated MCP),
 * or `"operator"` for hub-identity only. That single field changes BOTH
 * faces identically (the REST route declares it to the gateway; the MCP
 * endpoint filters its tool list + dispatch by the same predicate).
 *
 * RE-TARGETING this template at a different vault/tag — three edits:
 *   1. `meta.json` `vault_default` + `scopes_required` (the read scope the
 *      operator provisions, ideally narrowed to the meeting tag).
 *   2. `DEFAULT_TAG` below (or set the surface config `tag`).
 *   3. the `shape` functions, to match the domain's metadata vocabulary.
 * Nothing in the kit changes — that's the reusable seam.
 */

import {
  type Note,
  type ProjectionDefinition,
  defineProjection,
} from "@openparachute/surface-server";

/**
 * Default meeting tag. The team/project vault files meetings under
 * `capture/meeting`; an ingest surface (meeting-ingest) writes `meeting`
 * by default — set the surface config `tag` to align them, or query both.
 * (Vault tag matching expands subtypes by default; `expand: "exact"`
 * pins to the literal tag, the no-surprise choice for a read projection.)
 */
export const DEFAULT_TAG = "capture/meeting";

/** Default and hard cap for `recent-meetings`'s `limit` param. */
export const DEFAULT_RECENT_LIMIT = 20;
export const MAX_RECENT_LIMIT = 100;

/** A note value rendered as a trimmed string, or undefined when absent. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The meeting date for a note — `held_on` metadata, else the created date. */
function meetingDate(note: Note): string | undefined {
  return str(note.metadata?.held_on) ?? str(note.createdAt);
}

/** The display title — `title` metadata, else a stable fallback. */
function meetingTitle(note: Note): string {
  return str(note.metadata?.title) ?? "Untitled meeting";
}

/**
 * A short summary line for list shapes. Prefers a `summary` metadata
 * field, then the note's `preview` (vault's list-result excerpt), then
 * the first non-heading line of the body — never the whole body.
 */
function meetingSummary(note: Note): string | undefined {
  const explicit = str(note.metadata?.summary) ?? str(note.preview);
  if (explicit) return clip(explicit, 280);
  const body = str(note.content);
  if (!body) return undefined;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0 && !t.startsWith("#")) return clip(t, 280);
  }
  return undefined;
}

/** A query-centered snippet for search results. Falls back to the summary. */
function meetingSnippet(note: Note, query: string): string | undefined {
  const body = str(note.content);
  if (body && query.trim().length > 0) {
    const idx = body.toLowerCase().indexOf(query.trim().toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const slice = body
        .slice(start, idx + query.length + 120)
        .replace(/\s+/g, " ")
        .trim();
      return `${start > 0 ? "…" : ""}${slice}${start + slice.length < body.length ? "…" : ""}`;
    }
  }
  return meetingSummary(note);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build the projection set for a given working tag. Factored so the
 * server wires it once with the resolved config tag, and the tests wire
 * it with a known tag.
 */
export function buildProjections(tag: string = DEFAULT_TAG): ProjectionDefinition[] {
  return [
    // -- recent-meetings ---------------------------------------------------
    defineProjection({
      name: "recent-meetings",
      params: { limit: "number?" },
      query: (p) => {
        // Default + cap enforced HERE (the projection params layer validates
        // type/required, not domain bounds): floor 1, default 20, cap 100.
        const raw = typeof p.limit === "number" ? Math.floor(p.limit) : DEFAULT_RECENT_LIMIT;
        const limit = Math.max(1, Math.min(raw, MAX_RECENT_LIMIT));
        return {
          tag,
          expand: "exact",
          orderBy: "created_at",
          sort: "desc",
          limit,
          // Body is needed for the summary fallback; the SHAPE is what keeps
          // it from leaking (only a clipped first line ever rides out).
          includeContent: true,
        };
      },
      shape: (note) => ({
        id: note.id,
        title: meetingTitle(note),
        date: meetingDate(note),
        summary: meetingSummary(note),
      }),
      describe:
        "List recent meetings (most recent first). Optional `limit` (default 20, max 100). Returns each meeting's id, title, date, and a short summary — not the full transcript.",
      access: "public",
    }),

    // -- search-meetings ---------------------------------------------------
    defineProjection({
      name: "search-meetings",
      params: { query: "string" },
      query: (p) => ({
        tag,
        expand: "exact",
        // Full-text search WITHIN the meeting tag. `search` is a raw-form
        // passthrough (the typed NotesQuery doesn't model FTS); combined
        // with `tag`, vault scopes the search to meeting notes.
        search: String(p.query),
        includeContent: true,
        limit: MAX_RECENT_LIMIT,
      }),
      shape: (note, p) => ({
        id: note.id,
        title: meetingTitle(note),
        date: meetingDate(note),
        snippet: meetingSnippet(note, String(p.query)),
      }),
      describe:
        "Full-text search across meetings. Required `query`. Returns matching meetings' id, title, date, and a query-centered snippet — not the full transcript.",
      access: "public",
    }),

    // -- meeting (one) -----------------------------------------------------
    defineProjection({
      name: "meeting",
      params: { id: "string" },
      // The projection primitive runs `queryNotes` (a LIST query) — vault's
      // list endpoint has no by-vault-id filter, so "one meeting by id"
      // resolves the meeting's STABLE EXTERNAL id via `external_id` metadata
      // shorthand equality (the handle meeting-ingest writes, and the
      // natural public "meeting id"). 0-or-1 notes; the shape projects the
      // single curated subset. (P9-vs-brief note in the PR.)
      query: (p) => ({
        tag,
        expand: "exact",
        metadata: { external_id: String(p.id) },
        includeContent: true,
        limit: 1,
      }),
      shape: (note) => ({
        id: str(note.metadata?.external_id) ?? note.id,
        title: meetingTitle(note),
        date: meetingDate(note),
        attendees: str(note.metadata?.attendees),
        body: str(note.content),
      }),
      describe:
        "Fetch a single meeting by its id (the stable external id from `recent-meetings`/`search-meetings`). Returns id, title, date, attendees, and the meeting body.",
      access: "public",
    }),
  ];
}
