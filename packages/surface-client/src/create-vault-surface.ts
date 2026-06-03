/**
 * `createVaultSurface` — the turnkey quick-start factory (surface-client
 * design doc §5C / Phase 2).
 *
 * Both real adopters (`my-vault-ui` and notes-ui) had to hand-write the same
 * ~20-line OAuth + `VaultClient` dance: discover the AS, obtain a client_id
 * (hosted endpoint *or* DCR depending on deployment), drive `beginFlow`, parse
 * the callback, then build a `VaultClient` wired with a refresh-on-401 loop.
 * This factory collapses that into one call and — crucially — **auto-detects
 * which of the two §3 bootstraps applies** so an external developer doesn't
 * have to know whether they're hosted or standalone:
 *
 *   - **Hosted** (bundle served by a Parachute surface-host under
 *     `/surface/<name>/`): the host injects a `parachute-mount` meta tag and
 *     exposes `/surface/<name>/oauth-client`. The factory lets `ParachuteOAuth`
 *     fetch the client_id from that endpoint (`getClientId()`).
 *   - **Standalone** (GitHub Pages / any static host, no Parachute host in
 *     front): no meta tag, no hosted endpoint. The factory runs RFC 7591
 *     Dynamic Client Registration (`discoverAuthServer` + `registerClient`)
 *     and seeds the result via `useClientId()`, caching the client_id in
 *     localStorage so it registers at most once per browser per (issuer,
 *     redirectUri).
 *
 * Detection key: presence of the `parachute-mount` meta tag (the host-only
 * runtime-tenancy signal — see `mount.ts` / `runtime-tenancy-contract.md`).
 * The caller can force either path with `bootstrap: "hosted" | "dcr"`.
 *
 * The factory bakes the sane defaults both adopters had to choose by hand:
 *   - `hubUrl`     → the `parachute-hub` meta tag, else `window.location.origin`.
 *   - `redirectUri`→ `${mount}/oauth/callback` (hosted) or `${origin}/oauth/callback` (standalone).
 *   - `scope`      → `"vault:read vault:write"`.
 *   - `appName`    → derived from the tenant id (hosted) or a slug of `clientName` (standalone).
 *
 * It returns a ready bundle: the configured `ParachuteOAuth` plus a `getClient()`
 * that hands back a `VaultClient` already wired with the refresh-on-401 loop
 * (the loop both adopters wrote by hand — and the one the standalone example
 * still simplifies, see its app.ts note).
 *
 * Framework-agnostic: no React. A React/Svelte/Vue surface wires `login()` /
 * `handleCallback()` / `getClient()` into its own components.
 */

import { discoverAuthServer, registerClient } from "./discovery.js";
import { getHubOrigin, getMountBase, getTenantId } from "./mount.js";
import { type OAuthClientInfo, ParachuteOAuth } from "./oauth.js";
import type { TokenStorageLike } from "./oauth.js";
import { VaultClient } from "./vault-client.js";

/** Which §3 bootstrap to use. `"auto"` (default) detects from the DOM. */
export type SurfaceBootstrap = "hosted" | "dcr" | "auto";

export interface CreateVaultSurfaceOpts {
  /**
   * Human-readable name shown on the hub consent screen the first time the
   * operator approves this surface. **Required — no sane default.** (For a
   * standalone surface it's the DCR `client_name`; for a hosted surface it's
   * informational, since the host owns the registered client.)
   */
  clientName: string;
  /**
   * Hub origin the surface discovers OAuth metadata against and proxies the
   * vault through. Default: the `parachute-hub` meta tag if present (hosted),
   * else `window.location.origin`.
   */
  hubUrl?: string;
  /**
   * Vault to request access to + the storage-key segment for the resulting
   * token. Default: `"default"`.
   */
  vaultName?: string;
  /**
   * Stable app identifier — the token-storage app-segment and (hosted) the
   * `<name>` in `/surface/<name>/oauth-client`. Default: the tenant id derived
   * from the mount path (hosted), else a slug of `clientName` (standalone).
   * Supply explicitly when running hosted under a mount whose slug differs
   * from what you'd derive.
   */
  appName?: string;
  /**
   * Redirect URI the AS bounces back to after consent. Default:
   * `${mountBase}/oauth/callback` (hosted) or `${origin}/oauth/callback`
   * (standalone). For DCR this is also the registered redirect URI, so the
   * hub binds the client to it.
   */
  redirectUri?: string;
  /**
   * OAuth scope requested. Default: `"vault:read vault:write"`.
   */
  scope?: string;
  /**
   * Force a bootstrap path. Default `"auto"`: `"hosted"` when a
   * `parachute-mount` meta tag is present, else `"dcr"`.
   */
  bootstrap?: SurfaceBootstrap;

