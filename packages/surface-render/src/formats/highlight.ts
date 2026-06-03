/**
 * Code-highlight hook. Given source code and a language id, return an HTML
 * string (already escaped/sanitized) to render inside `<code>`.
 *
 * The DEFAULT is HTML-escape-only — no syntax coloring, no dependency. This
 * keeps `highlight.js` (or any highlighter) out of surface-render's tree by
 * default; a surface that wants coloring passes its own `highlight` hook
 * (e.g. one backed by `highlight.js` with the languages it cares about, the
 * way notes-ui registers a `core` build with a handful of languages).
 */
export type HighlightFn = (code: string, language: string) => string;

/**
 * Complete for both content (`<code>…</code>`) and attribute contexts.
 * Escapes the five HTML-significant characters so arbitrary code renders as
 * inert text — never as live markup.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** The safe default highlighter — escape only, no coloring. */
export const escapeOnlyHighlight: HighlightFn = (code) => escapeHtml(code);
