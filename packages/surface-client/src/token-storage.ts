/**
 * Token persistence for app-client.
 *
 * Storage shape is `parachute_token:<app-name>:<vault-scope>`. Two pieces
 * of intent live in that shape:
 *
 *   1. **App-scoped.** Each app installed under parachute-surface holds its
 *      own per-vault tokens. A future "share one token across apps"
 *      affordance can layer on top; the default isolation is per-app so
 *      a malicious or buggy app can't trivially snatch sibling apps'
 *      tokens out of `window.localStorage`.
 *
 *   2. **Per vault.** Multi-vault apps (Notes-style) hold one token per
 *      vault and swap them at the in-app vault picker. The `vaultScope`
 *      segment is the canonical vault id from
 *      `vault-id.ts:vaultIdFromUrl(vaultUrl)`. Single-vault apps pick a
 *      stable label (the vault name from meta.json's `vault_default`,
 *      or any constant) and stick with it.
 *
 * Auto-prune of expired tokens: `loadToken` returns `null` when
 * `expiresAt` is in the past AND there's no `refreshToken` to fall back
 * on. Tokens with a refresh stay loadable past expiry — the caller's
 * refresh-on-401 path will rotate them on first use.
 *
 * All writes are best-effort: localStorage may be wedged (SSR, privacy
 * mode, quota); failures are swallowed and surface only through the load
 * path returning `null`.
 */

import type { StoredToken, TokenResponse } from "./types.js";

/** Key prefix for app-client tokens. Stable; do not change without a migration. */
export const TOKEN_KEY_PREFIX = "parachute_token";

/**
 * Build the storage key for a (app, vault-scope) pair. Exposed so
 * callers can mass-clear (e.g. logout) by enumerating keys with this
 * prefix.
 */
export function tokenKey(appName: string, vaultScope: string): string {
  return `${TOKEN_KEY_PREFIX}:${appName}:${vaultScope}`;
}

/**
 * Resolve the storage backend. Falls back to a no-op store when
 * localStorage isn't available (SSR, sandboxed iframe). The no-op store
 * makes `loadToken` always return null + `saveToken`/`clearToken` no-ops
 * — callers don't have to branch on the storage availability question.
 */
function resolveStorage(): Storage | NullStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Storage access can throw (e.g. cookies disabled in some browsers).
  }
  return NULL_STORAGE;
}

type NullStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};

const NULL_STORAGE: NullStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
};

export type TokenStorageOpts = {
  /** Override the storage backend (tests). Defaults to `window.localStorage`. */
  storage?: Storage | NullStorage;
  /** Override the clock (tests). Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Load the token for `(appName, vaultScope)`. Returns `null` when:
 *   - storage backend is unavailable
 *   - no token is stored under the key
 *   - the stored value isn't valid JSON
 *   - the token is expired AND has no `refreshToken` to recover from
 */
export function loadToken(
  appName: string,
  vaultScope: string,
  opts: TokenStorageOpts = {},
): StoredToken | null {
  const storage = opts.storage ?? resolveStorage();
  const now = opts.now ?? Date.now;
  const key = tokenKey(appName, vaultScope);

  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: StoredToken;
  try {
    parsed = JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }

  if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
    return null;
  }

  // Auto-prune: expired AND not refreshable. With a refresh token, the
  // caller's refresh-on-401 path will rotate this for us; we return the
  // expired record so the in-flight request gets one shot at refresh
  // before forcing a new OAuth flow.
  if (typeof parsed.expiresAt === "number" && parsed.expiresAt <= now() && !parsed.refreshToken) {
    try {
      storage.removeItem(key);
    } catch {
      // best-effort
    }
    return null;
  }

  return parsed;
}

export function saveToken(
  appName: string,
  vaultScope: string,
  token: StoredToken,
  opts: TokenStorageOpts = {},
): void {
  const storage = opts.storage ?? resolveStorage();
  const key = tokenKey(appName, vaultScope);
  try {
    storage.setItem(key, JSON.stringify(token));
  } catch {
    // best-effort
  }
}

export function clearToken(appName: string, vaultScope: string, opts: TokenStorageOpts = {}): void {
  const storage = opts.storage ?? resolveStorage();
  const key = tokenKey(appName, vaultScope);
  try {
    storage.removeItem(key);
  } catch {
    // best-effort
  }
}

/**
 * Sweep all tokens belonging to `appName`. Returns the count of keys
 * removed — useful for logout flows that want to confirm cleanup. Best-
 * effort across storage failures; partial removal is the expected
 * outcome when quota or sandboxing intervenes.
 */
export function clearAllTokensForApp(appName: string, opts: TokenStorageOpts = {}): number {
  const storage = opts.storage ?? resolveStorage();
  const prefix = `${TOKEN_KEY_PREFIX}:${appName}:`;
  // Two-pass: collect keys before removing — `removeItem` shifts
  // indices, so iterating during mutation drops entries on the floor.
  const toRemove: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(prefix)) toRemove.push(k);
    }
  } catch {
    return 0;
  }
  let removed = 0;
  for (const k of toRemove) {
    try {
      storage.removeItem(k);
      removed++;
    } catch {
      // best-effort
    }
  }
  return removed;
}

/**
 * Compute the `StoredToken` shape from a token-endpoint response. The
 * `expiresAt` is derived from `expires_in` at call time so consumers
 * can compare a single absolute timestamp later.
 */
export function storedFromTokenResponse(
  token: {
    access_token: string;
    scope: string;
    vault?: string;
    refresh_token?: string;
    expires_in?: number;
  },
  now: number = Date.now(),
): StoredToken {
  const stored: StoredToken = {
    accessToken: token.access_token,
    scope: token.scope,
  };
  if (token.vault !== undefined) stored.vault = token.vault;
  if (token.refresh_token) stored.refreshToken = token.refresh_token;
  if (typeof token.expires_in === "number") {
    stored.expiresAt = now + token.expires_in * 1000;
  }
  return stored;
}

/**
 * Reconstruct a token-endpoint–shaped `TokenResponse` from a persisted
 * `StoredToken`. The inverse of {@link storedFromTokenResponse}, used by the
 * cross-tab refresh single-flight (`oauth.ts`): when another tab has already
 * rotated the token while we waited for the Web Lock, we adopt the winner's
 * freshly-stored token and must hand callers the same `{ token, stored }`
 * shape the network exchange would have produced — WITHOUT replaying the now-
 * stale refresh token over the wire.
 *
 * `expires_in` is derived back from the absolute `expiresAt` against `now`,
 * floored at 0 (a just-expired adopted token still beats re-POSTing a revoked
 * refresh token). `token_type` is always `"bearer"` (the only type the hub
 * issues). Fields the stored envelope never carries (`services`) are omitted.
 */
export function tokenResponseFromStored(
  stored: StoredToken,
  now: number = Date.now(),
): TokenResponse {
  const token: TokenResponse = {
    access_token: stored.accessToken,
    token_type: "bearer",
    scope: stored.scope,
  };
  if (stored.vault !== undefined) token.vault = stored.vault;
  if (stored.refreshToken !== undefined) token.refresh_token = stored.refreshToken;
  if (typeof stored.expiresAt === "number") {
    token.expires_in = Math.max(0, Math.round((stored.expiresAt - now) / 1000));
  }
  return token;
}
