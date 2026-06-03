import type { FetchBlob } from "./fetch-blob.js";
import { useBlobObjectUrl } from "./use-blob-object-url.js";

export interface VaultImageProps {
  /** Image source — a `/api/storage/…` URL is fetched with auth; any other
   *  URL renders directly. */
  src: string;
  alt?: string;
  className?: string;
  /** Auth'd blob fetcher (see {@link FetchBlob}). Required for vault
   *  storage URLs; ignored for plain http(s) images. */
  fetchBlob?: FetchBlob;
}

/**
 * Renders an image, fetching auth-gated vault storage blobs (`/api/storage/…`)
 * with the surface's authorization and rendering them via an object URL.
 * Non-storage URLs render directly. This is the canonical embed-render path:
 * the Obsidian import rewrites `![[file]]` embeds to `![](/api/storage/…)`,
 * which the markdown `img` override routes here.
 */
export function VaultImage({ src, alt, className, fetchBlob }: VaultImageProps) {
  const { url, loading, error, needsAuth } = useBlobObjectUrl(src, fetchBlob);

  if (error) {
    return (
      <span className="vault-media-error" role="img" aria-label={alt ?? "image failed to load"}>
        [{alt || "image"}: {error}]
      </span>
    );
  }

  if (needsAuth && (loading || !url)) {
    return (
      <span
        className={`vault-media-loading ${className ?? ""}`.trim()}
        aria-busy="true"
        aria-label={alt ?? "loading image"}
      />
    );
  }

  return <img src={url ?? undefined} alt={alt ?? ""} className={className} />;
}
