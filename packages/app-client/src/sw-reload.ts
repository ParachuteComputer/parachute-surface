/**
 * `reloadAfterServiceWorkerUpdate` — wire `controllerchange` + a
 * fallback timeout so the page reloads once the waiting SW activates.
 *
 * Why this is its own helper: vite-plugin-pwa's `useRegisterSW`
 * already registers a `controlling` listener inside
 * `showSkipWaitingPrompt`, but in real PWAs that event can be missed —
 * listener attached after the activation already fired, iOS
 * standalone quirks, BFCache restores re-using a controller without
 * re-firing controllerchange. When that happens, clicking the Reload
 * button appears to do nothing.
 *
 * Lifted from `parachute-notes/src/lib/pwa.ts` so future PWA-mode apps
 * (any app with `pwa: true` in meta.json) inherit Notes' load-bearing
 * reload behavior without copying the file.
 *
 * Wire this BEFORE calling `updateServiceWorker(true)` so the listener
 * is armed when the SW transitions. Idempotent within a page load: a
 * second call is a no-op so a stray re-click can't queue multiple
 * reloads racing each other.
 */

/**
 * How long to wait for `controllerchange` after `skipWaiting` before
 * giving up and forcing a reload anyway. 2.5s comfortably covers a
 * fast activate-and-claim, but is short enough that the user isn't
 * left staring at a banner that "did nothing" if the event path
 * silently fails.
 */
export const SW_RELOAD_FALLBACK_MS = 2500;

let reloadArmed = false;

export interface ReloadAfterSWUpdateOpts {
  fallbackMs?: number;
  reload?: () => void;
  serviceWorker?: ServiceWorkerContainer | null;
}

export function reloadAfterServiceWorkerUpdate(opts: ReloadAfterSWUpdateOpts = {}): void {
  if (reloadArmed) return;
  reloadArmed = true;

  const reload =
    opts.reload ??
    (() => {
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    });
  const sw =
    opts.serviceWorker ??
    (typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null);
  const fallbackMs = opts.fallbackMs ?? SW_RELOAD_FALLBACK_MS;

  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    reload();
  };

  if (sw) {
    sw.addEventListener("controllerchange", fire, { once: true });
  }

  // Hard fallback — if controllerchange never fires (event missed, SW
  // path disabled, browser quirk), the user still gets a reload.
  setTimeout(fire, fallbackMs);
}

/**
 * Test-only: reset the module-level "reload armed" flag so individual
 * test cases start from a clean state. Mirrors Notes' equivalent.
 */
export function __resetReloadArmedForTests(): void {
  reloadArmed = false;
}
