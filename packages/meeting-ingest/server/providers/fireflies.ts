/**
 * Fireflies.ai provider for the meeting-ingest surface.
 *
 * Webhook contract (verified against Fireflies' docs):
 *
 *   - The "Transcription complete" webhook POSTs a MINIMAL JSON body:
 *     `{ "meetingId": "...", "eventType": "Transcription completed",
 *        "clientReferenceId": "..." }`. `meetingId` and `transcriptId` are
 *     interchangeable; there is NO transcript content in the webhook.
 *   - Signature: header `x-hub-signature` carries a hex SHA-256 HMAC of the
 *     RAW request body, keyed by the operator's shared secret. We verify it
 *     constant-time. The header may be bare hex or `sha256=<hex>`.
 *
 * Transcript fetch: `POST https://api.fireflies.ai/graphql`, `Authorization:
 * Bearer <api_key>`. The query is kept resilient — only `title`, `date` /
 * `dateString`, `sentences`, and `participants` are load-bearing; the rest
 * (duration, attendees, summary) is best-effort.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MeetingProvider,
  MeetingTranscript,
  ProviderConfig,
  WebhookVerdict,
} from "./types.ts";

const GRAPHQL_ENDPOINT = "https://api.fireflies.ai/graphql";

/**
 * The event-type strings Fireflies sends on transcription completion. Docs
 * have used both "Transcription completed" and "Transcription complete";
 * accept both case-insensitively so a wording change doesn't drop events.
 */
const COMPLETE_EVENTS = new Set(["transcription completed", "transcription complete"]);

/** Resilient transcript query — see module header for the field contract. */
const TRANSCRIPT_QUERY = `query Transcript($id: String!) {
  transcript(id: $id) {
    title
    dateString
    date
    duration
    participants
    meeting_attendees { displayName email }
    sentences { speaker_name text }
    summary { overview action_items keywords }
  }
}`;

/** Strip an optional `sha256=` / `sha-256=` prefix; lower-case the hex. */
function normalizeSignature(header: string): string {
  const trimmed = header.trim();
  const eq = trimmed.indexOf("=");
  const hex = eq >= 0 && /^sha-?256$/i.test(trimmed.slice(0, eq)) ? trimmed.slice(eq + 1) : trimmed;
  return hex.trim().toLowerCase();
}

/** Constant-time hex compare — false on any length/parse mismatch. */
function hexEqualsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  // Buffer.from(hex) drops odd/invalid nibbles silently — guard on the
  // decoded length so a malformed signature can't slip through.
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

interface FirefliesEventBody {
  meetingId?: unknown;
  transcriptId?: unknown;
  eventType?: unknown;
}

interface FirefliesTranscriptNode {
  title?: string | null;
  dateString?: string | null;
  date?: number | string | null;
  duration?: number | null;
  participants?: unknown;
  meeting_attendees?: { displayName?: string | null; email?: string | null }[] | null;
  sentences?: { speaker_name?: string | null; text?: string | null }[] | null;
  summary?: {
    overview?: string | null;
    action_items?: unknown;
    keywords?: unknown;
  } | null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out;
}

/** Best-effort ISO instant from Fireflies' `date` (epoch ms) or `dateString`. */
function deriveHeldOn(node: FirefliesTranscriptNode): string | null {
  if (typeof node.date === "number" && Number.isFinite(node.date)) {
    const d = new Date(node.date);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof node.dateString === "string" && node.dateString.trim().length > 0) {
    const d = new Date(node.dateString);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return node.dateString.trim();
  }
  if (typeof node.date === "string" && node.date.trim().length > 0) {
    const d = new Date(node.date);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function attendeesFrom(node: FirefliesTranscriptNode): string[] {
  const names: string[] = [];
  for (const a of node.meeting_attendees ?? []) {
    const name = a?.displayName?.trim() || a?.email?.trim();
    if (name) names.push(name);
  }
  if (names.length === 0) names.push(...toStringArray(node.participants));
  // Dedupe, preserve first-seen order.
  return [...new Set(names)];
}

export const firefliesProvider: MeetingProvider = {
  name: "fireflies",
  idPrefix: "fireflies",

  verifyAndParse(
    rawBody: string,
    signatureHeader: string | null,
    cfg: ProviderConfig,
  ): WebhookVerdict {
    if (cfg.webhookSecret === undefined || cfg.webhookSecret.length === 0) {
      return { kind: "not-configured" };
    }
    if (signatureHeader === null || signatureHeader.trim().length === 0) {
      return { kind: "unsigned" };
    }
    const expected = createHmac("sha256", cfg.webhookSecret).update(rawBody, "utf8").digest("hex");
    if (!hexEqualsConstantTime(normalizeSignature(signatureHeader), expected)) {
      return { kind: "unsigned" };
    }

    let body: FirefliesEventBody;
    try {
      const parsed = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { kind: "ignore", reason: "body is not a JSON object" };
      }
      body = parsed as FirefliesEventBody;
    } catch {
      return { kind: "ignore", reason: "body is not valid JSON" };
    }

    const eventType = typeof body.eventType === "string" ? body.eventType.trim().toLowerCase() : "";
    if (!COMPLETE_EVENTS.has(eventType)) {
      return {
        kind: "ignore",
        reason: `event "${eventType || "(none)"}" is not transcription-complete`,
      };
    }

    const meetingId =
      (typeof body.meetingId === "string" && body.meetingId.trim()) ||
      (typeof body.transcriptId === "string" && body.transcriptId.trim()) ||
      "";
    if (meetingId.length === 0) {
      return { kind: "ignore", reason: "meetingId missing" };
    }
    return { kind: "transcription-complete", meetingId };
  },

  async fetchTranscript(
    meetingId: string,
    cfg: ProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<MeetingTranscript> {
    if (cfg.apiKey === undefined || cfg.apiKey.length === 0) {
      throw new Error("fireflies: fireflies_api_key is not configured");
    }
    const res = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ query: TRANSCRIPT_QUERY, variables: { id: meetingId } }),
    });
    if (!res.ok) {
      throw new Error(`fireflies: transcript fetch failed (HTTP ${res.status})`);
    }
    const payload = (await res.json()) as {
      data?: { transcript?: FirefliesTranscriptNode | null };
      errors?: { message?: string }[];
    };
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`fireflies: GraphQL error: ${payload.errors[0]?.message ?? "unknown"}`);
    }
    const node = payload.data?.transcript;
    if (!node || typeof node !== "object") {
      throw new Error("fireflies: transcript not found in response");
    }

    const sentences = (node.sentences ?? [])
      .filter((s): s is { speaker_name?: string | null; text?: string | null } => s != null)
      .map((s) => ({
        speaker: s.speaker_name?.trim() || null,
        text: (s.text ?? "").trim(),
      }))
      .filter((s) => s.text.length > 0);

    const summary = node.summary
      ? {
          overview: node.summary.overview?.trim() || null,
          actionItems: toStringArray(node.summary.action_items),
          keywords: toStringArray(node.summary.keywords),
        }
      : null;

    return {
      id: meetingId,
      title: node.title?.trim() || null,
      heldOnIso: deriveHeldOn(node),
      durationMinutes:
        typeof node.duration === "number" && Number.isFinite(node.duration) ? node.duration : null,
      attendees: attendeesFrom(node),
      sentences,
      summary,
    };
  },
};
