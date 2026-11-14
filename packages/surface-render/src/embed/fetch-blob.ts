/**
 * The auth'd-media primitive: given a storage URL (`/api/storage/…`, or an
 * absolute URL on the vault's own origin), return the blob bytes WITH the surface's
 * authorization applied.
 *
 * This is a hook, not a concrete client, on purpose: the embed renderers
 * take a `FetchBlob` hook so they don't depend on any one client class.
 * Surfaces supply it via {@link vaultClientFetchBlob} (for any client
 * exposing `fetchAttachmentBlob` and/or `storageUrl`) or a fully custom
 * function. As of surface-client's Tier 1 graduation (R2, #90) the BASE
 * `VaultClient` carries `fetchAttachmentBlob` — full auth + refresh-on-401
 * retry, the blob-aware loop the shared `request*` path (which always
 * `.json()`s the body) can't provide — so the adapter's preferred branch
 * covers every `VaultClient`, base or notes-ui's subclass. The
 * `storageUrl` + `getAccessToken` fallback below remains only for minimal
 * custom client shapes that never adopted `fetchAttachmentBlob`; it is
 * unreachable for `VaultClient` proper.
 */
export type FetchBlob = (url: string) => Promise<Blob>;

/** Minimal shape the {@link vaultClientFetchBlob} adapter can drive. */
export interface BlobCapableClient {
  /** Preferred: an auth'd, retry-aware blob GET (notes-ui's subclass). */
  fetchAttachmentBlob?: (url: string) => Promise<Blob>;
  /** Fallback inputs for building a default fetch when the above is absent. */
  storageUrl?: (path: string) => string;
  getAccessToken?: () => string | null | undefined;
}

/**
 * Adapt a vault client into a {@link FetchBlob} hook.
 *
 * - If the client has `fetchAttachmentBlob` (notes-ui's subclass), use it —
 *   it already does auth + reachability + 401-refresh retry.
 * - Otherwise fall back to a plain authenticated `fetch` using the client's
 *   `storageUrl` + `getAccessToken`. This covers a base `VaultClient` (which
 *   has `storageUrl`) once the surface also exposes the bearer token.
 *
 * Returns `null` if the client can't produce blobs at all (no
 * `fetchAttachmentBlob` and no `storageUrl`), so callers can decide whether
 * media is renderable.
 */
export function vaultClientFetchBlob(
  client: BlobCapableClient | null | undefined,
  fetchImpl: typeof fetch = fetch,
): FetchBlob | null {
  if (!client) return null;

  if (typeof client.fetchAttachmentBlob === "function") {
    const bound = client.fetchAttachmentBlob.bind(client);
    return (url: string) => bound(url);
  }

  if (typeof client.storageUrl === "function") {
    const storageUrl = client.storageUrl.bind(client);
    const getToken = client.getAccessToken?.bind(client);
    return async (url: string): Promise<Blob> => {
      // Storage paths get expanded. An absolute URL is fetched only when it is
      // on the vault's own origin (the one `storageUrl` builds): the token is
      // never attached to a host a note merely names.
      let target: string;
      if (isAbsoluteUrl(url)) {
        if (!isVaultStorageUrl(url, storageUrl(""))) {
          throw new Error("refusing a URL outside the vault's origin");
        }
        target = url;
      } else {
        target = storageUrl(stripStoragePrefix(url));
      }
      const token = getToken?.();
      const res = await fetchImpl(target, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      return res.blob();
    };
  }

  return null;
}

/**
 * `storageUrl` expects a bare attachment path (it prepends `/api/storage/`),
 * but image `src` values are usually already `/api/storage/<path>`. Strip the
 * prefix so the adapter doesn't double it.
 */
function stripStoragePrefix(url: string): string {
  const m = url.match(/^\/?api\/storage\/(.*)$/);
  return m?.[1] ?? url;
}

/** True for a URL with a scheme (`https:`, `data:`, `javascript:` …) or a
 *  protocol-relative `//host/…` — anything that does not stay on this page's
 *  own path space. */
function isAbsoluteUrl(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

/** A path that tries to climb out of `/api/storage/` (`..`, `.`, an encoded
 *  dot or a backslash) is not a storage path. */
function hasTraversal(path: string): boolean {
  return /(^|\/)\.{1,2}(\/|$)/.test(path) || /%2e|%2f|%5c|\\/i.test(path);
}

function httpOrigin(url: string, base?: string): string | null {
  try {
    const u = new URL(url, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * True if `src` points at the vault's auth-gated storage endpoint — the only
 * kind of URL surface-render ever fetches, and the only kind the vault token
 * is sent with.
 *
 * - A relative `/api/storage/…` path (what the Obsidian import writes) is
 *   storage.
 * - An absolute URL is storage only when `vaultOrigin` is given (the vault's
 *   base URL, or any URL on its origin) and `src` is on that same origin with
 *   an `/api/storage/` path. Without `vaultOrigin`, no absolute URL is
 *   storage: `https://evil.example/api/storage/x.png` must not get the token.
 */
export function isVaultStorageUrl(src: string, vaultOrigin?: string): boolean {
  if (!isAbsoluteUrl(src)) {
    return src.startsWith("/api/storage/") && !hasTraversal(src);
  }
  if (!vaultOrigin || src.startsWith("//")) return false;
  const origin = httpOrigin(vaultOrigin);
  if (!origin || httpOrigin(src) !== origin) return false;
  // URL parsing already resolves `..` and `%2e%2e` segments in the pathname.
  const path = new URL(src).pathname;
  return path.includes("/api/storage/") && !hasTraversal(path);
}

/** How a media `src` from note content may be shown. */
export type MediaSrcKind =
  /** vault storage: fetched with auth, shown from an object URL */
  | "storage"
  /** `blob:` or an inline `data:` image/audio: shown as is, no request */
  | "inline"
  /** an http(s) URL anywhere else: never loaded, shown as a link */
  | "remote"
  /** anything else (another scheme, a non-storage path): never loaded, shown as words */
  | "blocked";

export function mediaSrcKind(src: string, vaultOrigin?: string): MediaSrcKind {
  if (isVaultStorageUrl(src, vaultOrigin)) return "storage";
  if (/^blob:/i.test(src)) return "inline";
  if (/^data:(image\/(png|jpe?g|gif|webp|avif)|audio\/[a-z0-9.+-]+)[;,]/i.test(src))
    return "inline";
  if (/^https?:\/\//i.test(src) || src.startsWith("//")) return "remote";
  return "blocked";
}
