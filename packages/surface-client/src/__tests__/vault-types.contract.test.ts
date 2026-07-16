/**
 * Compile-time contract check for the write-attribution fields
 * (`createdBy` / `createdVia` / `lastUpdatedBy` / `lastUpdatedVia`,
 * vault#298) on the PUBLIC barrel's `Note` / `NoteSummary` types.
 *
 * This is a type-level fixture, not a runtime test — no assertions run;
 * the file's job is to fail `tsc` if the barrel's exported shapes drift.
 * `tsconfig.json` excludes `__tests__` from the build, and `bun test`
 * alone doesn't typecheck (it transpiles, stripping types), so this only
 * gets checked by the sibling `tsconfig.test.json` (see its header
 * comment) — wired into both this package's `typecheck` script and the
 * root `typecheck:all`. That sibling config deliberately globs only
 * `*.contract.test.ts`, not all of `__tests__` — keep new compile-time-only
 * fixtures on that naming convention rather than widening the glob.
 */
import { describe, test } from "bun:test";
import type { Note, NoteSummary } from "../index.ts";

describe("Note/NoteSummary — write-attribution contract (compile-time only)", () => {
  test("no-op — see the type assertions below this block", () => {
    // Intentionally empty. The fixtures live at module scope so `tsc`
    // evaluates them regardless of whether this test runs.
  });
});

// Positive: all four fields accept a string, and independently accept
// `null` (the "written before attribution existed" / no-context case) —
// per Note.createdBy's doc comment, both are legitimate, distinct states.
const _withAttributionStrings: Note = {
  id: "n1",
  createdAt: "2026-07-16T00:00:00Z",
  createdBy: "user:abc123",
  createdVia: "surface:notes",
  lastUpdatedBy: "agent:def456",
  lastUpdatedVia: "mcp",
};

const _withAttributionNulls: Note = {
  id: "n2",
  createdAt: "2026-07-16T00:00:00Z",
  createdBy: null,
  createdVia: null,
  lastUpdatedBy: null,
  lastUpdatedVia: null,
};

// Positive: fields are optional — a Note predating vault#298 omits them
// entirely and still satisfies the type (legacy compatibility).
const _withoutAttribution: Note = {
  id: "n3",
  createdAt: "2026-07-16T00:00:00Z",
};

const _summaryWithAttribution: NoteSummary = {
  id: "n4",
  createdBy: "operator",
  createdVia: "cli",
  lastUpdatedBy: null,
  lastUpdatedVia: null,
};

// Negative: a non-string, non-null value must be rejected on each field —
// proves the contract is `string | null`, not `any`/`unknown`.
const _rejectsWrongType: Note = {
  id: "n5",
  createdAt: "2026-07-16T00:00:00Z",
  // @ts-expect-error createdBy must be string | null, not a number
  createdBy: 42,
};

const _rejectsWrongTypeVia: Note = {
  id: "n6",
  createdAt: "2026-07-16T00:00:00Z",
  // @ts-expect-error createdVia must be string | null, not a number
  createdVia: 42,
};

const _rejectsWrongTypeLastUpdatedBy: Note = {
  id: "n7",
  createdAt: "2026-07-16T00:00:00Z",
  // @ts-expect-error lastUpdatedBy must be string | null, not a boolean
  lastUpdatedBy: true,
};

const _rejectsWrongTypeLastUpdatedVia: NoteSummary = {
  id: "n8",
  // @ts-expect-error lastUpdatedVia must be string | null, not a number
  lastUpdatedVia: 42,
};

// Reference the fixtures so `noUnusedLocals`-style linting (if ever
// enabled) doesn't flag them — the assignments above are the check.
void _withAttributionStrings;
void _withAttributionNulls;
void _withoutAttribution;
void _summaryWithAttribution;
void _rejectsWrongType;
void _rejectsWrongTypeVia;
void _rejectsWrongTypeLastUpdatedBy;
void _rejectsWrongTypeLastUpdatedVia;
