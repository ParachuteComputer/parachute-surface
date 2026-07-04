/**
 * Voice-retention transparency (the audio_retention dial).
 *
 * Users should know — and choose — whether their voice recordings are kept
 * or deleted after transcription. The dial itself is server-side vault
 * config (`config.audio_retention` on `GET/PATCH /api/vault`, identical on
 * the self-host and cloud doors); this module is the surfacing:
 *
 *   - `useAudioRetention()` — the current value, read from the SAME cached
 *     `/api/vault` response `useVaultInfo` already fetches (no new network
 *     call; requirement pinned by test). Absent `config` = an older
 *     self-host vault that predates the dial → treat as `keep`, and report
 *     `supported: false` so no control silently no-ops against it.
 *   - `useSetAudioRetention()` — PATCHes the dial and verifies the echo
 *     (old vaults accept-and-ignore `config`; a missing echo is surfaced
 *     as an error rather than a phantom success).
 *   - the per-vault "choice made" flag — localStorage, following the
 *     `lens:path-tree:<vaultId>` pattern. Records that THIS browser has
 *     offered (and the user answered) the first-voice-capture choice, so
 *     the inline prompt in NoteNew is one-time. Deliberately local-only:
 *     the server can't distinguish "explicitly chose keep" from
 *     "default keep", and a per-device re-offer is the honest fallback.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useActiveVaultClient, useVaultInfo } from "./queries";
import { useVaultStore } from "./store";
import { type AudioRetention, type VaultInfoWithConfig, isAudioRetention } from "./types";

export const DEFAULT_AUDIO_RETENTION: AudioRetention = "keep";

const CHOICE_PREFIX = "lens:audio-retention-choice:";

function keyFor(vaultId: string): string {
  return CHOICE_PREFIX + vaultId;
}

/** Has this browser recorded a retention choice for this vault? */
export function loadRetentionChoiceMade(vaultId: string): boolean {
  try {
    return localStorage.getItem(keyFor(vaultId)) !== null;
  } catch {
    return false;
  }
}

export function markRetentionChoiceMade(vaultId: string): void {
  try {
    localStorage.setItem(keyFor(vaultId), JSON.stringify({ chosenAt: new Date().toISOString() }));
  } catch {
    // storage unavailable — best-effort only; the choice re-offers next time.
  }
}

export function clearRetentionChoice(vaultId: string): void {
  try {
    localStorage.removeItem(keyFor(vaultId));
  } catch {
    // storage unavailable — best-effort only
  }
}

/**
 * React handle on the per-vault choice flag. State-backed so marking the
 * choice made hides the prompt in the same render pass (localStorage alone
 * wouldn't re-render).
 */
export function useRetentionChoiceMade(vaultId: string | null): {
  made: boolean;
  markMade: () => void;
} {
  const [made, setMade] = useState<boolean>(() =>
    vaultId ? loadRetentionChoiceMade(vaultId) : false,
  );

  useEffect(() => {
    setMade(vaultId ? loadRetentionChoiceMade(vaultId) : false);
  }, [vaultId]);

  const markMade = useCallback(() => {
    if (!vaultId) return;
    markRetentionChoiceMade(vaultId);
    setMade(true);
  }, [vaultId]);

  return { made, markMade };
}

export interface AudioRetentionState {
  /** Effective value. Absent config (older vault) reads as the server default, `keep`. */
  value: AudioRetention;
  /**
   * True when `/api/vault` answered WITH a `config` block — i.e. the vault
   * actually has the dial. False for older self-host vaults (which would
   * accept-and-ignore a PATCH) and while loading/errored.
   */
  supported: boolean;
  /** `/api/vault` hasn't answered yet. */
  isLoading: boolean;
  /** `/api/vault` failed — don't claim "unsupported", say "couldn't load". */
  isError: boolean;
}

/**
 * Current audio-retention value, piggybacked on the cached `useVaultInfo`
 * query — the config block rides the same `/api/vault` response the app
 * already fetches. Never issues its own network call.
 */
export function useAudioRetention(): AudioRetentionState {
  const info = useVaultInfo();
  const raw = info.data?.config?.audio_retention;
  return {
    value: isAudioRetention(raw) ? raw : DEFAULT_AUDIO_RETENTION,
    supported: info.isSuccess && info.data?.config !== undefined,
    isLoading: info.isPending,
    isError: info.isError,
  };
}

/**
 * PATCH the vault's audio-retention dial. On success, merges the echoed
 * `config` into the cached `["vaultInfo", <vault>]` entry (the PATCH
 * response carries `{ name, description, config }` but not
 * `transcription`/`stats`, so a merge — not a replace — keeps the rest of
 * the cached read intact).
 *
 * Old-vault honesty: a vault that predates the dial answers the PATCH
 * 200 but ignores `config` (no echo). That is surfaced as an error —
 * a control that silently no-ops would be a lie about the user's data.
 */
export function useSetAudioRetention() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (value: AudioRetention): Promise<VaultInfoWithConfig> => {
      if (!client) throw new Error("No active vault");
      const res = await client.patchVault({ config: { audio_retention: value } });
      if (res.config?.audio_retention !== value) {
        throw new Error("This vault doesn't support changing voice retention yet.");
      }
      return res;
    },
    onSuccess: (res) => {
      qc.setQueryData<VaultInfoWithConfig>(["vaultInfo", activeId], (old) =>
        old ? { ...old, config: res.config } : old,
      );
    },
  });
}
