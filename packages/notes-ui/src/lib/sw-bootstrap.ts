/**
 * Service-worker bootstrap gating for the Notes UI bundle.
 *
 * Why this file exists:
 *
 *   notes-ui 0.1.1 introduced runtime mount detection — the same built
 *   `dist/` works at any mount path (`/notes/`, `/surface/notes/`,
 *   `/surface/<custom-slug>/`). Asset URLs, the React Router basename, and
 *   the OAuth redirect URI all rebase at runtime via `detectMountBase()`.
 *
 *   But the service worker and PWA manifest are baked at *build time*.
 *   The manifest's `start_url`/`scope` and the SW's precache manifest
 *   (every `/notes/index.html`, `/notes/assets/...` entry) are hard
 *   `/notes/`-scoped in the default build. When the same bundle gets
 *   mounted at `/surface/notes/`, the React app loads and routes work — but
 *   then `useRegisterSW()` registers the SW *with the page's current
 *   scope* (`/surface/notes/`), and the SW immediately starts intercepting
 *   every fetch under that scope. The precache table doesn't contain
 *   `/surface/notes/...` entries; navigations fall through to workbox's
 *   navigation route which serves `/notes/index.html` (HTML) for a
 *   request that the importing browser expected to be a JS module or a
 *   JSON manifest.
 *
 *   Result (Aaron's report 2026-05-23):
 *     - workbox throws `non-precached-url :: /notes/index.html`
 *     - browser logs `Failed to load module script: Expected
 *       JavaScript-or-Wasm module, got "text/html"`
 *     - manifest fetch fails JSON parse
 *     - OAuth callback navigation breaks because the SW intercepts the
 *       fetch and returns the wrong document
 *
 *   The right fix is mount-aware build-time PWA assets, but that needs
 *   a parachute-surface manifest-rewrite hook + multi-scope SW generation —
 *   non-trivial work. The immediate fix is to gate registration: if the
 *   runtime mount doesn't match the build-time vite base, don't
 *   register the SW at all, and unregister any stale registration left
 *   over from a previous version that didn't gate.
 *
 *   PWA "Add to Home Screen" therefore remains a build-time-pinned
 *   feature (already acknowledged in 0.1.1's CHANGELOG). Operators who
 *   want PWA install at a non-default mount must build with
 *   `VITE_BASE_PATH=/surface/<name>`. In-browser use works at any mount
 *   from the default bundle, no SW interference.
 */

import { detectMountBase } from "./base-url";

/**
 * Pure normalisation of the build-time mount signals into the base the
 * service worker + PWA manifest were baked for. Extracted from `buildTimeBase`
 * so it can be unit-tested without stubbing `import.meta.env`.
 *
 * The load-bearing case is the **standalone origin-root deploy**
 * (notes.parachute.computer), whose build stamps `VITE_BASE_PATH="/"`.
 * `detectMountBase()` returns "" (origin root) for that build — so the
 * build-time base MUST also be "" or the SW gate (`runtime === build-time`,
 * see `shouldRegisterServiceWorker`) can never pass, and the installed PWA
 * gets no offline shell on cold start. We therefore special-case an explicit
 * `VITE_BASE_PATH === "/"` to "" BEFORE the generic normalisation below —
 * which otherwise folds a bare "/" into the legacy `/notes` default. That
 * generic fold is correct only when the "/" arrives via Vite's `BASE_URL`
 * on a bundled-host build (`base: ""` → `BASE_URL === "/"`) where
 * `VITE_BASE_PATH` is unset; there the runtime mount is `/notes` or
 * `/surface/<slug>` (never ""), so `/notes` is the right comparator.
 *
 * This mirrors `detectMountBase()`'s `STANDALONE_DEPLOY` branch
 * (`VITE_BASE_PATH === "/"` → "") so the two sides of the gate agree by
 * construction.
 */
