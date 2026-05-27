/**
 * Runtime mount-path detection for the Notes UI bundle.
 *
 * Why runtime, not build-time:
 *
 *   The same built `dist/` may be served at different mount paths
 *   depending on who hosts it:
 *
 *     - Legacy notes-daemon          → `/notes/`
 *     - parachute-surface (default name) → `/surface/notes/`
 *     - parachute-surface (custom slug)  → `/surface/<name>/`
 *
 *   Hard-coding `base: "/notes"` at Vite build time (the old shape)
 *   bakes asset URLs and the React Router basename into one mount —
 *   the bundle can't relocate without a rebuild. That's exactly the
 *   bug Aaron hit: the published 0.1.0 bundle 404'd / mis-routed when
 *   parachute-surface mounted it at `/surface/notes/`, because `<Router
 *   basename="/notes">` refused to match `/surface/notes/...` and the
 *   OAuth redirect URI registered with the AS pointed at the wrong
 *   path.
 *
 *   The fix: Vite emits relative asset URLs (`base: ""` → `./assets/
 *   ...`) which the browser resolves against the document's URL, and
 *   the SPA reads its own mount at runtime — either from a meta tag
 *   the host injects (canonical, delegated to `@openparachute/app-
 *   client`'s `getMountBase()`) or, for callers that pass an explicit
 *   pathname (currently sw-bootstrap), via a regex fallback against
 *   that pathname. Same bundle, any mount.
 *
 * Detection contract:
 *
 *   `detectMountBase()` returns a path WITHOUT a trailing slash, ready
 *   to feed React Router's `basename` and to prefix OAuth callback
 *   URLs. Recognised mount shapes (regex fallback for pathname-based
 *   callers):
 *
 *     - `/surface/<slug>` — parachute-surface hosts (the future-default)
 *     - `/notes`     — legacy notes-daemon host (preserved for
 *                       back-compat through notes-daemon's retirement)
 *
 *   Slug grammar matches parachute-surface's `meta-schema.ts` `PATH_PATTERN`
 *   (single segment of `[a-z0-9][a-z0-9_-]*`). Anything else falls
 *   back to `/notes` so an unmounted load (operator types the bare
 *   origin) still degrades into the historical default rather than
 *   blanking the router.
 *
 *   Server/test environments without a `<meta name="parachute-mount">`
 *   tag and without an explicit pathname return `/notes` — the legacy
 *   default — so tests that don't explicitly stub a path keep the
 *   pre-refactor behaviour.
 *
 *   Canonical path (meta-tag) delegates to `@openparachute/surface-client`'s
 *   `getMountBase()` so every Parachute app reads the runtime tenancy
 *   contract through the same library. The local regex fallback stays
 *   here for the pathname-passing callers (sw-bootstrap) — app-client's
 *   helper does not take a pathname; it reads the global `document`
 *   and returns `null` when no tag is present.
 */

import { getMountBase } from "@openparachute/surface-client";

/**
 * Recognised mount-prefix patterns. Order matters — most specific first.
 *
 *   - `/surface/<slug>`: parachute-surface hosts. Slug matches PATH_PATTERN
 *     in parachute-surface's meta-schema. The capture group is the full
 *     two-segment prefix (slash included) so the regex match returns
 *     `/surface/notes` directly.
 *   - `/notes`: legacy notes-daemon mount. Preserved as a recognised
 *     shape until notes-daemon is fully retired (Phase 4 of the
 *     migration arc per parachute.computer design doc §16).
 */
const MOUNT_PATTERNS: readonly RegExp[] = [
  /^(\/surface\/[a-z0-9][a-z0-9_-]*)(?=\/|$)/,
  /^(\/notes)(?=\/|$)/,
] as const;

/** Fallback when no recognised mount matches. Preserves the legacy default. */
const LEGACY_FALLBACK = "/notes" as const;

