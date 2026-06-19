/**
 * Transcript → `#meeting` note transform. Provider-agnostic: takes the
 * normalized {@link MeetingTranscript} and produces the exact
 * {@link CreateNotePayload} the surface writes via `ctx.vault.createNote`.
 *
 * The BODY is a clean portable-markdown doc (so the note reads well in any
 * surface over the vault); the METADATA carries the structured handles
 * (`external_id` for idempotent dedup, `held_on`, `source`, …); the TAGS
 * are `[tag]` (default `"meeting"`).
 *
 * SECURITY: secrets never enter here — the transform sees only transcript
 * content, never the api key or webhook secret.
 */

import type { CreateNotePayload } from "@openparachute/surface-client";
import { type MeetingProvider, type MeetingTranscript, externalIdFor } from "./providers/types.ts";

/** Markdown-escape a heading/inline value's most disruptive characters. */
function inline(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/** Build the markdown body for a transcript. */
export function renderMeetingMarkdown(t: MeetingTranscript): string {
  const lines: string[] = [];
  const title = t.title && t.title.trim().length > 0 ? inline(t.title) : "Untitled meeting";
  lines.push(`# ${title}`);
  lines.push("");

  // A single metadata line — human-readable, complements the note metadata.
  const metaBits: string[] = [];
  if (t.heldOnIso) metaBits.push(t.heldOnIso);
  if (t.durationMinutes !== null) metaBits.push(`${t.durationMinutes} min`);
  if (t.attendees.length > 0) metaBits.push(`${t.attendees.length} attendees`);
  if (metaBits.length > 0) {
    lines.push(`*${metaBits.join(" · ")}*`);
    lines.push("");
  }
  if (t.attendees.length > 0) {
    lines.push(`**Attendees:** ${t.attendees.map(inline).join(", ")}`);
    lines.push("");
  }

  if (t.summary) {
    const { overview, actionItems, keywords } = t.summary;
    if (overview || actionItems.length > 0 || keywords.length > 0) {
      lines.push("## Summary");
      lines.push("");
      if (overview) {
        lines.push(overview.trim());
        lines.push("");
      }
      if (actionItems.length > 0) {
        lines.push("**Action items:**");
        lines.push("");
        for (const item of actionItems) lines.push(`- ${inline(item)}`);
        lines.push("");
      }
      if (keywords.length > 0) {
        lines.push(`**Keywords:** ${keywords.map(inline).join(", ")}`);
        lines.push("");
      }
    }
  }

  lines.push("## Transcript");
  lines.push("");
  if (t.sentences.length === 0) {
    lines.push("*(no transcript content)*");
  } else {
    for (const s of t.sentences) {
      const speaker = s.speaker ? inline(s.speaker) : "Speaker";
      lines.push(`**${speaker}:** ${inline(s.text)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export interface BuildNoteOptions {
  /** Tag to apply (default `"meeting"`). */
  tag: string;
}

/** Build the full create-note payload for a transcript from `provider`. */
export function buildMeetingNote(
  provider: MeetingProvider,
  t: MeetingTranscript,
  opts: BuildNoteOptions,
): CreateNotePayload {
  const title = t.title && t.title.trim().length > 0 ? inline(t.title) : "Untitled meeting";
  const metadata: Record<string, unknown> = {
    source: provider.name,
    external_id: externalIdFor(provider, t.id),
    title,
  };
  if (t.heldOnIso) metadata.held_on = t.heldOnIso;
  if (t.attendees.length > 0) {
    metadata.attendees = t.attendees.join(", ");
    metadata.attendee_count = t.attendees.length;
  }
  if (t.durationMinutes !== null) metadata.duration_minutes = t.durationMinutes;

  return {
    content: renderMeetingMarkdown(t),
    tags: [opts.tag],
    metadata,
  };
}
