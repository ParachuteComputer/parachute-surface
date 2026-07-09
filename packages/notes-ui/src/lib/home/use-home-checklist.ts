/**
 * React binding over the per-vault checklist state (see `./checklist`).
 *
 * Reads the persisted state on mount (keyed by vault id, so switching vaults
 * re-reads the right blob) and writes back on every change. State lives in
 * localStorage, not the vault, so it works identically across the cloud and
 * self-host doors.
 */

import { useCallback, useEffect, useState } from "react";
import {
  type HomeChecklistState,
  type HomeStepId,
  loadChecklistState,
  saveChecklistState,
} from "./checklist";

export interface UseHomeChecklist {
  state: HomeChecklistState;
  /** Tick / untick a manual step. */
  setOverride: (step: HomeStepId, done: boolean) => void;
  /** Close the whole checklist — persisted, never resurrected. */
  dismiss: () => void;
}

export function useHomeChecklist(vaultId: string | null): UseHomeChecklist {
  const [state, setState] = useState<HomeChecklistState>(() =>
    vaultId ? loadChecklistState(vaultId) : { dismissed: false, overrides: {} },
  );

  // Re-read when the active vault changes — each vault has its own checklist.
  useEffect(() => {
    setState(vaultId ? loadChecklistState(vaultId) : { dismissed: false, overrides: {} });
  }, [vaultId]);

  const persist = useCallback(
    (next: HomeChecklistState) => {
      setState(next);
      if (vaultId) saveChecklistState(vaultId, next);
    },
    [vaultId],
  );

  const setOverride = useCallback(
    (step: HomeStepId, done: boolean) => {
      setState((cur) => {
        const next: HomeChecklistState = {
          ...cur,
          overrides: { ...cur.overrides, [step]: done },
        };
        if (vaultId) saveChecklistState(vaultId, next);
        return next;
      });
    },
    [vaultId],
  );

  const dismiss = useCallback(() => {
    persist({ ...state, dismissed: true });
  }, [persist, state]);

  return { state, setOverride, dismiss };
}