export function resolveBuildTimeBase(
  viteBasePath: string | undefined,
  baseUrl: string | undefined,
): string {
  // Standalone deploy: explicit VITE_BASE_PATH="/" → origin-root mount "".
  if (viteBasePath === "/") return "";
  const raw = viteBasePath && viteBasePath.length > 0 ? viteBasePath : baseUrl;
  // When vite.config sets `base: ""`, BASE_URL becomes "/" — useless as a
  // mount comparator on a bundled-host build. Fall through to the legacy
  // default in that case.
  const normalised = !raw || raw === "" || raw === "/" ? "/notes/" : raw;
  return normalised.replace(/\/$/, "") || "/notes";
}

function buildTimeBase(): string {
  const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : undefined;
  const viteBasePath = env ? (env.VITE_BASE_PATH as string | undefined) : undefined;
  const baseUrl = env ? (env.BASE_URL as string | undefined) : undefined;
  return resolveBuildTimeBase(viteBasePath, baseUrl);
}

/** Frozen for downstream comparison + log lines. */
export const BUILD_TIME_BASE = buildTimeBase();

/**
 * Predicate: should the SW be registered for the current page?
 *
 * Returns true iff the runtime mount (via `detectMountBase()`) matches
 * the build-time base. When false, callers must short-circuit any
 * `registerSW` / `useRegisterSW` invocation.
 *
 * @param pathname  Optional pathname passed through to `detectMountBase`
 *                  for tests that need to assert specific mounts without
 *                  touching `window.location`.
 */
export function shouldRegisterServiceWorker(pathname?: string): boolean {
  const runtime = detectMountBase(pathname);
  return runtime === BUILD_TIME_BASE;
}

/**
 * Unregister any service worker whose registered scope doesn't match the
 * current runtime mount.
 *
 * The shape we're cleaning up after: a user on 0.1.1 or earlier installed
 * Notes via parachute-surface at `/surface/notes/`, the bundle auto-registered
 * the SW (build-time-scoped to `/notes/` via `vite.config.ts`'s `basePath`)
 * at `/surface/notes/`, and the SW now intercepts every fetch under
 * `/surface/notes/` with a precache table built for `/notes/`. Result: HTML
 * served for JS-module requests, MIME errors, broken OAuth callbacks.
 *
 * We unregister any SW whose normalised scope-pathname differs from the
 * runtime mount AND looks like a parachute mount we recognise
 * (`/notes` or `/surface/<slug>`). The "looks like ours" guard keeps us
 * from clobbering an unrelated SW that happens to be registered on the
 * same origin.
 *
 * Operators auto-recover on next page load: the stale SW unregisters,
 * the next reload is served fresh, and `shouldRegisterServiceWorker()`
 * declines to re-register at the wrong mount.
 *
 * @returns the number of registrations unregistered (for logging + tests).
 */
export async function cleanupStaleServiceWorker(
  navigatorRef: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
  pathname?: string,
): Promise<number> {
  if (!navigatorRef || !("serviceWorker" in navigatorRef)) return 0;
  const container = navigatorRef.serviceWorker;
  if (!container || typeof container.getRegistrations !== "function") return 0;
  const runtimeMount = detectMountBase(pathname);
  const registrations = await container.getRegistrations();
  let unregistered = 0;
  for (const registration of registrations) {
    try {
      const scopeUrl = new URL(registration.scope);
      const scopePath = scopeUrl.pathname.replace(/\/$/, "") || "/";
      if (scopePath === runtimeMount) continue;
      // Only touch SWs whose scope looks like a parachute mount we
      // recognise — be conservative about clobbering unrelated SWs on
      // the same origin.
      const looksLikeParachuteMount =
        /^\/notes$/.test(scopePath) || /^\/surface\/[a-z0-9][a-z0-9_-]*$/.test(scopePath);
      if (!looksLikeParachuteMount) continue;
      await registration.unregister();
      unregistered += 1;
      if (typeof console !== "undefined") {
        console.info(
          `[notes-ui] unregistered stale service worker at scope ${registration.scope} ` +
            `(runtime mount is ${runtimeMount})`,
        );
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(`[notes-ui] failed to inspect/unregister SW: ${String(err)}`);
      }
    }
  }
  return unregistered;
}
