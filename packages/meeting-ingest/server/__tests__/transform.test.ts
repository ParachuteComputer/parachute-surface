/**
 * Pure transform tests — a sample Fireflies transcript → the expected note
 * body, metadata, and tag. No network, no ctx.
 */

import { describe, expect, test } from "bun:test";
import { firefliesProvider } from "../providers/fireflies.ts";
import type { MeetingTranscript } from "../providers/types.ts";
import { buildMeetingNote, renderMeetingMarkdown } from "../transform.ts";

const SAMPLE: MeetingTranscript = {
  id: "FF123",
  title: "Weekly Sync",
  heldOnIso: "2026-06-10T15:00:00.000Z",
  durationMinutes: 42,
  attendees: ["Ada Lovelace", "Alan Turing"],
  sentences: [
    { speaker: "Ada Lovelace", text: "Let's start with the roadmap." },
    { speaker: "Alan Turing", text: "Agreed — I'll take the parser." },
    { speaker: null, text: "(crosstalk)" },
  ],
  summary: {
    overview: "The team aligned on the roadmap.",
    actionItems: ["Alan to own the parser", "Ada to draft the doc"],
    keywords: ["roadmap", "parser"],
  },
};

describe("renderMeetingMarkdown", () => {
  const md = renderMeetingMarkdown(SAMPLE);

  test("title heading", () => {
    expect(md.startsWith("# Weekly Sync\n")).toBe(true);
  });

  test("metadata line carries held-on, duration, attendee count", () => {
    expect(md).toContain("2026-06-10T15:00:00.000Z · 42 min · 2 attendees");
  });

  test("attendees line", () => {
    expect(md).toContain("**Attendees:** Ada Lovelace, Alan Turing");
  });

  test("summary section with overview, action items, keywords", () => {
    expect(md).toContain("## Summary");
    expect(md).toContain("The team aligned on the roadmap.");
    expect(md).toContain("- Alan to own the parser");
    expect(md).toContain("**Keywords:** roadmap, parser");
  });

  test("transcript section with speaker-prefixed sentences", () => {
    expect(md).toContain("## Transcript");
    expect(md).toContain("**Ada Lovelace:** Let's start with the roadmap.");
    expect(md).toContain("**Alan Turing:** Agreed — I'll take the parser.");
    // Null speaker falls back to "Speaker".
    expect(md).toContain("**Speaker:** (crosstalk)");
  });
});

describe("buildMeetingNote", () => {
  const note = buildMeetingNote(firefliesProvider, SAMPLE, { tag: "meeting" });

  test("tag is the configured working tag", () => {
    expect(note.tags).toEqual(["meeting"]);
  });

  test("metadata carries source + external_id + held_on + title + attendees", () => {
    expect(note.metadata).toMatchObject({
      source: "fireflies",
      external_id: "fireflies:FF123",
      held_on: "2026-06-10T15:00:00.000Z",
      title: "Weekly Sync",
      attendees: "Ada Lovelace, Alan Turing",
      attendee_count: 2,
      duration_minutes: 42,
    });
  });

  test("body equals the rendered markdown", () => {
    expect(note.content).toBe(renderMeetingMarkdown(SAMPLE));
  });

  test("respects a custom tag", () => {
    const custom = buildMeetingNote(firefliesProvider, SAMPLE, { tag: "meeting/fireflies" });
    expect(custom.tags).toEqual(["meeting/fireflies"]);
  });
});

describe("resilient transform — sparse transcript", () => {
  const sparse: MeetingTranscript = {
    id: "FF000",
    title: null,
    heldOnIso: null,
    durationMinutes: null,
    attendees: [],
    sentences: [],
    summary: null,
  };
  const md = renderMeetingMarkdown(sparse);

  test("untitled fallback heading", () => {
    expect(md.startsWith("# Untitled meeting\n")).toBe(true);
  });

  test("transcript section is still present with a placeholder", () => {
    expect(md).toContain("## Transcript");
    expect(md).toContain("*(no transcript content)*");
  });

  test("no summary section when summary is absent", () => {
    expect(md).not.toContain("## Summary");
  });

  test("note metadata still carries source + external_id", () => {
    const note = buildMeetingNote(firefliesProvider, sparse, { tag: "meeting" });
    expect(note.metadata).toMatchObject({ source: "fireflies", external_id: "fireflies:FF000" });
    expect(note.metadata?.held_on).toBeUndefined();
  });
});
