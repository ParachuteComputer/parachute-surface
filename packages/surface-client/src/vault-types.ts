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

export interface VaultInfo {
  name: string;
  description: string;
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

export interface UpdateNotePayload {
  content?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  tags?: { add?: string[]; remove?: string[] };
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
