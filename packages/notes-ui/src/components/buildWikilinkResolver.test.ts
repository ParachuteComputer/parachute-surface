import type { Note } from "@/lib/vault/types";
import { describe, expect, it } from "vitest";
import { buildWikilinkResolver } from "./MarkdownView";

// Focused unit coverage for the load-bearing resolver-adaptation that bridges
// notes-ui's note-link table to surface-render's
// `(target) => { href, exists } | null` contract. (Replaces the coverage the
// deleted remark-wikilinks.test.ts gave the old resolver; buildWikilinkResolver
// is otherwise only exercised integration-style through NoteView.)

function makeNote(links: Note["links"]): Note {
  return {
    id: "me",
    path: "Canon/Aaron",
    createdAt: "2026-04-16T00:00:00Z",
    content: "",
    tags: [],
    links,
    attachments: [],
  } as Note;
}

describe("buildWikilinkResolver", () => {
  it("resolves a target present in note.links → { href: /n/<id>, exists: true }", () => {
    const resolve = buildWikilinkResolver(
      makeNote([
        {
          sourceId: "me",
          targetId: "uni-id",
          relationship: "wikilink",
          targetNote: { id: "uni-id", path: "Canon/Uni" },
        },
      ]),
    );

    // Resolve by display path…
    expect(resolve("Canon/Uni")).toEqual({ href: "/n/uni-id", exists: true });
    // …and by raw id (both keys are populated).
    expect(resolve("uni-id")).toEqual({ href: "/n/uni-id", exists: true });
  });

  it("returns { href: /n/<encoded target>, exists: false } for unresolved targets (NOT null — preserves create-on-navigate)", () => {
    const resolve = buildWikilinkResolver(makeNote([]));

    const result = resolve("Missing/Note");
    // Crucially NOT null — that would drop the link entirely; notes-ui links
    // unresolved wikilinks to a create-on-navigate route.
    expect(result).not.toBeNull();
    expect(result).toEqual({
      href: `/n/${encodeURIComponent("Missing/Note")}`,
      exists: false,
    });
  });

  it("percent-encodes ids and unresolved targets in the href", () => {
    const resolve = buildWikilinkResolver(
      makeNote([
        {
          sourceId: "me",
          targetId: "id with space",
          relationship: "wikilink",
          targetNote: { id: "id with space", path: "Has Space/Note" },
        },
      ]),
    );

    expect(resolve("Has Space/Note")).toEqual({
      href: `/n/${encodeURIComponent("id with space")}`,
      exists: true,
    });
    expect(resolve("Other Missing/Note")).toEqual({
      href: `/n/${encodeURIComponent("Other Missing/Note")}`,
      exists: false,
    });
  });

  it("maps both display-path and id → id, and ignores links not sourced from this note or lacking a targetNote", () => {
    const resolve = buildWikilinkResolver(
      makeNote([
        // Sourced from a different note → must be ignored (inbound link).
        {
          sourceId: "someone-else",
          targetId: "inbound-id",
          relationship: "wikilink",
          targetNote: { id: "inbound-id", path: "Inbound/Note" },
        },
        // No resolved targetNote → must be ignored.
        {
          sourceId: "me",
          targetId: "dangling-id",
          relationship: "wikilink",
        },
        // Valid outbound link → both path and id map to the id.
        {
          sourceId: "me",
          targetId: "good-id",
          relationship: "wikilink",
          targetNote: { id: "good-id", path: "Good/Note" },
        },
      ]),
    );

    // Inbound link's target is not in the resolver map → unresolved.
    expect(resolve("Inbound/Note")).toEqual({
      href: `/n/${encodeURIComponent("Inbound/Note")}`,
      exists: false,
    });
    // Valid outbound: resolvable by both display-path and id.
    expect(resolve("Good/Note")).toEqual({ href: "/n/good-id", exists: true });
    expect(resolve("good-id")).toEqual({ href: "/n/good-id", exists: true });
  });
});
