/**
 * Vault REST resource types — mirror parachute-notes' canonical shapes
 * (see `parachute-notes/src/lib/vault/types.ts`). The shapes match
 * vault's wire format byte-for-byte; consumers can swap a Notes-style
 * import for an app-client import without converting field names.
 *
 * Kept in `vault-types.ts` rather than the top-level `types.ts` because
 * the OAuth types in `types.ts` are framework-agnostic; vault types
 * model one specific resource server.
 */

/**
 * Tag-expansion axis on notes queries (vault's `?expand=` param):
 * `"subtypes"` (default — parent_names descendants), `"namespace"`
 * (slash-prefix children), `"both"`, `"exact"`. Mirrors vault's
 * `TAG_EXPAND_MODES` (`core/src/tag-hierarchy.ts`).
 */
export type TagExpandMode = "subtypes" | "namespace" | "both" | "exact";

/**
 * Voice-transcription capability flag — whether the vault can actually
 * transcribe audio, which is what a surface gates its mic affordance on.
 * Distinct from the `auto_transcribe` POLICY toggle in vault config.
 *
 * Where each door serves it (they differ — verified 2026-07-03):
 *   - self-host vault: `GET /vault/<name>/api/vault` →
 *     `{ enabled, provider? }` (parachute-vault vault#529,
 *     `src/transcription/capability.ts`)
 *   - cloud vault: the BARE landing `GET /vault/<name>` →
 *     `{ enabled, minutes_remaining }` (parachute-cloud cloud#56,
 *     `workers/vault/src/vault-do.ts`); cloud's `/api/vault` does NOT
 *     carry it.
 *
 * Absent everywhere = an older vault that predates the flag — treat as
 * "undeclared", not "disabled".
 */
export interface TranscriptionCapability {
  /** True when the vault can transcribe (provider configured/plan entitled). */
  enabled: boolean;
  /** Self-host: the active provider's name (e.g. "scribe-http"). Omitted when disabled. */
  provider?: string;
  /** Cloud: monthly voice-minutes remaining on the plan meter (0 when disabled). */
  minutes_remaining?: number;
}

export interface VaultInfo {
  name: string;
  description: string;
  /** Present on self-host vaults ≥ vault#529; absent on older vaults and on cloud's `/api/vault`. */
  transcription?: TranscriptionCapability;
  stats?: {
    noteCount: number;
    tagCount: number;
    linkCount: number;
  };
}

export interface Note {
  id: string;
  path?: string;
  createdAt: string;
  updatedAt?: string;
  /**
   * Write-attribution (vault#298) — two axes of provenance, both nullable.
   * `*By` is the principal (a JWT `sub`, or an operator / `token:<id>`
   * label); `*Via` is the interface the write arrived through (`mcp`,
   * `surface:<name>`, `agent:<id>`, `operator`/`cli`, `api`). The
   * `created*` pair is set once at create; the `lastUpdated*` pair tracks
   * the most recent mutating write. `null` = unknown / written before
   * attribution existed (legacy rows) or by a path that carried no
   * context — distinct from any real principal. These are FACTUAL
   * provenance fields only — do not infer "human vs AI" from them; a
   * surface that wants to render that distinction maps known principals
   * to it separately.
   */
  createdBy?: string | null;
  createdVia?: string | null;
  lastUpdatedBy?: string | null;
  lastUpdatedVia?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  preview?: string;
  byteSize?: number;
  content?: string;
  links?: NoteLink[];
  attachments?: NoteAttachment[];
}