  // --- testability / advanced overrides (mirror ParachuteOAuth's) ---

  /** Override the fetch implementation (tests, non-browser hosts). */
  fetchImpl?: typeof fetch;
  /**
   * Override the Document the auto-detect + meta-tag readers consult.
   * Defaults to the global `document`.
   */
  doc?: Document | null;
  /** Override `window.location.origin` resolution (tests / SSR). */
  origin?: string;
  /**
   * Override the localStorage-like backend used to cache the DCR client_id
   * (standalone only). Defaults to `window.localStorage`. A no-op fallback is
   * used in non-DOM contexts.
   */
  dcrCacheStorage?: SimpleStorageLike;
  /** Override the sessionStorage backend (passed through to ParachuteOAuth). */
  sessionStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  /** Override the persistent token-storage backend (passed through). */
  tokenStorage?: TokenStorageLike;
  /** Override the clock (tests). */
  now?: () => number;
}

/** Minimal localStorage-shaped surface the DCR cache needs. */
export interface SimpleStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VaultSurface {
  /** The configured OAuth driver — escape hatch for advanced flows. */
  oauth: ParachuteOAuth;
  /** Resolved bootstrap path (after auto-detect). */
  readonly bootstrap: "hosted" | "dcr";
  /** Resolved hub origin. */
  readonly hubUrl: string;
  /** Resolved vault name / storage-key segment. */
  readonly vaultName: string;
  /**
   * Ensure a client_id is available (DCR-register if standalone), then begin
   * the OAuth dance and navigate the browser to the authorize URL. In a
   * non-DOM context (no `window`), it resolves the authorize URL but does not
   * navigate — use `oauth.beginFlow` directly if you need the URL.
   */
  login(): Promise<void>;
  /**
   * Complete the OAuth flow from the current `window.location` (reads
   * `code` + `state` from the query string), exchange + persist the token,
   * then strip the params from the URL. Throws if `code`/`state` are absent.
   */
  handleCallback(): Promise<void>;
  /**
   * A `VaultClient` wired with auto-refresh-on-401, or `null` if no token is
   * stored (not signed in). Re-reads the stored token on each call so a token
   * refreshed elsewhere is picked up.
   *
   * **React (and other render-loop frameworks):** each call constructs a fresh
   * `VaultClient` (and a fresh refresh-on-401 closure), so do NOT call this in
   * a render body. Store the result in state/ref (e.g. `useMemo`/`useState`/
   * `useRef`) and re-derive only when the signed-in identity changes — calling
   * it every render churns a new client + closure per frame. The auto-refresh
   * loop re-reads the latest stored token on each request regardless, so a
   * single retained client stays current across token rotation.
   */
  getClient(): VaultClient | null;
  /**
   * Clear the stored session token for this vault (local sign-out). This
   * clears the OAuth *token* only — it deliberately does NOT clear the DCR
   * client registration (the `client_id` is durable: it survives sign-out so
   * the next `login()` reuses it instead of re-registering). To force a fresh
   * Dynamic Client Registration (e.g. the operator rotated the hub URL or you
   * want a clean client_id), call `surface.oauth.resetCaches()` and clear the
   * DCR cache storage.
   */
  logout(): void;
}

