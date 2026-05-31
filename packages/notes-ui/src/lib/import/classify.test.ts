import { describe, expect, it } from "vitest";
import { isMarkdownLike } from "./detect";
import { isExcludedPath } from "./obsidian";

/**
 * Obsidian alignment contract — intake/classifier fixtures (§3).
 *
 * Same predicates the vault CLI asserts (`isMarkdownExtension`,
 * `isExcludedPath`), proving the two importers select the same files.
 * The web's markdown classifier is `isMarkdownLike` (detect.ts); it maps
 * to the contract's abstract `isMarkdownExtension`.
 */
describe("alignment contract fixtures — classifier tier", () => {
  describe("FX-MARKDOWN-EXT — markdown extension classification", () => {
    it("accepts .markdown and .md, rejects .mdx", () => {
      expect(isMarkdownLike(new File([], "x.markdown"))).toBe(true);
      expect(isMarkdownLike(new File([], "x.md"))).toBe(true);
      expect(isMarkdownLike(new File([], "x.mdx"))).toBe(false);
    });
    it("is case-insensitive", () => {
      expect(isMarkdownLike(new File([], "X.MD"))).toBe(true);
      expect(isMarkdownLike(new File([], "X.MARKDOWN"))).toBe(true);
    });
  });

  describe("FX-DOTDIR-EXCLUDE — intake exclusion", () => {
    it("excludes named internal dirs + generic dotfiles, keeps real notes", () => {
      expect(isExcludedPath(".obsidian/app.json")).toBe(true);
      expect(isExcludedPath(".trash/x.md")).toBe(true);
      expect(isExcludedPath(".git/config")).toBe(true);
      expect(isExcludedPath(".parachute/vault.yaml")).toBe(true);
      expect(isExcludedPath("__MACOSX/x")).toBe(true);
      expect(isExcludedPath("node_modules/y/z.md")).toBe(true);
      expect(isExcludedPath(".DS_Store")).toBe(true);
      expect(isExcludedPath("sub/.hidden.md")).toBe(true);
      expect(isExcludedPath("Notes/a.md")).toBe(false);
      expect(isExcludedPath("Notes/Sub/b.markdown")).toBe(false);
    });
  });
});