export interface NoteSummary {
  id: string;
  path?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  /** Write-attribution — see {@link Note.createdBy} for the full semantics. */
  createdBy?: string | null;
  createdVia?: string | null;
  lastUpdatedBy?: string | null;
  lastUpdatedVia?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NoteLink {
  sourceId: string;
  targetId: string;
  relationship: string;
  createdAt?: string;
  sourceNote?: NoteSummary;
  targetNote?: NoteSummary;
}

export interface NoteAttachment {
  id: string;
  noteId?: string;
  filename?: string;
  mimeType?: string;
  path?: string;
  url?: string;
  size?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TagSummary {
  name: string;
  count: number;
}

/**
 * Per-field declaration inside a tag-identity row. Mirrors vault's
 * `TagFieldSchema` (see `parachute-vault/src/config.ts`). `type` is a
 * free-form string at the wire level (vault accepts whatever the
 * operator declared) but in practice the values are `"string" |
 * "number" | "boolean" | "date" | ...`.
 */
export interface TagFieldSchema {
  type: string;
  description?: string;
  enum?: string[];
}

/**
 * Payload accepted by `PUT /api/tags/:name` — vault's tag-identity
 * upsert. Omitted keys preserve prior values; explicit `null` clears
 * them. The route is idempotent: replaying the same payload against a
 * vault that already has the tag is a no-op (vault re-writes the same
 * row).
 *
 * `fields` is merge-on-write — vault preserves prior field keys + only
 * overwrites the ones declared here. To wipe all fields, send
 * `fields: null` explicitly. See `parachute-vault/src/routes.ts:PUT
 * /tags/:name` for the canonical merge logic.
 */
export interface TagUpsertPayload {
  description?: string | null;
  fields?: Record<string, TagFieldSchema> | null;
  /**
   * Relationship vocabulary (one-to-one, one-to-many, etc.) — passed
   * through to vault opaquely. Used by tag-data-model patterns; apps
   * provisioning their own schema rarely set this.
   */
  relationships?: Record<string, unknown> | null;
  parent_names?: string[] | null;
}

/**
 * Tag-identity record returned by `GET /api/tags/:name` and the
 * envelope `PUT /api/tags/:name` returns on success. Mirrors the
 * fields vault stamps on the row.
 */
export interface TagRecord {
  name: string;
  count?: number;
  description?: string | null;
  fields?: Record<string, TagFieldSchema> | null;
  relationships?: Record<string, unknown> | null;
  parent_names?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * A typed-link addition (`PATCH /api/notes/:id` `links.add`). `target`
 * accepts a note id or path (vault resolves both); a missing target is
 * skipped silently (mirrors the MCP recipe — no error, no link).
 * `metadata` lands on the link row.
 */
export interface NoteLinkAddPayload {
  /** Target note id or path. */
  target: string;
  relationship: string;
  metadata?: Record<string, unknown>;
}

/**
 * A typed-link removal (`PATCH /api/notes/:id` `links.remove`). Missing
 * targets / non-existent links are skipped silently (idempotent set-op).
 * Removing a `"wikilink"` relationship also cleans the `[[brackets]]`
 * out of the note content vault-side.
 */
export interface NoteLinkRemovePayload {
  /** Target note id or path. */
  target: string;
  relationship: string;
}

export interface UpdateNotePayload {
  content?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  tags?: { add?: string[]; remove?: string[] };
  /**
   * Typed-link mutations, applied after the core update (a concurrency
   * conflict leaves links untouched). When present, vault echoes the
   * hydrated `links` array on the response so callers can confirm the
   * mutation without a follow-up GET. Shapes verified against vault's
   * PATCH handler (`parachute-vault/src/routes.ts`): `add` honors
   * per-link `metadata`; `remove` matches on (target, relationship).
   */
  links?: {
    add?: NoteLinkAddPayload[];
    remove?: NoteLinkRemovePayload[];
  };
  if_updated_at?: string;
  /**
   * Vault's PATCH /api/notes/:idOrPath enforces optimistic concurrency
   * by default — either `if_updated_at` or `force: true` is required.
   * `force` is the opt-out for writes where there's no baseline (e.g.
   * offline-queued settings writes that drain long after fetch).
   */
  force?: boolean;
}

export interface CreateNotePayload {
  content: string;
  path?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Typed links to create alongside the note. NOTE the shape difference
   * from `UpdateNotePayload.links`: vault's `POST /api/notes` create
   * branch takes a FLAT array (no `add`/`remove` envelope — there's
   * nothing to remove on a fresh note) and does NOT persist per-link
   * metadata on this path (verified against
   * `parachute-vault/src/routes.ts` — `store.createLink` is called
   * without the metadata argument). Need link metadata? Create first,
   * then `updateNote` with `links.add`. Missing targets skip silently.
   */
  links?: { target: string; relationship: string }[];
}

export interface StorageUploadResult {
  path: string;
  size: number;
  mimeType: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export type ReachabilitySignal = "healthy" | "unreachable";

/**
 * Result of `GET /api/find-path` — the BFS shortest-path between two
 * notes in the link graph. `path` is the sequence of note IDs from
 * source to target (inclusive at both ends); `relationships` is one
 * entry shorter — the link type traversed at each hop. Vault returns
 * `null` (no envelope) when no path is reachable within the depth
 * limit.
 */
export interface FindPathResult {
  path: string[];
  relationships: string[];
}