/**
 * Build-time signal for the standalone deploy (notes.parachute.computer).
 *
 * The deploy workflow at `.github/workflows/deploy-notes-ui.yml` sets
 * `VITE_BASE_PATH: "/"` before `vite build`. Vite exposes any `VITE_*`
 * env var via `import.meta.env`, so the built bundle carries the signal
 * forward into runtime. When set, BrowserRouter's basename must be
 * empty — every URL on notes.parachute.computer is at origin root with
 * no path prefix, so falling back to `/notes` would mismatch and
 * blank the router (Aaron hit exactly this on 2026-05-27 with
 * `<Router basename="/notes"> not able to match the URL "/"`).
 *
 * For bundled-host builds (parachute-surface's `surface-host` bundling
 * `@openparachute/notes-ui` under `/surface/notes/`), VITE_BASE_PATH
 * is unset → STANDALONE_DEPLOY is false → existing meta-tag + regex
 * detection runs as before.
 */
const STANDALONE_DEPLOY =
  typeof import.meta !== "undefined" &&
  import.meta.env != null &&
  (import.meta.env as { VITE_BASE_PATH?: string }).VITE_BASE_PATH === "/";

/**
 * Detect the mount path the SPA is served under at runtime.
 *
 * Two-tier resolution:
 *
 *   1. **Canonical** — `getMountBase()` from `@openparachute/surface-client`
 *      reads `<meta name="parachute-mount" content="/surface/<name>">` from
 *      the host-supplied document. This is the load-bearing path once
 *      parachute-surface injects the meta tag (shipped in app#25).
 *   2. **Pathname fallback** — when a `pathname` is supplied (sw-bootstrap
 *      passes one for the SW gate), regex-match against the recognised
 *      mount patterns. Without a pathname and without a meta tag, fall
 *      through to the legacy `/notes` default.
 *
 * Returns a path WITHOUT a trailing slash — the shape React Router's
 * `basename` and OAuth redirect URI building both expect.
 *
 * @param pathname  Optional pathname for the regex fallback. Tests
 *                  (and `sw-bootstrap.ts`) pass this directly without
 *                  monkey-patching `window.location`.
 * @param doc       Optional Document for the meta-tag check. Tests
 *                  inject a stub to exercise the canonical branch.
 */
export function detectMountBase(pathname?: string, doc?: Document): string {
  // 1. Canonical contract: meta tag, via app-client. When a `doc` stub
  //    is supplied, forward it; otherwise app-client reads the global
  //    document. Returns `null` when no tag is present. Highest priority
  //    so the same standalone bundle, if ever embedded inside a surface
  //    host that injects the meta tag, defers to the host's contract.
  const fromMeta = getMountBase({ doc });
  if (fromMeta) return fromMeta;

  // 2. Standalone-deploy build (notes.parachute.computer). The deploy
  //    workflow stamps VITE_BASE_PATH=/ before vite build, which
  //    propagates into import.meta.env and tells the runtime "this
  //    bundle is at origin root with no path prefix." BrowserRouter's
  //    basename must be empty for routes to match the bare pathname.
  if (STANDALONE_DEPLOY) return "";

  // 3. Pathname fallback. Preserved locally because app-client's helper
  //    intentionally never reads `window.location.pathname` — pathname-
  //    based detection is interim until every host injects the meta tag.
  const path = pathname ?? (typeof window === "undefined" ? null : window.location.pathname);
  if (path == null) return LEGACY_FALLBACK;
  for (const pattern of MOUNT_PATTERNS) {
    const match = pattern.exec(path);
    if (match?.[1]) return match[1];
  }
  return LEGACY_FALLBACK;
}

/**
 * Convenience accessor: the mount base with a trailing slash, suitable
 * for building absolute URLs (e.g. PWA manifest start_url, OAuth
 * callback construction). `/surface/notes` → `/surface/notes/`.
 */
export function detectMountBaseWithSlash(pathname?: string, doc?: Document): string {
  const base = detectMountBase(pathname, doc);
  return base.endsWith("/") ? base : `${base}/`;
}