const DEFAULT_SCOPE = "vault:read vault:write";
const DEFAULT_VAULT = "default";
/**
 * Prefix for the per-surface DCR client_id cache key in localStorage. The
 * full key incorporates the surface identity (`appName`) — see
 * {@link dcrCacheKey} — so two standalone surfaces sharing an origin (e.g.
 * `/notes/` and `/tasks/` on the same GitHub Pages site) with different
 * `redirectUri`s don't evict each other's registrations. A single fixed key
 * would let the last-registered surface clobber the others, forcing a
 * re-registration round-trip on every surface switch.
 */
const DCR_CACHE_KEY_PREFIX = "parachute_surface_dcr";

/** Per-surface DCR cache key — namespaced by `appName` so surfaces don't collide. */
function dcrCacheKey(appName: string): string {
  return `${DCR_CACHE_KEY_PREFIX}:${appName}`;
}

/**
 * Build a ready-to-use surface bundle (OAuth + VaultClient) with hosted /
 * standalone auto-detect and sane defaults. See the module header for the
 * detection mechanism + defaults.
 */
export function createVaultSurface(opts: CreateVaultSurfaceOpts): VaultSurface {
  if (!opts.clientName) {
    throw new Error("createVaultSurface requires a non-empty clientName");
  }

  const doc = opts.doc;
  const origin = resolveOrigin(opts.origin);
  const vaultName = opts.vaultName ?? DEFAULT_VAULT;
  const scope = opts.scope ?? DEFAULT_SCOPE;

  // --- detect hosted vs standalone -----------------------------------------
  const mountBase = getMountBase(doc !== undefined ? { doc } : undefined);
  const bootstrap: "hosted" | "dcr" =
    opts.bootstrap && opts.bootstrap !== "auto" ? opts.bootstrap : mountBase ? "hosted" : "dcr";

  // --- resolve defaults that depend on the detected shape ------------------
  const hubUrl =
    opts.hubUrl ?? getHubOrigin(doc !== undefined ? { doc } : undefined) ?? origin ?? "";
  if (!hubUrl) {
    throw new Error(
      "createVaultSurface: could not resolve a hub URL. Pass `hubUrl` explicitly " +
        "(no `parachute-hub` meta tag and no window.location.origin available).",
    );
  }

  const appName =
    opts.appName ??
    (bootstrap === "hosted"
      ? (getTenantId(doc !== undefined ? { doc } : undefined) ?? slugify(opts.clientName))
      : slugify(opts.clientName));

  const redirectUri =
    opts.redirectUri ??
    (bootstrap === "hosted"
      ? `${origin ?? ""}${mountBase ?? `/surface/${encodeURIComponent(appName)}`}/oauth/callback`
      : `${origin ?? ""}/oauth/callback`);

  // --- construct the OAuth driver ------------------------------------------
  const oauthOpts: ConstructorParameters<typeof ParachuteOAuth>[0] = {
    appName,
    hubUrl,
  };
  if (opts.fetchImpl !== undefined) oauthOpts.fetchImpl = opts.fetchImpl;
  if (opts.sessionStorage !== undefined) oauthOpts.sessionStorage = opts.sessionStorage;
  if (opts.tokenStorage !== undefined) oauthOpts.tokenStorage = opts.tokenStorage;
  if (opts.now !== undefined) oauthOpts.now = opts.now;
  const oauth = new ParachuteOAuth(oauthOpts);

  const fetchImpl =
    opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  const dcrCache = resolveDcrCache(opts.dcrCacheStorage);

  /**
   * For the standalone path: ensure a DCR client_id is registered + seeded
   * into the driver. No-op (returns early) for the hosted path, which fetches
   * its client_id lazily from the host endpoint inside `beginFlow`.
   */
  async function ensureClientId(): Promise<void> {
    if (bootstrap === "hosted") return;
    const metadata = await discoverAuthServer(hubUrl, fetchImpl);
    let clientId = loadCachedClientId(dcrCache, appName, metadata.issuer, redirectUri);
    if (!clientId) {
      const registration = await registerClient(
        metadata.registration_endpoint,
        { clientName: opts.clientName, redirectUri },
        fetchImpl,
      );
      clientId = registration.client_id;
      saveCachedClientId(dcrCache, appName, metadata.issuer, redirectUri, clientId);
    }
    const info: OAuthClientInfo = {
      client_id: clientId,
      scopes: scope.split(/\s+/).filter(Boolean),
    };
    oauth.useClientId(info);
  }

  return {
    oauth,
    bootstrap,
    hubUrl,
    vaultName,

    async login(): Promise<void> {
      await ensureClientId();
      const { authorizeUrl } = await oauth.beginFlow({ vaultName, scope, redirectUri });
      if (typeof window !== "undefined" && typeof window.location?.assign === "function") {
        window.location.assign(authorizeUrl);
      }
    },

    async handleCallback(): Promise<void> {
      const loc = typeof window !== "undefined" ? window.location : undefined;
      if (!loc) throw new Error("handleCallback requires a browser window.location");
      const url = new URL(loc.href);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) throw new Error("OAuth callback missing code/state");
      // The hosted driver fetches its client_id inside handleCallback's token
      // exchange via the pending state; the standalone driver needs the seeded
      // client_id, so re-seed it (idempotent, reads cache).
      await ensureClientId();
      await oauth.handleCallback(code, state, vaultName);
      if (typeof window !== "undefined" && window.history?.replaceState) {
        window.history.replaceState({}, "", url.origin + url.pathname);
      }
    },

    getClient(): VaultClient | null {
      const stored = oauth.getToken(vaultName);
      if (!stored) return null;
      const clientOpts: ConstructorParameters<typeof VaultClient>[0] = {
        vaultUrl: stored.vault
          ? `${hubUrl}/vault/${encodeURIComponent(stored.vault)}`
          : `${hubUrl}/vault/${encodeURIComponent(vaultName)}`,
        accessToken: stored.accessToken,
        // Refresh-on-401: re-read the latest stored refresh token (it may have
        // rotated since this client was built), exchange it, return the fresh
        // access token. Returns null when refresh isn't possible.
        onAuthError: async () => {
          const current = oauth.getToken(vaultName);
          const refreshToken = current?.refreshToken;
          if (!refreshToken) return null;
          const { token } = await oauth.refreshAccessToken(refreshToken, vaultName);
          return token.access_token;
        },
      };
      if (opts.fetchImpl !== undefined) clientOpts.fetchImpl = opts.fetchImpl;
      return new VaultClient(clientOpts);
    },

    logout(): void {
      oauth.clearToken(vaultName);
    },
  };
}

