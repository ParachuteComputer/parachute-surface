/**
 * Runtime tenancy contract — consumer-side helpers.
 *
 * Reads the structured environment metadata that parachute-app's host
 * injects into every served `index.html` (see
 * `parachute-patterns/patterns/runtime-tenancy-contract.md` and the
 * producer-side reference at
 * `parachute-app/packages/app-host/src/tenancy-injection.ts`). Apps that
 * depend on `@openparachute/app-client` get typed accessors instead of
 * regex-parsing meta tags themselves.
 *
 * Canonical injected shape:
 *
 *   <head>
 *     <base href="/app/<name>/">
 *     <meta name="parachute-mount" content="/app/<name>">
 *     <meta name="parachute-hub" content="<hub-origin>">
 *     <meta name="parachute-vault" content="/vault/<name>">          (when session-bound)
 *     <meta name="parachute-vault-origin" content="<vault-origin>">  (cloud / cross-origin only)
 *   </head>
 *
 * Design principles for this module:
 *
 *   - **Never throw.** Missing meta tags return `null` and let the
 *     caller decide the default. Apps frequently want to fall back to
 *     a legacy mount (`/notes`) or to `window.location.origin`; baking
 *     the fallback in here would force one shape on every consumer.
 *   - **No producer-side coupling.** This module reads meta tags and
 *     nothing else. It does not import from `@openparachute/app` or
 *     `app-host` — the contract is the meta tags themselves, not a
 *     shared type.
 *   - **Tests pass `doc` / `origin` explicitly.** The optional `opts`
 *     param lets tests inject a stub Document without monkey-patching
 *     `globalThis.document`. The default reads the global lazily so
 *     server-side imports (SSR, build scripts) don't crash on module
 *     load.
 *
 * After this module ships, `parachute-notes/packages/notes-ui/src/lib/base-url.ts`
 * migrates to `getMountBase()` (separate PR — notes-side follow-up to
 * parachute-app#22).
 */

/**
 * Read the trimmed content of `<meta name="<name>">` if present.
 *
 * Returns `null` if:
 *   - `doc` is null / undefined
 *   - `doc` doesn't have a `querySelector` (test stubs that don't
 *     implement the DOM lookup interface)
 *   - the tag isn't present
 *   - the tag's content is empty / whitespace-only
 *
 * Defensive on the doc shape because tests pass minimal stubs and
 * because some runtimes (SSR, workers) expose partial DOM globals.
 */
function readMetaContent(doc: Document | null | undefined, name: string): string | null {
  if (!doc) return null;
  if (typeof (doc as { querySelector?: unknown }).querySelector !== "function") return null;
  const meta = doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const raw = meta?.content?.trim();
  return raw ? raw : null;
}

/**
 * Resolve the Document to read from. Defaults to the global `document`
 * if available; returns `null` in non-DOM contexts (SSR, workers,
 * Node-side tests without a stub).
 */
function resolveDoc(doc?: Document | null): Document | null {
  if (doc !== undefined) return doc;
  if (typeof document === "undefined") return null;
  return document;
}

/**
 * Resolve the origin to use for same-origin URL construction. Defaults
 * to `window.location.origin` if available; returns `null` in non-DOM
 * contexts.
 */
function resolveOrigin(origin?: string): string | null {
  if (origin !== undefined) return origin;
  if (typeof window === "undefined") return null;
  return window.location.origin;
}

/**
 * Detect the mount path the SPA is served under at runtime.
 *
 * Reads `<meta name="parachute-mount" content="...">` injected by
 * parachute-app's host. Returns the mount path WITHOUT a trailing slash
 * — the shape React Router's `basename` and OAuth callback URL
 * construction both expect.
 *
 * Returns `null` when:
 *   - no meta tag is present
 *   - the content is empty
 *   - the content doesn't start with `/` (malformed — the contract
 *     specifies an absolute path)
 *
 * Callers decide the fallback. Apps migrating from notes-ui's regex
 * detection should fall back to `/notes` (the legacy daemon mount);
 * new apps may prefer to throw at app boot if the tag is missing.
 *
 * @param opts.doc  Optional Document for tests. Defaults to global
 *                  `document` if available, else null.
 */
export function getMountBase(opts?: { doc?: Document | null }): string | null {
  const doc = resolveDoc(opts?.doc);
  const value = readMetaContent(doc, "parachute-mount");
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  // Strip trailing slash. The contract says the injected value is
  // already slash-free, but be tolerant — a future host might inject
  // `/app/notes/` and we shouldn't make consumers handle both shapes.
  return value === "/" ? "/" : value.replace(/\/$/, "");
}

