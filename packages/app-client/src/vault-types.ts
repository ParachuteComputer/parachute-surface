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
