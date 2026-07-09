/**
 * PWA install affordance — the shared read of "can this platform install the
 * app, and how".
 *
 * Several surfaces consume this at once (the header `InstallPrompt`, the home
 * quick-action card, the setup checklist) — and `beforeinstallprompt` is a
 * ONE-SHOT event that does NOT replay. A per-component listener only catches it
 * if that component was already mounted when it fired, so a second consumer
 * that mounts later (e.g. an install button revealed by the first consumer's
 * state flipping) would never see it and would render as "unsupported".
 *
 * So the capture lives at MODULE SCOPE: one listener, wired once at import,
 * stashes the deferred event in a shared store that every hook instance reads
 * and subscribes to. Consuming the prompt clears the shared event for everyone
 * (it's single-use — a stale copy in a sibling instance would silently no-op).
 *
 *   - `installed`   — already running standalone (installed PWA). Nothing to do.
 *   - `available`   — installable now: either the browser fired
 *                     `beforeinstallprompt` (Chromium) or we're on iOS Safari
 *                     (manual Add-to-Home-Screen, no programmatic prompt).
 *   - `unsupported` — no install path on this platform/browser. Callers HIDE
 *                     the affordance here (per the design mandate: show the
 *                     install action only where the platform supports it).
 */

import { type BeforeInstallPromptEvent, isIOS, isStandalone } from "@/lib/pwa";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type InstallState = "installed" | "available" | "unsupported";

export interface InstallAffordance {
  state: InstallState;
  /** True on iOS Safari, where install is a manual Share → Add to Home Screen. */
  isIOSDevice: boolean;
  /**
   * Trigger the native install prompt when one is deferred. Returns:
   *   - `"accepted"` / `"dismissed"` — the user's choice on a real prompt,
   *   - `"unavailable"` — no deferred prompt (iOS, or not yet installable); the
   *     caller shows its own manual hint (e.g. the iOS instructions dialog).
   */
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
}

// --- Module-scope singleton -------------------------------------------------
// The single source of truth every hook instance shares. `beforeinstallprompt`
// fires once, early, and doesn't replay — capturing it here (not per-component)
// is what lets a late-mounting consumer still see it.
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let appWasInstalled = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function onBeforeInstallPrompt(e: Event): void {
  // Suppress the browser's own mini-infobar; we drive the prompt from our UI.
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  notify();
}

function onAppInstalled(): void {
  deferredPrompt = null;
  appWasInstalled = true;
  notify();
}

let wired = false;
function ensureWired(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.addEventListener("appinstalled", onAppInstalled);
}
ensureWired();

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Test hook: clear the captured event + installed flag between cases (the
 * module singleton otherwise persists across tests in the same file). */
export function __resetInstallAffordanceForTests(): void {
  deferredPrompt = null;
  appWasInstalled = false;
  notify();
}

export function useInstallAffordance(): InstallAffordance {
  // Both derive from the shared store — every instance sees the same event.
  const deferred = useSyncExternalStore(
    subscribe,
    () => deferredPrompt,
    () => null,
  );
  const installedByEvent = useSyncExternalStore(
    subscribe,
    () => appWasInstalled,
    () => false,
  );

  // Platform sniffing is per-instance but stable; measured on mount so we don't
  // flash the install CTA on an already-installed PWA before first paint.
  const [platform, setPlatform] = useState<{ standalone: boolean; ios: boolean }>({
    standalone: true,
    ios: false,
  });
  useEffect(() => {
    setPlatform({ standalone: isStandalone(), ios: isIOS() });
  }, []);

  const standalone = platform.standalone || installedByEvent;
  const state: InstallState = standalone
    ? "installed"
    : deferred !== null || platform.ios
      ? "available"
      : "unsupported";

  const promptInstall = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    // Read the live singleton (not the render snapshot) so the most recent
    // event is used.
    const evt = deferredPrompt;
    if (!evt) return "unavailable";
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      return choice.outcome;
    } catch {
      // A beforeinstallprompt event's prompt() is single-use — a second call
      // (e.g. a double click, or a stale copy in a sibling instance) rejects.
      // Swallow it; the finally below drops the spent event so the UI stops
      // offering a prompt that can't fire.
      return "unavailable";
    } finally {
      // Clear on ANY outcome (accepted OR dismissed) — the event is spent once
      // prompt() has been called, so keeping it around would let a retry
      // silently no-op against a used event. A fresh beforeinstallprompt
      // re-arms the affordance if the browser offers again.
      if (deferredPrompt === evt) {
        deferredPrompt = null;
        notify();
      }
    }
  }, []);

  return { state, isIOSDevice: platform.ios, promptInstall };
}
