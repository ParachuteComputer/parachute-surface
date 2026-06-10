/**
 * The markdown codec — the package's server-facing face.
 *
 * Isomorphic and DOM-free: this module (and everything it imports) never
 * touches `document`/`window`, so a Bun/Node process can import it for
 * JSON ⇄ markdown work with zero shims. Pinned by
 * `src/__tests__/isomorphism.test.ts` (a subprocess with booby-trapped DOM
 * globals imports this entry and round-trips a document).
 */
import { Node } from "prosemirror-model";
import { parser } from "./markdown/parser";
import { serializer } from "./markdown/serializer";
import { schema } from "./schema";

/**
 * A document as plain JSON (`Node.toJSON()` shape) — what rides the wire and
 * what `y-prosemirror` seeds from.
 */
export interface DocJSON {
  type: "doc";
  content?: unknown[];
  [key: string]: unknown;
}

/** Parse markdown into a ProseMirror document over the shared schema. */
export function markdownToDoc(markdown: string): Node {
  return parser.parse(markdown);
}

/** Parse markdown straight to the JSON shape (server convenience). */
export function markdownToDocJSON(markdown: string): DocJSON {
  return markdownToDoc(markdown).toJSON() as DocJSON;
}

/** Rehydrate a document from its JSON shape (validates against the schema). */
export function docFromJSON(json: DocJSON): Node {
  return Node.fromJSON(schema, json);
}

/**
 * Serialize a document (Node or JSON) to canonical markdown.
 *
 * Canonical means: ATX headings, `-` bullets, tight lists, fenced code,
 * `---` rules, `*`/`**` emphasis. `emit(parse(md))` reaches a byte-stable
 * fixpoint by the second pass for any input; already-canonical markdown is
 * byte-stable on the first.
 */
export function docToMarkdown(doc: Node | DocJSON): string {
  const node = doc instanceof Node ? doc : docFromJSON(doc);
  return serializer.serialize(node, { tightLists: true });
}
