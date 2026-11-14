# rich-notes-kit, vendored

Kit commit: `3cf968172bd7f76f196c0419983fd233cc1dc486`

rich-notes-kit 0.2.0 (MIT, implements PATTERNS v0.3) draws a note richly:
recipes, minutes, session notes, chant charts, and for every note tasks, dated
logs, callouts, `<details>` and charts from number tables. It is framework-free
and loads nothing.

**Why vendored, not a dependency:** the kit is not on npm, and a publishable
package here may only depend on concrete semver (a `workspace:`/`link:`/git dep
leaks into the published manifest). Vendoring the kit's source keeps
surface-render self-contained: it builds, tests and publishes exactly as before,
with no new package to release first.

**Rules for this folder:**

- `kit/` and `vendor/` are the kit's `src/` (its `.js` files and the one type
  file, `index.d.ts`) and `vendor/markdown-it.mjs`, byte for byte; `../../rich-notes-kit.css` is its `src/kit.css`. Don't edit
  them here: change the kit, run its tests there, then
  `bun scripts/sync-rich-notes-kit.ts <kit checkout>` (`--check` to compare).
- `tsc` compiles them with `allowJs` (`checkJs` off); biome ignores them.
- Everything else in surface-render reaches the kit through `../kit-api.ts`,
  which re-exports the kit's own types (`Note`, `Doc`, `Host`, `Patch`,
  `Handle` as `RichNote`, `RichDoc`, …) and its `needsRich` rule.
- Licences: `THIRD_PARTY.md` at the package root.
