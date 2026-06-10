/**
 * Schema and serialization are versioned TOGETHER: this constant equals the
 * package version (pinned by `src/__tests__/version.test.ts`), and one
 * package version covers the schema, the TipTap extension list that produces
 * it, and the markdown codec's canonical form. Any change to node/mark
 * shapes, escaping, or canonical output is a version bump of this package —
 * never of one half.
 */
export const DOC_SCHEMA_VERSION = "0.1.0";
