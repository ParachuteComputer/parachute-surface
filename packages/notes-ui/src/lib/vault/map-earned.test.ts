import { describe, expect, it } from "vitest";
import { MAP_EARN_LINKED_NOTES, MAP_EARN_VAULTS, isMapEarned, linkedNoteCount } from "./map-earned";
import type { Note } from "./types";

type Link = { sourceId: string; targetId: string; relationship: string };

function note(id: string, links: Link[] = []): Note {
  return { id, path: `${id}.md`, tags: [], links } as unknown as Note;
}

describe("isMapEarned", () => {
  it("is false below both thresholds", () => {
    expect(isMapEarned(0, 0)).toBe(false);
    expect(isMapEarned(1, MAP_EARN_LINKED_NOTES - 1)).toBe(false);
  });

  it("earns on ≥2 vaults regardless of links", () => {
    expect(isMapEarned(MAP_EARN_VAULTS, 0)).toBe(true);
    expect(isMapEarned(5, 0)).toBe(true);
  });

  it("earns on ≥15 linked notes regardless of vault count", () => {
    expect(isMapEarned(1, MAP_EARN_LINKED_NOTES)).toBe(true);
    expect(isMapEarned(1, 40)).toBe(true);
  });
});

describe("linkedNoteCount", () => {
  it("is 0 for no notes / undefined", () => {
    expect(linkedNoteCount(undefined)).toBe(0);
    expect(linkedNoteCount([])).toBe(0);
  });

  it("is 0 when notes carry no links", () => {
    expect(linkedNoteCount([note("a"), note("b"), note("c")])).toBe(0);
  });

  it("counts both endpoints of a real link as linked", () => {
    const notes = [note("a", [{ sourceId: "a", targetId: "b", relationship: "ref" }]), note("b")];
    expect(linkedNoteCount(notes)).toBe(2);
  });

  it("ignores links whose target isn't in the vault (no phantom degree)", () => {
    const notes = [note("a", [{ sourceId: "a", targetId: "missing", relationship: "ref" }])];
    expect(linkedNoteCount(notes)).toBe(0);
  });
});
