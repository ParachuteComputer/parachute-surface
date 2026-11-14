import type { ReactNode } from "react";
import type { VaultImageProps } from "./VaultImage.js";
import type { FetchBlob } from "./fetch-blob.js";
import { useBlobObjectUrl } from "./use-blob-object-url.js";

export interface VaultAudioProps {
  /** Audio source — a vault storage URL (`/api/storage/…`) is fetched with
   *  auth; an inline `data:audio/…` or `blob:` src plays as is. Anything else
   *  is never loaded (an http(s) URL shows as a link). */
  src: string;
  className?: string;
  /** Auth'd blob fetcher (see {@link FetchBlob}). Required for vault
   *  storage URLs. */
  fetchBlob?: FetchBlob;
  /** The vault's base URL; see {@link VaultImageProps.vaultUrl}. */
  vaultUrl?: string;
  /** Optional caption/label rendered alongside the control. */
  label?: ReactNode;
  /** `<audio>` controls attribute (default true). */
  controls?: boolean;
}

/**
 * Auth'd `<audio>` for vault voice memos / audio attachments. A bare
 * `<audio src>` can't reach `/api/storage/…` (it needs the bearer header),
 * so we fetch the blob WITH auth, turn it into an object URL, and feed that
 * to `<audio>`. The object URL is revoked on unmount / src change.
 *
 * Generalizes my-vault-ui's `AudioEmbed`. That component keyed off the
 * note's attachment list and derived the storage path itself; here the
 * surface supplies the resolved storage `src` (and optionally a `label`),
 * keeping this primitive free of any app-specific attachment model.
 */
export function VaultAudio({
  src,
  className,
  fetchBlob,
  vaultUrl,
  label,
  controls = true,
}: VaultAudioProps) {
  const { url, loading, error, needsAuth, kind } = useBlobObjectUrl(src, fetchBlob, vaultUrl);

  return (
    <span className={`vault-audio ${className ?? ""}`.trim()}>
      {label ? <span className="vault-audio-label">{label}</span> : null}
      {kind === "remote" ? (
        <a href={src} className="vault-media-remote" target="_blank" rel="noopener noreferrer">
          Remote audio, not loaded: {src}
        </a>
      ) : kind === "blocked" ? (
        <span className="vault-media-blocked">[audio not loaded]</span>
      ) : error ? (
        <span className="vault-media-error">Couldn't load audio — {error}</span>
      ) : needsAuth && (loading || !url) ? (
        <span className="vault-media-loading" aria-busy="true">
          Loading audio…
        </span>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: voice-memo attachments carry no caption track; the optional `label` is the human affordance.
        <audio controls={controls} src={url ?? undefined} />
      )}
    </span>
  );
}
