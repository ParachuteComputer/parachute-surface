import { useMemo } from "react";
import { type BlobCapableClient, type FetchBlob, vaultClientFetchBlob } from "./fetch-blob.js";

/**
 * Convenience React hook over {@link vaultClientFetchBlob} — the boilerplate
 * every React surface was hand-writing:
 *
 * ```tsx
 * // before (every surface):
 * const fetchBlob = useMemo(() => vaultClientFetchBlob(client) ?? undefined, [client]);
 *
 * // after:
 * const fetchBlob = useVaultFetchBlob(client);
 * ```
 *
 * Adapts a vault client (any {@link BlobCapableClient} — notes-ui's
 * `fetchAttachmentBlob` subclass or a base `VaultClient` via
 * `storageUrl` + token) into a {@link FetchBlob} suitable for
 * `<MarkdownView fetchBlob={…}>`, `<NoteRenderer fetchBlob={…}>`,
 * `<VaultImage>`, and `<VaultAudio>`.
 *
 * Memoized on `client` so the returned function is stable across renders
 * (important — `fetchBlob` is an effect dependency in `useBlobObjectUrl`, so
 * an unstable identity would re-fetch every render).
 *
 * Returns `undefined` (not `null`) when no client / no blob capability, so it
 * drops straight into the optional `fetchBlob?` props without a `?? undefined`
 * dance.
 *
 * @param client     the surface's vault client (may be `null` while signed out)
 * @param fetchImpl  optional `fetch` override (testing / custom transport),
 *                   forwarded to {@link vaultClientFetchBlob}
 */
export function useVaultFetchBlob(
  client: BlobCapableClient | null | undefined,
  fetchImpl?: typeof fetch,
): FetchBlob | undefined {
  return useMemo(() => vaultClientFetchBlob(client, fetchImpl) ?? undefined, [client, fetchImpl]);
}
