/**
 * Setup-checklist state for the guided home.
 *
 * Persisted PER VAULT in localStorage — Notes serves both the cloud and
 * self-host doors, so this leans on no cloud-only API. The stored shape is
 * deliberately tiny: only what can't be honestly derived from the vault.
 *
 *   - `dismissed`  — the user closed the whole checklist. Never resurrect it
 *                    (guidance is dismissible; the door is never a manual).
 *   - `overrides`  — manual "mark done" ticks. Two of the four steps aren't
 *                    reliably detectable client-side (connecting an AI, and
 *                    importing vs. authoring notes), so the user can tick them
 *                    off by hand; the tick is what we persist.
 *
 * The other two steps auto-complete from live signals (a real note exists; the
 * app is running installed) and are NEVER faked — see `deriveSteps`.
 */

import type { Note } from "@/lib/vault/types";

// A step's completion is either auto-detected from vault/platform state or
// ticked by hand. `write` + `install` carry an honest auto signal; `connect` +
// `import` are manual-only (not client-detectable).
export type HomeStepId = "write" | "connect" | "import" | "install";

export const HOME_STEP_IDS: readonly HomeStepId[] = ["write", "connect", "import", "install"];

export interface HomeChecklistState {
  dismissed: boolean;
  overrides: Partial<Record<HomeStepId, boolean>>;
}

export const EMPTY_CHECKLIST_STATE: HomeChecklistState = { dismissed: false, overrides: {} };

const KEY_PREFIX = "notes:home-checklist:";

function storageKey(vaultId: string): string {
  return KEY_PREFIX + vaultId;
}

export function loadChecklistState(vaultId: string): HomeChecklistState {
  try {
    const raw = localStorage.getItem(storageKey(vaultId));
    if (!raw) return { dismissed: false, overrides: {} };
    const parsed = JSON.parse(raw) as Partial<HomeChecklistState>;
    if (!parsed || typeof parsed !== "object") return { dismissed: false, overrides: {} };
    // Keep only known step ids with boolean values — defends the reducer below
    // against a hand-edited or forward-version localStorage blob.
    const overrides: Partial<Record<HomeStepId, boolean>> = {};
    if (parsed.overrides && typeof parsed.overrides === "object") {
      for (const id of HOME_STEP_IDS) {
        const v = (parsed.overrides as Record<string, unknown>)[id];
        if (typeof v === "boolean") overrides[id] = v;
      }
    }
    return { dismissed: parsed.dismissed === true, overrides };
  } catch {
    return { dismissed: false, overrides: {} };
  }
}

export function saveChecklistState(vaultId: string, state: HomeChecklistState): void {
  try {
    localStorage.setItem(storageKey(vaultId), JSON.stringify(state));
  } catch {
    // storage unavailable (private mode / quota) — best-effort only.
  }
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

// Seed content the vault ships on creation is tagged `#guide` (the vault's
// skill-file tag; see parachute-vault core/src/seed-packs.ts). System notes
// (Notes' own settings) live under `.parachute/`. Neither counts as the user
// authoring a note.
const SEED_GUIDE_TAG = "guide";
const SYSTEM_PATH_PREFIX = ".parachute/";

/**
 * Does the vault hold at least one note the *user* authored (or imported) —
 * i.e. a note that isn't a shipped seed guide and isn't an app-internal system
 * note? This is the honest signal behind the "write your first note" step:
 * seed guides are real notes, but they were there before the user did anything.
 */
export function hasUserAuthoredNote(notes: readonly Note[] | undefined): boolean {
  if (!notes) return false;
  return notes.some((n) => {
    if ((n.tags ?? []).includes(SEED_GUIDE_TAG)) return false;
    if (n.path?.startsWith(SYSTEM_PATH_PREFIX)) return false;
    return true;
  });
}

export interface StepSignals {
  /** A user-authored (non-seed, non-system) note exists. */
  hasUserNote: boolean;
  /** The app is running as an installed standalone PWA. */
  installed: boolean;
  /** An install path exists on this platform (prompt available or iOS). */
  installable: boolean;
}

export interface DerivedStep {
  id: HomeStepId;
  done: boolean;
  /** Auto-detected steps show no manual checkbox — done is a fact, not a claim. */
  auto: boolean;
}

/**
 * Fold persisted state + live signals into the four steps' done/auto shape.
 *
 *   - `write`   auto — done when a user note exists (or the user ticked it).
 *   - `connect` manual — not client-detectable; done only when ticked.
 *   - `import`  manual — can't be told apart from authoring; done only when ticked.
 *   - `install` auto — done when standalone (or ticked). OMITTED entirely when
 *                the platform offers no install path and isn't already
 *                installed (nothing to guide toward — hide, don't nag).
 */
export function deriveSteps(state: HomeChecklistState, signals: StepSignals): DerivedStep[] {
  const steps: DerivedStep[] = [
    { id: "write", auto: true, done: signals.hasUserNote || state.overrides.write === true },
    { id: "connect", auto: false, done: state.overrides.connect === true },
    { id: "import", auto: false, done: state.overrides.import === true },
  ];
  // Only surface the install step where it can actually be acted on (or is
  // already satisfied) — an uninstallable desktop browser shouldn't carry a
  // permanently-incomplete row.
  if (signals.installed || signals.installable) {
    steps.push({
      id: "install",
      auto: true,
      done: signals.installed || state.overrides.install === true,
    });
  }
  return steps;
}

export function stepsComplete(steps: readonly DerivedStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}
