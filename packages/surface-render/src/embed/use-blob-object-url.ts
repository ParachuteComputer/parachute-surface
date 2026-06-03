import { useEffect, useState } from "react";
import { type FetchBlob, isVaultStorageUrl } from "./fetch-blob.js";

export interface BlobObjectUrlState {
  /** The object URL for an auth-fetched blob, or the original src if it's
   *  not an auth-gated storage URL, or null while loading. */
  url: string | null;
  /** True while an auth'd fetch is in flight. */
  loading: boolean;
  /** Error message if the fetch failed. */
  error: string | null;
  /** True if this src needs an auth'd fetch (a `/api/storage/…` URL). */
  needsAuth: boolean;
}

/**
 * Shared logic for the auth'd-media primitives ({@link VaultImage},
 * {@link VaultAudio}). For an auth-gated `/api/storage/…` `src`, fetches the
 * blob via `fetchBlob`, turns it into an object URL, and revokes it on
 * unmount / src change. For any other `src` (a normal http(s) image), passes
 * it through untouched — no auth needed.
 */
export function useBlobObjectUrl(
  src: string,
  fetchBlob: FetchBlob | undefined,
): BlobObjectUrlState {
  const needsAuth = isVaultStorageUrl(src);
  const [url, setUrl] = useState<string | null>(needsAuth ? null : src);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(needsAuth);

  useEffect(() => {
    if (!needsAuth) {
      setUrl(src);
      setLoading(false);
      setError(null);
      return;
    }
    if (!fetchBlob) {
      setError("No authenticated fetcher supplied");
      setLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setError(null);
    setLoading(true);
    fetchBlob(src)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load media");
        setLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [needsAuth, src, fetchBlob]);

  return { url, loading, error, needsAuth };
}
