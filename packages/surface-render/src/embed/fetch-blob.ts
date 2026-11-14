/**
 * The auth'd-media primitive: given a storage URL (`/api/storage/…`, or an
 * absolute URL under the vault's base URL), return the blob bytes WITH the surface's
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
        // The vault's base URL is what `storageUrl` puts before `/api/storage/`.
        const vaultUrl = storageUrl("").replace(/\/api\/storage\/?$/, "");
        if (!isVaultStorageUrl(url, vaultUrl)) {
          throw new Error("refusing a URL outside the vault");
        }
        // Fetch exactly the URL that was checked, not the raw string.
        target = new URL(url).href;
      } else {
        if (hasTraversal(url)) throw new Error("refusing a URL outside the vault");
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

/** A path that tries to climb out of `/api/storage/` (`..`, `.`, `..;` as
 *  some servers read it, an encoded
 *  dot, slash or backslash), or carries a backslash or control character
 *  (browsers fold `/\host` and `/<TAB>/host` into `//host`), is not a
 *  storage path. Checked at every level of percent-decoding, so `%252e`,
 *  `%25%32%65` and a stray `%` don't hide one from a server or proxy that
 *  decodes twice. A plain `%25` (a name like `100%.png`) is fine; a name that
 *  itself holds `%2e`, `%2f` or `%5c` is refused (fails closed). */
function hasTraversal(path: string): boolean {
  let p = path;
  for (let level = 0; level < 8; level++) {
    if (
      /(^|\/)\.{1,2}(\/|[?#;]|$)/.test(p) ||
      /%(2e|2f|5c)/i.test(p) ||
      p.includes("\\") ||
      hasControlChar(p)
    )
      return true;
    // Lenient: each valid escape decodes on its own (a stray `%` stays), and
    // bytes stand alone; only ASCII matters to the checks above.
    const next = p.replace(/%([0-9a-f]{2})/gi, (_, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
    if (next === p) return false;
    p = next;
  }
  return true; // still decoding after eight levels
}

/** A C0 control character or DEL (URL parsers strip tabs and newlines). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function parseHttpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
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
 * - An absolute `http(s)://` URL is storage only when `vaultUrl` (the vault's
 *   base URL, e.g. `https://hub.example/vault/default`) is given and `src` is
 *   under it: same origin, and its path starts with the vault's path +
 *   `/api/storage/`, and neither its path nor its query climbs (`/../`, an
 *   encoded `.`, `/` or `\`, at any level of decoding). Without `vaultUrl`, no absolute URL is storage:
 *   `https://evil.example/api/storage/x.png` must not get the token, and nor
 *   must another vault on the same hub.
 */
export function isVaultStorageUrl(src: string, vaultUrl?: string): boolean {
  if (!isAbsoluteUrl(src)) {
    return src.startsWith("/api/storage/") && !hasTraversal(src);
  }
  if (!vaultUrl || !/^https?:\/\//i.test(src) || hasControlChar(src) || src.includes("\\"))
    return false;
  const vault = parseHttpUrl(vaultUrl);
  const target = parseHttpUrl(src);
  if (!vault || !target || target.origin !== vault.origin) return false;
  if (target.username || target.password) return false;
  // URL parsing already resolves `..` and `%2e%2e` segments in the pathname.
  // The query is read with the same rule as a relative src's (rich-notes-kit
  // 0.4 hands it over unread): a `/../` or an encoded `/`, `\` or `.` there is
  // refused, in case a server or proxy reads it as a path.
  const base = vault.pathname.replace(/\/$/, "");
  return (
    target.pathname.startsWith(`${base}/api/storage/`) &&
    !hasTraversal(target.pathname + target.search)
  );
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

export function mediaSrcKind(src: string, vaultUrl?: string): MediaSrcKind {
  if (isVaultStorageUrl(src, vaultUrl)) return "storage";
  if (/^blob:/i.test(src)) return "inline";
  if (/^data:(image\/(png|jpe?g|gif|webp|avif)|audio\/[a-z0-9.+-]+)[;,]/i.test(src))
    return "inline";
  if (/^https?:\/\//i.test(src) || src.startsWith("//")) return "remote";
  return "blocked";
}
