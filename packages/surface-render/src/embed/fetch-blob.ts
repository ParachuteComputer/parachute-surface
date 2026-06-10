/**
 * The auth'd-media primitive: given a storage URL (`/api/storage/…` or an
 * absolute vault URL), return the blob bytes WITH the surface's
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
      // Absolute URLs pass through; storage paths get expanded.
      const target = /^https?:\/\//.test(url) ? url : storageUrl(stripStoragePrefix(url));
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

/** True if `src` points at the vault's auth-gated storage endpoint. */
export function isVaultStorageUrl(src: string): boolean {
  return src.startsWith("/api/storage/") || /^https?:\/\/[^/]+\/api\/storage\//.test(src);
}
