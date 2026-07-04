/**
 * Runtime tenancy contract injection — implements the host side of
 * `../../../docs/contracts/runtime-tenancy-contract.md`.
 *
 * For every `index.html` parachute-surface serves on behalf of a hosted UI we
 * inject a small block of structured environment metadata into `<head>`:
 *
 *   <head>
 *     <base href="/surface/<name>/">                              browser URL resolution
 *     <meta name="parachute-mount" content="/surface/<name>">     runtime code reads this
 *     <meta name="parachute-hub" content="<hub-origin>">      OAuth discovery
 *     ... existing head ...
 *   </head>
 *
 * Two layers, deliberately:
 *
 *   - `<base href>` is load-bearing for the BROWSER's URL resolution. Without
 *     it, Vite-built bundles' `./assets/...` URLs resolve against the
 *     document's perceived directory (`/surface/` when the operator visits
 *     `/surface/notes` with no trailing slash), and 404 on every asset.
 *   - `<meta name="parachute-mount">` / `<meta name="parachute-hub">` are
 *     read at runtime by `@openparachute/surface-client` (parachute-app#22).
 *     Strings the bundle reads as JavaScript — no help from the browser's
 *     URL resolver, hence the separate meta tags.
 *
 * Tags deliberately deferred (out of scope for parachute-app#21):
 *   - `parachute-vault` — needs vault-binding-via-session design that's
 *     orthogonal to the mount-path concerns this PR addresses.
 *   - `parachute-tenant-id` — derivable on the consumer side from
 *     `parachute-mount`; not worth its own injection.
 *   - `parachute-vault-origin` — forward-looking for cross-origin vault.
 *
 * Why string scanning (no `cheerio`): the rationale in `dev-injection.ts`
 * applies identically here. One conservative substring insertion; we don't
 * want to canonicalize the operator's HTML.
 *
 * Idempotency: if `<meta name="parachute-mount">` is already present in
 * the source HTML (e.g. some future bundle ships its own injection), we
 * leave the document untouched. The marker check is regex-based — a false
 * positive (a comment containing the exact attribute) suppresses injection
 * harmlessly.
 */

/** Regex marker for idempotency. Matches both quote styles + case. */
const MOUNT_META_REGEX = /<meta\b[^>]*\bname\s*=\s*['"]parachute-mount['"][^>]*>/i;
/** Find the opening `<head ...>` tag, case-insensitive, whitespace-tolerant. */
const HEAD_OPEN_REGEX = /<head(\s[^>]*)?>/i;

/** Minimal HTML attribute-value escape — order matters (escape `&` first). */
export function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type TenancyInjectionResult = {
  /** The (maybe-modified) document. */
  html: string;
  /** Did we change anything? */
  injected: boolean;
  /** Why we skipped, if we did. `undefined` on the happy path. */
  skipped?: "already-present" | "no-head";
};

/**
 * Inject the runtime tenancy contract tags into `html`.
 *
 *   - `mount` is the UI's mount path (`/surface/<name>`, no trailing slash).
 *     Used unchanged in `<meta name="parachute-mount">`; appended with `/`
 *     in `<base href>` (the trailing slash is browser-URL-resolution
 *     critical).
 *   - `hubOrigin` is the absolute hub URL (`http://127.0.0.1:1939` or
 *     `https://parachute.example.com`).
 *
 * Returns `{ html, injected, skipped? }`:
 *   - `injected: true` + `skipped: undefined` on the happy path.
 *   - `injected: false` + `skipped: "already-present"` when the source
 *     already declares `parachute-mount` (idempotent).
 *   - `injected: false` + `skipped: "no-head"` when the document has no
 *     `<head>` (malformed; caller logs + serves unmodified).
 *
 * Note we insert AFTER the opening `<head>` tag, not before `</head>` like
 * `dev-injection.ts` does. The contract tags should come BEFORE any
 * existing `<base>` / `<link rel=icon>` / `<script>` so the browser's
 * URL resolver picks up the injected `<base href>` for everything in the
 * document. (Per HTML spec, the first `<base>` wins — if the bundle ships
 * its own and we insert after it, the bundle's wins; inserting at head-top
 * lets the host's mount-aware base take precedence.)
 */
export function injectTenancyContract(
  html: string,
  mount: string,
  hubOrigin: string,
): TenancyInjectionResult {
  // Idempotent: bail if the marker is already in the doc.
  if (MOUNT_META_REGEX.test(html)) {
    return { html, injected: false, skipped: "already-present" };
  }

  // Find the first <head> that's NOT inside an HTML comment. Vite-built
  // HTML never has `<!-- <head> -->` comments, but be defensive — a
  // false match inside a comment would inject malformed HTML.
  let searchFrom = 0;
  let headMatch: RegExpExecArray | null = null;
  while (true) {
    HEAD_OPEN_REGEX.lastIndex = 0;
    const candidate = HEAD_OPEN_REGEX.exec(html.slice(searchFrom));
    if (!candidate) break;
    const absoluteIndex = searchFrom + candidate.index;
    if (!isInsideComment(html, absoluteIndex)) {
      headMatch = candidate;
      headMatch.index = absoluteIndex;
      break;
    }
    // Skip past this comment and search again.
    const commentClose = html.indexOf("-->", absoluteIndex);
    if (commentClose === -1) break;
    searchFrom = commentClose + 3;
  }
  if (!headMatch) {
    return { html, injected: false, skipped: "no-head" };
  }

  const baseHref = `${mount}/`;
  const block = [
    `<base href="${escapeHtmlAttr(baseHref)}">`,
    `<meta name="parachute-mount" content="${escapeHtmlAttr(mount)}">`,
    `<meta name="parachute-hub" content="${escapeHtmlAttr(hubOrigin)}">`,
  ].join("\n    ");

  const insertAt = headMatch.index + headMatch[0].length;
  return {
    html: `${html.slice(0, insertAt)}\n    ${block}${html.slice(insertAt)}`,
    injected: true,
  };
}

/**
 * True if `pos` falls inside an unclosed HTML comment that opens before
 * it. Used to skip `<head>` matches that are really `<!-- ... <head> ... -->`.
 */
function isInsideComment(html: string, pos: number): boolean {
  const lastOpen = html.lastIndexOf("<!--", pos);
  if (lastOpen === -1) return false;
  const closeAfterOpen = html.indexOf("-->", lastOpen);
  return closeAfterOpen !== -1 && closeAfterOpen > pos;
}
