import type { FetchBlob } from "./fetch-blob.js";
import { useBlobObjectUrl } from "./use-blob-object-url.js";

export interface VaultImageProps {
  /** Image source. A vault storage URL (`/api/storage/…`) is fetched with
   *  auth; an inline `data:image/…` or `blob:` src is shown as is. Anything
   *  else is never loaded: an http(s) URL shows as a link, any other src as
   *  words. */
  src: string;
  alt?: string;
  className?: string;
  /** Auth'd blob fetcher (see {@link FetchBlob}). Required for vault
   *  storage URLs; never called for anything else. */
  fetchBlob?: FetchBlob;
  /** The vault's base URL (e.g. `https://hub.example/vault/default`). Lets
   *  an absolute storage URL under it load; without it only relative
   *  `/api/storage/…` paths are vault storage. */
  vaultUrl?: string;
}

/**
 * Renders an image from a note, loading **only the vault's own
 * attachments**. Storage blobs (`/api/storage/…`) are fetched with the
 * surface's authorization and shown via an object URL. This is the canonical
 * embed-render path: the Obsidian import rewrites `![[file]]` embeds to
 * `![](/api/storage/…)`, which the markdown `img` override routes here.
 *
 * A remote image is never loaded, so a note can't tell a server it was
 * opened: an http(s) `src` renders as a plain link (its alt text, or the
 * address) that opens in a new tab with no referrer, only when the reader
 * taps it. A surface that really wants remote images loaded passes its own
 * `components.img` to `MarkdownView` / `NoteRenderer`.
 */
export function VaultImage({ src, alt, className, fetchBlob, vaultUrl }: VaultImageProps) {
  const { url, loading, error, needsAuth, kind } = useBlobObjectUrl(src, fetchBlob, vaultUrl);

  if (kind === "remote") {
    return (
      <a
        href={src}
        className={`vault-media-remote ${className ?? ""}`.trim()}
        target="_blank"
        rel="noopener noreferrer"
        title="Remote image, not loaded"
      >
        {alt || src}
      </a>
    );
  }

  if (kind === "blocked") {
    return (
      <span className="vault-media-blocked" title="Image not loaded">
        [{alt || "image"}]
      </span>
    );
  }

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
