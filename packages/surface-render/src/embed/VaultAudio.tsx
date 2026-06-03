import type { ReactNode } from "react";
import type { FetchBlob } from "./fetch-blob.js";
import { useBlobObjectUrl } from "./use-blob-object-url.js";

export interface VaultAudioProps {
  /** Audio source — a `/api/storage/…` URL is fetched with auth; any other
   *  URL renders directly. */
  src: string;
  className?: string;
  /** Auth'd blob fetcher (see {@link FetchBlob}). Required for vault
   *  storage URLs. */
  fetchBlob?: FetchBlob;
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
export function VaultAudio({ src, className, fetchBlob, label, controls = true }: VaultAudioProps) {
  const { url, loading, error, needsAuth } = useBlobObjectUrl(src, fetchBlob);

  return (
    <span className={`vault-audio ${className ?? ""}`.trim()}>
      {label ? <span className="vault-audio-label">{label}</span> : null}
      {error ? (
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
