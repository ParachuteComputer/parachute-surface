import { normalizeTag } from "@/components/TagEditor";

// Extract `#tag` patterns from free-form note content. Used by the unified
// Create screen so a thought like "got #idea today" surfaces under #idea
// even when the operator didn't add the tag in the tag picker. Lives here
// (alongside the audio recorder) because the audio path leans on it too —
// extraction is part of "what does the content tell us about the note,"
// not a capture-vs-create concern.
//
// Anchored at start-of-string or whitespace so URLs like `example.com/#foo`
// don't get picked up.

const HASHTAG_RE = /(?:^|\s)#([a-zA-Z][\w-]*)/g;

export function extractHashtags(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(HASHTAG_RE)) {
    const tag = normalizeTag(m[1] ?? "");
    if (tag) out.add(tag);
  }
  return [...out];
}
