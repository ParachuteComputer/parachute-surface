import { extractHashtags } from "@/lib/capture/hashtags";
import { describe, expect, it } from "vitest";

// Moved here from Capture.test.tsx when the standalone Capture route was
// retired into the unified NoteNew screen. The helper itself stayed
// behavior-identical — same regex, same Set-based dedupe — so these tests
// transferred verbatim.

describe("extractHashtags", () => {
  it("pulls #tags out and dedupes", () => {
    expect(extractHashtags("got an #idea today and another #idea")).toEqual(["idea"]);
  });

  it("ignores #-not-at-boundary", () => {
    expect(extractHashtags("foo#bar baz #real")).toEqual(["real"]);
  });

  it("works at start of string", () => {
    expect(extractHashtags("#first thing")).toEqual(["first"]);
  });

  it("returns [] when none", () => {
    expect(extractHashtags("nothing tagged here")).toEqual([]);
  });

  it("preserves case-distinct tags as separate entries — vault is case-sensitive on tag-identity rows", () => {
    // Notes-side normalizeTag does NOT lowercase (see TagEditor.normalizeTag).
    // Vault treats `#Idea` and `#idea` as distinct identity rows. The
    // extraction has to mirror that: surface both, let the operator dedupe.
    expect(extractHashtags("#Idea and #idea today #Idea")).toEqual(["Idea", "idea"]);
  });
});
