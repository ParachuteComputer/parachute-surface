/**
 * Dev-mode reload-script injection — Phase 1.3.
 *
 * When a UI is in dev mode AND its `index.html` is served, we inject a
 * small `<script>` that opens an EventSource against the SSE reload
 * endpoint and reloads the tab on a `reload` event. The script is
 * idempotent — re-injection doesn't duplicate because we tag it with a
 * known `id` and skip if that id is already present.
 *
 * Why string scanning instead of cheerio:
 *
 *   We considered `cheerio` (the brief explicitly invites it), but a
 *   500KB+ HTML-parser dep for ONE conservative insertion is the wrong
 *   shape. The injection point is well-defined: just before `</head>`.
 *   The regex is case-insensitive and tolerates whitespace. The
 *   fallback chain (head → first `<script>` → first `<body>` → append)
 *   handles the unusual cases the brief calls out.
 *
 *   Cheerio also serializes the document on output, which would re-emit
 *   the operator's HTML in cheerio's canonical form. For a dev-mode
 *   shim we want the document untouched apart from one inserted line.
 *
 *   If we ever need richer manipulation (CSP rewrites, link-prefetch
 *   stripping, etc.) we revisit. For now, regex.
 *
 * Idempotency contract:
 *
 *   - `id="parachute-app-dev-reload"` is the marker. Any earlier
 *     injection sets it, so a re-render finds it and skips.
 *   - The marker check is regex-based; we don't parse the HTML to find
 *     it. False positives (a comment containing the exact marker)
 *     would suppress injection harmlessly — dev mode would still work,
 *     it just wouldn't re-inject. Conservative.
 */

/**
 * Marker id used to deduplicate the injected `<script>`. Exported because
 * tests assert on it.
 */
export const DEV_RELOAD_SCRIPT_ID = "parachute-app-dev-reload" as const;

/**
 * Marker regex matching the script tag's `id` attribute. We accept both
 * quote styles (`id="..."` and `id='...'`).
 */
const ID_MARKER_REGEX = new RegExp(
  `id\\s*=\\s*['"]${DEV_RELOAD_SCRIPT_ID.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}['"]`,
  "i",
);

/** Find `</head>` (case-insensitive, whitespace-tolerant). */
const HEAD_CLOSE_REGEX = /<\/\s*head\s*>/i;
/** Find the first `<script ...>` tag. */
const FIRST_SCRIPT_REGEX = /<script\b/i;
/** Find the opening `<body ...>` tag. */
const BODY_OPEN_REGEX = /<body\b[^>]*>/i;

/**
 * Build the dev-reload script tag. The script:
 *   - Opens an EventSource against `<endpoint>` (mount-relative path).
 *   - On `reload`, schedules a `window.location.reload()` 200ms out
 *     (debounce — covers the case where a Phase 2 watcher fires the same
 *     event twice in quick succession).
 *   - Silently ignores errors; EventSource auto-reconnects on transient
 *     drops by default.
 *
 * `endpoint` is relative to the UI's mount path (e.g. `/app/notes/_dev/reload`)
 * — passed in so we can build absolute URLs the browser will navigate to
 * correctly regardless of the document's `<base>` tag.
 */
export function buildDevReloadScript(endpoint: string): string {
  // The endpoint is interpolated as a string literal; escape any embedded
  // quote / backslash so a hostile mount path can't break out. Mount
  // paths are constrained by PATH_PATTERN so this is belt-and-braces.
  const safeEndpoint = JSON.stringify(endpoint);
  return `<script id="${DEV_RELOAD_SCRIPT_ID}">
(() => {
  try {
    const es = new EventSource(${safeEndpoint});
    let pending = false;
    es.addEventListener("reload", () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { window.location.reload(); }, 200);
    });
    es.addEventListener("error", () => {
      /* EventSource auto-reconnects; nothing to do */
    });
  } catch (e) {
    console.warn("[parachute-app dev-reload] failed to start:", e);
  }
})();
</script>`;
}

/**
 * Inject the dev-reload script into `html`. If the marker is already
 * present, return `html` unchanged (idempotent). Otherwise insert the
 * `<script>` immediately before `</head>`. Fallback chain when there's
 * no `</head>`:
 *
 *   1. Before the first `<script>` tag.
 *   2. After the opening `<body>` tag.
 *   3. Append to end (with a `console.warn` from the script itself —
 *      callers also log a warning so operators see the affordance).
 *
 * Returns `{ html, injected, fallback }`:
 *   - `html`: the (maybe-modified) document.
 *   - `injected`: did we change anything?
 *   - `fallback`: which fallback branch fired (or `undefined` for the
 *     happy path). Tests + log surface this.
 */
export function injectDevReloadScript(
  html: string,
  endpoint: string,
): {
  html: string;
  injected: boolean;
  fallback?: "before-script" | "after-body" | "append";
} {
  // Idempotent: bail if the marker is already in the doc.
  if (ID_MARKER_REGEX.test(html)) {
    return { html, injected: false };
  }
  const script = `${buildDevReloadScript(endpoint)}\n`;

  // Happy path: just before </head>.
  const headMatch = HEAD_CLOSE_REGEX.exec(html);
  if (headMatch) {
    const idx = headMatch.index;
    return {
      html: `${html.slice(0, idx)}${script}${html.slice(idx)}`,
      injected: true,
    };
  }

  // Fallback 1: before the first <script>.
  const scriptMatch = FIRST_SCRIPT_REGEX.exec(html);
  if (scriptMatch) {
    const idx = scriptMatch.index;
    return {
      html: `${html.slice(0, idx)}${script}${html.slice(idx)}`,
      injected: true,
      fallback: "before-script",
    };
  }

  // Fallback 2: after the opening <body>.
  const bodyMatch = BODY_OPEN_REGEX.exec(html);
  if (bodyMatch) {
    const idx = bodyMatch.index + bodyMatch[0].length;
    return {
      html: `${html.slice(0, idx)}\n${script}${html.slice(idx)}`,
      injected: true,
      fallback: "after-body",
    };
  }

  // Fallback 3: append. Operators with a malformed document still get
  // the affordance.
  return {
    html: `${html}\n${script}`,
    injected: true,
    fallback: "append",
  };
}
