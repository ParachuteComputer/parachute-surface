/**
 * Provider-agnostic shapes for the meeting-ingest surface.
 *
 * The surface receives a transcription-complete webhook from a meeting
 * provider (Fireflies.ai today; Read.ai could be a second provider later)
 * and writes the transcript into the vault as a `#meeting` note. Each
 * provider implements {@link MeetingProvider}:
 *
 *   - **verify** the inbound webhook signature against an operator secret,
 *   - **parse** the (minimal) webhook body into a normalized event,
 *   - **fetch** the full transcript by id from the provider's API,
 *
 * The surface then maps the {@link MeetingTranscript} onto a note via the
 * shared transform (see `../transform.ts`). One provider per webhook route
 * (`/api/webhook/<provider>`); the transform + note write are shared.
 */

/** What a provider needs from the surface config to operate. */
export interface ProviderConfig {
  /** The provider's API key (Bearer for the transcript fetch). */
  apiKey: string | undefined;
  /** The shared secret the provider signs its webhooks with. */
  webhookSecret: string | undefined;
}

/** The verdict of verifying + parsing an inbound webhook. */
export type WebhookVerdict =
  /** Signature missing/invalid — refuse (401). No body echo. */
  | { kind: "unsigned" }
  /** No secret configured — the surface must not accept unsigned (503). */
  | { kind: "not-configured" }
  /** Verified, but not a transcription-complete event — benign ack (200). */
  | { kind: "ignore"; reason: string }
  /** Verified transcription-complete event for `meetingId`. */
  | { kind: "transcription-complete"; meetingId: string };

/** The normalized transcript shape the note transform consumes. */
export interface MeetingTranscript {
  /** Provider-native meeting/transcript id (interchangeable for Fireflies). */
  id: string;
  /** Meeting title, if the provider supplied one. */
  title: string | null;
  /** ISO-8601 instant the meeting was held, if derivable. */
  heldOnIso: string | null;
  /** Duration in minutes, if supplied. */
  durationMinutes: number | null;
  /** Attendee display names (deduped, in provider order). */
  attendees: string[];
  /** One entry per spoken segment, in order. */
  sentences: { speaker: string | null; text: string }[];
  /** Provider-supplied summary, if present. */
  summary: {
    overview: string | null;
    actionItems: string[];
    keywords: string[];
  } | null;
}

/**
 * A meeting-transcript provider. `verifyAndParse` is sync (HMAC + JSON over
 * the raw body, no I/O); `fetchTranscript` does the network call.
 */
export interface MeetingProvider {
  /** Stable slug — the webhook route is `/api/webhook/<name>`. */
  readonly name: string;
  /** External-id namespace stamped on the note (`<name>:<meetingId>`). */
  readonly idPrefix: string;

  /**
   * Verify the webhook signature against `cfg.webhookSecret` (constant-time)
   * and classify the body. MUST hash the RAW body bytes — `rawBody` is the
   * exact text read off the request, reused for both HMAC and JSON parse.
   */
  verifyAndParse(
    rawBody: string,
    signatureHeader: string | null,
    cfg: ProviderConfig,
  ): WebhookVerdict;

  /**
   * Fetch the full transcript for `meetingId`. Throws on transport/API
   * failure (the caller maps that to 502 so the provider retries). `fetchImpl`
   * is a test seam — defaults to the global `fetch`.
   */
  fetchTranscript(
    meetingId: string,
    cfg: ProviderConfig,
    fetchImpl?: typeof fetch,
  ): Promise<MeetingTranscript>;
}

/** The provider's `external_id` value for a meeting (`<prefix>:<id>`). */
export function externalIdFor(provider: MeetingProvider, meetingId: string): string {
  return `${provider.idPrefix}:${meetingId}`;
}