/**
 * Derive the tenant's logical id from the mount path.
 *
 * Returns the last segment of `/app/<name>` (e.g. `"notes"` for
 * `/app/notes`, `"my-notes"` for `/app/my-notes`). Returns `null` if
 * the mount doesn't match the `/app/<slug>` pattern — legacy
 * `/notes` and multi-segment paths fall through.
 *
 * Why a separate helper instead of "split getMountBase()": some sites
 * want the mount path (React Router basename), others want the tenant
 * id (storage keys, log lines, error messages). Exposing both spares
 * every caller from re-deriving.
 *
 * @param opts.doc  Optional Document for tests.
 */
export function getTenantId(opts?: { doc?: Document | null }): string | null {
  const mount = getMountBase(opts);
  if (!mount) return null;
  // Match `/app/<slug>` exactly — single segment after `/app/`. Slug
  // grammar mirrors parachute-app's meta-schema PATH_PATTERN
  // (`[a-z0-9][a-z0-9_-]*`).
  const match = /^\/app\/([a-z0-9][a-z0-9_-]*)$/.exec(mount);
  return match?.[1] ?? null;
}

/**
 * Read the hub origin from `<meta name="parachute-hub">`.
 *
 * Returns `null` if absent. Callers can fall back to
 * `window.location.origin` (in same-origin deployments today, hub IS
 * the origin serving the app).
 *
 * @param opts.doc  Optional Document for tests.
 */
export function getHubOrigin(opts?: { doc?: Document | null }): string | null {
  return readMetaContent(resolveDoc(opts?.doc), "parachute-hub");
}

/**
 * Resolve the bound vault's URL for the current operator session.
 *
 * Resolution order:
 *
 *   1. `<meta name="parachute-vault-origin">` + `<meta name="parachute-vault">`
 *      → cross-origin URL. Forward-compat for cloud tiers where vault
 *      lives on a separate origin (`https://vault.example.com/vault/x`).
 *   2. `<meta name="parachute-vault">` alone + a resolvable browser
 *      origin → same-origin URL (`${window.location.origin}/vault/x`).
 *      This is the load-bearing path today — hub proxies vault under
 *      the same origin that serves the app.
 *   3. `<meta name="parachute-vault">` alone + no origin available
 *      (SSR / explicit `origin: undefined` in a non-DOM context) →
 *      returns the path as-is (`/vault/x`). Callers in DOM contexts
 *      can resolve against `fetch()`'s base URL; SSR callers must
 *      provide an explicit `opts.origin`.
 *   4. No vault meta tag → `null`.
 *
 * Always returns a fully-qualified URL when possible so the typical
 * `fetch(getVaultUrl())` call site works without further composition.
 *
 * @param opts.doc     Optional Document for tests.
 * @param opts.origin  Optional origin override for tests / SSR.
 *                     Defaults to `window.location.origin` when
 *                     available.
 */
export function getVaultUrl(opts?: { doc?: Document | null; origin?: string }): string | null {
  const doc = resolveDoc(opts?.doc);
  const vaultPath = readMetaContent(doc, "parachute-vault");
  if (!vaultPath) return null;

  const vaultOrigin = readMetaContent(doc, "parachute-vault-origin");
  if (vaultOrigin) {
    // Case 1: cross-origin. Join vault-origin + path. If the path is
    // already absolute (which the contract specifies), this yields the
    // expected `<origin><path>` shape.
    return joinOriginAndPath(vaultOrigin, vaultPath);
  }

  const origin = resolveOrigin(opts?.origin);
  if (origin) {
    // Case 2: same-origin. Resolve against the browser's origin (or a
    // caller-supplied one for SSR).
    return joinOriginAndPath(origin, vaultPath);
  }

  // Case 3: no origin resolvable. Return the path; the caller can join
  // it against whatever base they have. Same-origin fetches still
  // work because fetch() resolves relative URLs against the document.
  return vaultPath;
}

/**
 * Join an origin + a path, tolerant of trailing-slash on origin and
 * leading-slash on path. Both sides come from operator-controlled
 * metadata, so be defensive about either having or missing the
 * separator.
 */
function joinOriginAndPath(origin: string, path: string): string {
  const trimmedOrigin = origin.replace(/\/$/, "");
  const prefixedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedOrigin}${prefixedPath}`;
}
