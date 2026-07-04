/**
 * Notes-side OAuth/vault types.
 *
 * Phase 2 of the notes-migration-to-app arc (parachute-app#6, design doc
 * section 16): the OAuth + vault REST shapes that used to live here moved
 * to `@openparachute/surface-client` so other hosted apps don't re-roll them.
 * This module now re-exports the canonical types from app-client and
 * holds the small handful of Notes-specific extensions:
 *
 *   - `VaultRecord` — Notes' per-vault catalog row (URL + name + issuer +
 *     token-endpoint + client_id + scope + addedAt/lastUsedAt). Multi-
 *     vault is a Notes UX, not a general-purpose pattern; the record
 *     stays out of app-client.
 *   - `PendingOAuthState` — extends app-client's base shape with
 *     `priorHaltedVaultId`, the notes#148 round-trip channel that lets
 *     OAuthCallback clear an originally-halted vault's halt entry even
 *     when the new vault URL resolves to a different vaultIdFromUrl.
 *   - `isLegacyVaultUrl` — Notes-only guard for pre-PR-7 vault URLs (the
 *     vault project migrated `/vaults/<name>/` → `/vault/<name>/`; Notes
 *     still has old VaultRecords lying in localStorage that need to be
 *     re-added).
 */

import type { PendingOAuthState as BasePendingOAuthState } from "@openparachute/surface-client";

// Canonical OAuth + vault shapes live in app-client — re-export so existing
// import sites (`import type { Note, TagSummary, ... } from "@/lib/vault/types"`)
// keep working without per-file churn.
export type {
  AuthorizationServerMetadata,
  ClientRegistration,
  CreateNotePayload,
  Note,
  NoteAttachment,
  NoteLink,
  NoteSummary,
  ReachabilitySignal,
  ServiceCatalogEntry,
  ServicesCatalog,
  StorageUploadResult,
  StoredToken,
  TagFieldSchema,
  TagRecord,
  TagSummary,
  TagUpsertPayload,
  TokenResponse,
  TokenScope,
  TranscriptionCapability,
  UpdateNotePayload,
  UploadProgress,
  VaultInfo,
} from "@openparachute/surface-client";

import type {
  TranscriptionCapability as TranscriptionCapabilityShape,
  VaultInfo as VaultInfoShape,
} from "@openparachute/surface-client";

/**
 * The vault's audio-retention dial — what happens to a voice recording's
 * audio file after transcription. Identical wire contract on BOTH doors
 * (verified 2026-07-04): self-host `GET/PATCH /api/vault`
 * (parachute-vault `src/routes.ts:handleVault`) and cloud
 * (parachute-cloud `workers/vault/src/rest/vault.ts`) both carry
 * `config.audio_retention` with these values, defaulting to `"keep"`.
 *
 *   - `keep` (server default) — audio stored forever with the note.
 *   - `until_transcribed` — audio file deleted once the transcript lands;
 *     the note + transcript stay, the attachment row stays for history.
 *   - `never` — same deletion, and untranscribed audio is removed too
 *     (a failed transcription loses the audio).
 */
export const AUDIO_RETENTION_VALUES = ["keep", "until_transcribed", "never"] as const;
export type AudioRetention = (typeof AUDIO_RETENTION_VALUES)[number];

export function isAudioRetention(v: unknown): v is AudioRetention {
  return typeof v === "string" && (AUDIO_RETENTION_VALUES as readonly string[]).includes(v);
}

/**
 * The `config` block on `GET /api/vault` (both doors). Absent entirely on
 * older self-host vaults that predate the dial — absence means the vault
 * can't change retention (treat as `keep`, and don't offer a control that
 * would silently no-op).
 */
export interface VaultConfigInfo {
  audio_retention?: AudioRetention;
  auto_transcribe?: { enabled?: boolean };
}

/**
 * surface-client's `VaultInfo` plus the `config` block both doors already
 * return on `GET /api/vault` (surface-client's type predates it). Notes'
 * `VaultClient.vaultInfo` override narrows to this shape so `useVaultInfo`
 * consumers read `config` without casts.
 */
export interface VaultInfoWithConfig extends VaultInfoShape {
  config?: VaultConfigInfo;
}

/** Body for `PATCH /api/vault` — only the fields Notes actually writes. */
export interface PatchVaultPayload {
  description?: string;
  config?: { audio_retention?: AudioRetention };
}

/**
 * Bare vault landing (`GET <vaultUrl>`, no `/api` suffix) — the minimal
 * shape Notes reads from it. Cloud vaults carry the voice-transcription
 * capability HERE (not on `/api/vault`); self-host vaults answer the bare
 * landing too but without `transcription` (theirs lives on `/api/vault`).
 * See `useTranscriptionCapability` in `queries.ts` for the two-door read.
 */
export interface VaultLandingInfo {
  name?: string;
  description?: string | null;
  transcription?: TranscriptionCapabilityShape;
}

export interface VaultRecord {
  id: string;
  url: string;
  name: string;
  issuer: string;
  // Captured at connect time so refreshAccessToken doesn't have to re-run AS
  // discovery on every silent rotate. Optional only for forward-compat with
  // pre-hub-as-issuer records that may live in localStorage on first upgrade —
  // those records are pvt_*-token-only and won't refresh anyway.
  tokenEndpoint?: string;
  clientId: string;
  scope: string;
  addedAt: string;
  lastUsedAt: string;
}

/**
 * Notes' pending OAuth state — app-client's base shape plus
 * `priorHaltedVaultId` (notes#148). When the reconnect-from-banner path
 * begins an OAuth flow, it stashes the currently-halted vault id here so
 * OAuthCallback can clear THAT vault's halt entry on success, even when
 * the hub's token catalog now resolves the vault to a different URL
 * (different vaultIdFromUrl) — which would otherwise leave the original
 * halt orphaned in localStorage and the banner stuck on the next active
 * vault switch. Omitted for the cold connect flow from /add.
 *
 * `redirect` (notes#63) is the in-app path to land on after a successful
 * connect, replacing the default `/`. The hub `/account` "Import notes"
 * deep-link rides it through `/add?url=…&redirect=/import` so a first-time
 * user lands on the import screen with the freshly-connected vault. Always
 * a sanitized same-origin path (see `safeInternalRedirect`).
 */
export interface PendingOAuthState extends BasePendingOAuthState {
  priorHaltedVaultId?: string;
  redirect?: string;
}

// Vault PR 7 moved every endpoint under `/vault/<name>/`. Older stored
// VaultRecords whose URL is origin-only (or the previous `/vaults/<name>/`
// plural) won't reach the new endpoints and their tokens are invalid because
// vault's issuer changed. Detect them so the Vaults page can prompt re-add.
export function isLegacyVaultUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  return !(segments.length >= 2 && segments[0] === "vault");
}
