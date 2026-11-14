/**
 * The one typed seam onto the vendored kit (`./kit/`, plain JS compiled with
 * `allowJs`). Everything else in surface-render imports the kit through here.
 */
import * as kit from "./kit/index.js";
import type { RichDoc, RichHandle, RichHost, RichNote } from "./types.js";

export const parseRichNote = kit.parse as (note: RichNote, opts?: { type?: string }) => RichDoc;
export const mountRichNote = kit.mount as (
  el: Element,
  doc: RichDoc,
  host?: RichHost,
) => RichHandle;
/** The kit's version and the PATTERNS contract it implements. */
export const RICH_NOTES_KIT_VERSION: string = kit.version;
export const RICH_NOTES_CONTRACT: string = kit.contract;

/**
 * Does this note use a pattern the rich view draws and `MarkdownView` can't?
 * A typed note (recipe, minutes, session, chant), tasks (G3), a dated log
 * (G4), a callout (G5), a `<details>` block (G6) or a chartable table (G7).
 * Facts (G1) and `##` sections (G2) alone don't count: nearly every note has
 * them, and a plain note keeps drawing exactly as before.
 */
export function hasRichPattern(doc: RichDoc): boolean {
  return Boolean(
    doc.type ||
      doc.tasks.length ||
      doc.log.length ||
      doc.callouts.length ||
      doc.details.length ||
      doc.tables.some((t) => t.chart),
  );
}
