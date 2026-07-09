/**
 * PWA install affordance — the shared read of "can this platform install the
 * app, and how".
 *
 * Two surfaces consume this: the header `InstallPrompt` button and the home
 * setup checklist. Both need the same three-state answer, so the
 * `beforeinstallprompt` capture + standalone/iOS sniffing lives here once
 * rather than being re-wired per component.
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
import { useEffect, useState } from "react";

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

export function useInstallAffordance(): InstallAffordance {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  // Assume standalone until the mount effect measures — avoids a flash of the
  // install CTA on an already-installed PWA before the first paint settles.
  const [standalone, setStandalone] = useState(true);
  const [iosDevice, setIosDevice] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());
    setIosDevice(isIOS());
    const onPrompt = (e: Event) => {
      // Keep the browser from showing its own mini-infobar; we drive the
      // prompt from our button instead.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const state: InstallState = standalone
    ? "installed"
    : deferred !== null || iosDevice
      ? "available"
      : "unsupported";

  const promptInstall = async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    if (!deferred) return "unavailable";
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setDeferred(null);
    return choice.outcome;
  };

  return { state, isIOSDevice: iosDevice, promptInstall };
}
