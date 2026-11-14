// rich-notes-kit: types for src/index.js, the ES module (dist/rich-notes-kit.mjs) and the classic script's global `RichNotes`.
// The one type file: it sits beside src/index.js for a host that vendors src/, and the build copies it to dist/.
export interface Note { content: string; metadata?: Record<string, unknown>; tags?: string[]; path?: string; id?: string; updatedAt?: string; type?: string }
export interface Warning { line: number; rule: string; message: string }
export interface Fact { key: string; value: unknown; from: 'metadata' | 'content' }
export interface Task { line: number; done: boolean; text: string; owners: string[]; due: string | null; section: string }
export interface LogLine { line: number; date: string; text: string; section: string }
export interface Table { line: number; head: string[]; rows: string[][]; numeric: number[]; dates: boolean; chart: boolean; section: string }
export interface Doc {
  kind: 'rich-note'; version: 1; id: string | null; path: string | null; revision: string | null;
  type: string | null; title: string; titleLine: number | null; lead: number | null;
  facts: Fact[]; tags: string[]; sections: { name: string; key: string; line: number; endLine: number; intro: boolean }[];
  tasks: Task[]; log: LogLine[]; tables: Table[]; callouts: { line: number; kind: string }[];
  details: { line: number; open: boolean; summary: string | null }[]; warnings: Warning[];
  recipe?: unknown; minutes?: unknown; session?: unknown; chant?: unknown;
  readonly content: string; fact(...keys: string[]): unknown;
}
export interface Patch { op: 'replace' | 'insert'; line: number; before?: string; after: string; why?: 'task' | 'log'; revision?: string | null; id?: string | null; path?: string | null }
export interface Host {
  /** A content write: the whole new text and the one line that changed. Reject with {status: 409} when stale.
   *  Resolve first, then hand the kit the saved note (update()); a note handed over inside save() reads as
   *  "reloaded while it saved". Returning {updatedAt} is enough for the kit to carry on. */
  save?(content: string, patch: Patch): Promise<{ updatedAt?: string } | void>;
  openNote?(target: string): void;
  openLink?(href: string): void;
  /** The image's src as markdown-it normalises it (URL-encoded: `crème.jpg` arrives as `cr%C3%A8me.jpg`; the same
   *  string a markdown host gets), less its `#fragment` → a blob: or data:image/ URL. Asked once per src per view; after a rejection or an unsafe answer, again on the next draw.
   *  Asked only when the src, read at every level of a lenient decode (each valid `%XX` below `%80` alone, a stray `%`
   *  kept) to a fixed point within eight levels, has no segment of only dots and spaces with a dot in it (`.`, `..`, `...`, `.. `; ended by `/`, `?`, `#`, `;` or the end), no `\`,
   *  no control character, no space at either end and no overlong UTF-8 escape (`%C0`, `%C1`, `%E0%8x`, `%E0%9x`, `%F0%8x`),
   *  and, unless isAttachment said yes to it, no scheme and no leading `//`. Bytes from `%80` up are not decoded, and
   *  no check is complete for every server: the host still checks the src it is handed.
   *  Reject, or hand back anything else, and it reads "(not loaded)". */
  image?(src: string): Promise<string>;
  /** Opt-in, used only with image(). Called only for an absolute src (a scheme or a leading `//`), fragment stripped,
   *  whose authority holds no `@`, `%` or `\`; return true when it is one of the host's own attachments, and it goes to
   *  image() under the same path checks, and no `//` may appear in its path at any level. Without it, or on false or a throw,
   *  every absolute src is a link and is never loaded. */
  isAttachment?(src: string): boolean;
  keepAwake?(on: boolean): Promise<boolean> | boolean;
  calm?: boolean | (() => boolean);
  /** The reader's lasting choice; without it amounts and heat show as written until the reader picks a system. */
  units?: 'us' | 'metric';
  view?: string;
  plainText?: boolean;
  today?: string;
  now?(): number;
}
export interface Handle { readonly root: HTMLElement; readonly doc: Doc; readonly state: object; update(next: Note | Doc | string): void; redraw(): void; destroy(): void }
export interface EditResult { content: string; patch: Patch }
export function parse(note: Note | string, opts?: { type?: string }): Doc;
export function mount(el: Element, doc: Doc | Note | string, host?: Host): Handle;
export function render(el: Element, note: Note | string, host?: Host): Handle;
export function plainText(doc: Doc): string;
export function registerType(def: { tag: string; sections?: Record<string, string[]>; facts?: string[]; logs?: string[]; chartsFirst?: string[]; fences?: Record<string, Function>; fact?: Function; read?: Function; draw?: Function }): string;
/** A type, tasks, a log, a callout, <details> or a chartable table. Facts and sections alone don't count. */
export function needsRich(doc: Doc | Note | string): boolean;
export function typeNames(): string[];
export const edit: { toggleTask(content: string, line: number, done?: boolean): EditResult | null; appendLog(content: string, names: string | string[], date: string, text?: string): EditResult };
export const rules: Record<string, Function>;
export const RULE_TEXT: Record<string, string>;
export const version: string;
export const contract: string;
