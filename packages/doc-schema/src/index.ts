/**
 * @openparachute/doc-schema — the shared document schema + markdown codec.
 *
 * This entry is ISOMORPHIC and DOM-free (no TipTap in its import graph): a
 * server imports it for JSON ⇄ markdown; a browser imports it alongside
 * `@openparachute/doc-schema/tiptap` for the editor extension list that
 * compiles to the identical schema.
 */
export {
  createTextQuoteSelector,
  resolveTextQuoteSelector,
  type TextQuoteSelector,
} from "./anchors";
export {
  type DocJSON,
  docFromJSON,
  docToMarkdown,
  markdownToDoc,
  markdownToDocJSON,
} from "./codec";
export { parser, tokenizer } from "./markdown/parser";
export { serializer, wikilinkPattern } from "./markdown/serializer";
export { schema } from "./schema";
export { DOC_SCHEMA_VERSION } from "./version";
