/**
 * Schema + serialization are versioned together: DOC_SCHEMA_VERSION is the
 * package version, by definition. This pin makes the contract mechanical —
 * bump one, the test forces the other.
 */
import { expect, test } from "bun:test";
import { DOC_SCHEMA_VERSION } from "../index";

test("DOC_SCHEMA_VERSION equals the package version", async () => {
  const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
    version: string;
  };
  expect(DOC_SCHEMA_VERSION).toBe(pkg.version);
});