// --- helpers ----------------------------------------------------------------

function resolveOrigin(override?: string): string | null {
  if (override !== undefined) return override;
  if (typeof window === "undefined") return null;
  try {
    return window.location.origin;
  } catch {
    return null;
  }
}

/** Lowercase, hyphenated, slug-safe app id derived from a human name. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "surface";
}

interface CachedRegistration {
  issuer: string;
  redirectUri: string;
  clientId: string;
}

function loadCachedClientId(
  storage: SimpleStorageLike,
  appName: string,
  issuer: string,
  redirectUri: string,
): string | null {
  try {
    const raw = storage.getItem(dcrCacheKey(appName));
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedRegistration;
    if (cached.issuer !== issuer) return null;
    if (cached.redirectUri !== redirectUri) return null;
    return cached.clientId || null;
  } catch {
    return null;
  }
}

function saveCachedClientId(
  storage: SimpleStorageLike,
  appName: string,
  issuer: string,
  redirectUri: string,
  clientId: string,
): void {
  try {
    storage.setItem(
      dcrCacheKey(appName),
      JSON.stringify({ issuer, redirectUri, clientId } satisfies CachedRegistration),
    );
  } catch {
    // best-effort
  }
}

function resolveDcrCache(override?: SimpleStorageLike): SimpleStorageLike {
  if (override) return override;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // localStorage access can throw in sandboxed contexts.
  }
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}
