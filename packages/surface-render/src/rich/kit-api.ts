/**
 * The one seam onto the vendored kit (`./kit/`, plain JS compiled with
 * `allowJs`, typed by the kit's own `./kit/index.d.ts`). Everything else in
 * surface-render imports the kit through here.
 */
import * as kit from "./kit/index.js";

export type {
  Note as RichNote,
  Doc as RichDoc,
  Host as RichHost,
  Patch as RichPatch,
  Handle as RichHandle,
} from "./kit/index.js";

export const parseRichNote = kit.parse;
export const mountRichNote = kit.mount;
/**
 * Does this note use a pattern the rich view draws and `MarkdownView` can't?
 * A typed note (recipe, minutes, session, chant), tasks, a dated log, a
 * callout, a `<details>` block or a chartable table. Facts and `##` sections
 * alone don't count. The kit's own rule, so every host draws the same line.
 */
export const needsRich = kit.needsRich;
/** The kit's version and the PATTERNS contract it implements. */
export const RICH_NOTES_KIT_VERSION: string = kit.version;
export const RICH_NOTES_CONTRACT: string = kit.contract;
