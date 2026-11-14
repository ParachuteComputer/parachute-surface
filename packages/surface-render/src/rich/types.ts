/**
 * Types for the vendored rich-notes-kit (`./kit/`, plain JS). Copied from the
 * kit's own `dist/rich-notes-kit.d.ts`, trimmed to what surface-render uses.
 */

/** A note as the kit reads it. surface-client's `Note` satisfies it. */
export interface RichNote {
  content: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  path?: string;
  id?: string;
  updatedAt?: string;
}

/** The parsed note (`parse(note)`), trimmed to the fields surface-render reads. */
export interface RichDoc {
  kind: "rich-note";
  type: string | null;
  title: string;
  tasks: unknown[];
  log: unknown[];
  tables: { chart: boolean }[];
  callouts: unknown[];
  details: unknown[];
  warnings: { line: number; rule: string; message: string }[];
}

/** One-line content edit the kit hands the host with a save. */
export interface RichPatch {
  op: "replace" | "insert";
  line: number;
  before?: string;
  after: string;
  why?: "task" | "log";
  revision?: string | null;
  id?: string | null;
  path?: string | null;
}

/** What the host gives the kit. Every hook is optional. */
export interface RichHost {
  save?(content: string, patch: RichPatch): Promise<unknown>;
  openNote?(target: string): void;
  openLink?(href: string): void;
  image?(path: string): Promise<string>;
  calm?: boolean | (() => boolean);
  units?: "us" | "metric";
  view?: string;
  plainText?: boolean;
  today?: string;
}

export interface RichHandle {
  readonly root: HTMLElement;
  update(next: RichNote | RichDoc): void;
  destroy(): void;
}
