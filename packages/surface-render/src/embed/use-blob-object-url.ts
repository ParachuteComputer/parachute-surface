import { useEffect, useState } from "react";
import { type FetchBlob, type MediaSrcKind, mediaSrcKind } from "./fetch-blob.js";

export interface BlobObjectUrlState {
  /** The object URL for an auth-fetched blob, the src itself for an inline
   *  `blob:`/`data:` src, or null (while loading, or for a src that must not
   *  load: see `kind`). */
  url: string | null;
  /** True while an auth'd fetch is in flight. */
  loading: boolean;
  /** Error message if the fetch failed. */
  error: string | null;
  /** True if this src needs an auth'd fetch (vault storage). */
  needsAuth: boolean;
  /** How the src may be shown (see {@link MediaSrcKind}). `remote` and
   *  `blocked` are never loaded. */
  kind: MediaSrcKind;
}

/**
 * Shared logic for the auth'd-media primitives ({@link VaultImage},
 * {@link VaultAudio}). For a vault storage `src`, fetches the blob via
 * `fetchBlob`, turns it into an object URL, and revokes it on unmount / src
 * change. An inline `blob:`/`data:` src is used as is. Anything else (a
 * remote http(s) URL, another scheme, a non-storage path) is **never
 * loaded**: `url` stays null and the caller shows a link or words instead, so
 * a note can't make the reader's device contact a server.
 */
export function useBlobObjectUrl(
  src: string,
  fetchBlob: FetchBlob | undefined,
  vaultOrigin?: string,
): BlobObjectUrlState {
  const kind = mediaSrcKind(src, vaultOrigin);
  const needsAuth = kind === "storage";
  const direct = kind === "inline" ? src : null;
  const [url, setUrl] = useState<string | null>(direct);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(needsAuth);

  useEffect(() => {
    if (!needsAuth) {
      setUrl(direct);
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
  }, [needsAuth, direct, src, fetchBlob]);

  // A src that must not load never reaches the DOM, even for the one render
  // before the effect runs after a src change.
  return { url: needsAuth ? url : direct, loading, error, needsAuth, kind };
}
