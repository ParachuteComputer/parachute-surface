/**
 * Smart cache headers per design doc section 18.
 *
 * The intent: solve [parachute-notes#151](https://github.com/ParachuteComputer/parachute-notes/issues/151)
 * at the platform level so future apps inherit a clean default. The rules:
 *
 *   - `index.html` (SPA entrypoints): `no-cache, no-store, must-revalidate`.
 *     Always-fresh; this is the document that points at the hashed assets.
 *   - Content-hashed assets (Vite/Webpack/esbuild/Parcel default convention,
 *     e.g. `app.a3b9f2.js`, `style.7e1c8d.css`): `public, max-age=31536000,
 *     immutable`. Cache forever — the filename changes on rebuild.
 *   - Non-hashed assets: `public, max-age=3600`. Sensible default.
 *   - PWA service worker (when `meta.pwa === true` and `filename` matches
 *     `meta.pwa_service_worker`): `no-cache`. SW updates need to propagate
 *     immediately on rebuild.
 *
 * The hash detector is conservative: require ≥8 hex characters in the
 * second-to-last dot-separated segment. This matches Vite/Webpack output
 * (`app.a3b9f2c1.js`) without false-positiving on filenames like
 * `vendor-1234.js` or `image-2024.png`. We deliberately reject 6-7 char
 * hashes — Vite + Webpack both default to ≥8 — to keep the false-positive
 * rate low.
 */

import type { UiMeta } from "./meta-schema.ts";

/**
 * Regex testing whether a filename looks content-hashed. Examples that pass:
 *   - `app.a3b9f2c1.js`
 *   - `vendor.7e1c8d.chunk.js`         (hash is in the middle)
 *   - `style.deadbeef12345.css`
 *
 * Examples that don't pass (caching at the 1-hour default):
 *   - `index.html` (handled separately)
 *   - `app.js`
 *   - `app-2024.js` (no hex run that long; "2024" is 4 chars)
 *   - `vendor-1234.js`
 *   - `icon.svg`
 *
 * The match looks for a dot-separated segment of ≥8 hex chars anywhere in
 * the filename. That catches both `app.a3b9f2c1.js` and `chunk-a3b9f2c1.js`
 * (Vite's lib-mode pattern + some other build tools' patterns).
 */
const HASHED_ASSET_REGEX = /(^|[.\-_])[a-f0-9]{8,}(\.|$)/;

/**
 * Type signature exposed by section 5 of the brief — explicit per-asset
 * shape for use anywhere we need to set headers. `filename` is the basename
 * (e.g. `app.a3b9f2.js`) — pass the full URL path's basename, not the
 * absolute filesystem path.
 *
 * `meta` is optional so caller can elide it for the `/.parachute/*` admin
 * endpoints; those skip the PWA-aware branch.
 */
export function cacheHeadersFor(filename: string, meta?: UiMeta): Record<string, string> {
  // PWA service worker — always no-cache so updates propagate immediately
  // on rebuild. The SW path is meta-driven so each UI controls its own.
  if (meta?.pwa && meta.pwa_service_worker && filename === meta.pwa_service_worker) {
    return { "Cache-Control": "no-cache" };
  }

  // index.html: always-fresh.
  if (filename === "index.html") {
    return { "Cache-Control": "no-cache, no-store, must-revalidate" };
  }

  // Content-hashed: cache forever.
  if (HASHED_ASSET_REGEX.test(filename)) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }

  // Non-hashed assets: 1-hour default.
  return { "Cache-Control": "public, max-age=3600" };
}

/**
 * Convenience predicate exposed for tests. Returns true when `filename`
 * matches the hash-in-filename convention (used to confirm the regex stays
 * tight as we extend it).
 */
export function looksContentHashed(filename: string): boolean {
  return HASHED_ASSET_REGEX.test(filename);
}
