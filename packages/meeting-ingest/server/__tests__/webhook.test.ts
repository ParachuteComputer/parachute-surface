/**
 * Webhook end-to-end tests over the composed backend: HMAC verify, payload
 * classification, dedup, fetch-failure mapping, and the full transcript →
 * note write. `fetch` (the GraphQL call) and `ctx.vault` are mocked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { FakeVault, type MadeBackend, makeBackend, postWebhook, sign } from "./helpers.ts";

const SECRET = "shared-webhook-secret-xyz";
const API_KEY = "ff-api-key-secret";
const MEETING_ID = "FF-meeting-1";

function completeBody(meetingId = MEETING_ID): string {
  return JSON.stringify({
    meetingId,
    eventType: "Transcription completed",
    clientReferenceId: "ref-1",
  });
}

/** A GraphQL-success transcript response shaped like Fireflies'. */
function transcriptResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        transcript: {
          title: "Sprint Planning",
          dateString: "2026-06-12T09:00:00.000Z",
          date: 1_749_718_800_000,
          duration: 30,
          participants: ["alice@x.io", "bob@x.io"],
          meeting_attendees: [
            { displayName: "Alice", email: "alice@x.io" },
            { displayName: "Bob", email: "bob@x.io" },
          ],
          sentences: [
            { speaker_name: "Alice", text: "Kicking off planning." },
            { speaker_name: "Bob", text: "I'll groom the backlog." },
          ],
          summary: {
            overview: "Planned the sprint.",
            action_items: ["Bob: groom backlog"],
            keywords: ["sprint"],
          },
          ...overrides,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A fetch mock recording calls, returning a canned response (or throwing). */
function mockFetch(impl: () => Promise<Response>): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return impl();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

let made: MadeBackend | null = null;
afterEach(async () => {
  await made?.backend.shutdown?.();
  made?.controller.abort();
  made = null;
});

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

describe("HMAC verification", () => {
  test("valid signature ingests → 201 with note_id", async () => {
    const { fetch, calls } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; note_id: string };
    expect(json.ok).toBe(true);
    expect(json.note_id).toBe("note-1");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://api.fireflies.ai/graphql");
    expect(made.vault.createCalls.length).toBe(1);
  });

  test("invalid signature → 401, no fetch, no note", async () => {
    const { fetch, calls } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": "deadbeef",
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
    expect(made.vault.createCalls.length).toBe(0);
  });

  test("missing signature → 401", async () => {
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
    });
    const res = await postWebhook(made.backend, "fireflies", completeBody());
    expect(res.status).toBe(401);
  });

  test("no secret configured → 503 (never accept unsigned)", async () => {
    made = await makeBackend({ config: { fireflies_api_key: API_KEY } });
    const body = completeBody();
    // Even a (would-be) valid signature can't pass without a configured secret.
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign("whatever", body),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_configured");
  });

  test("signature with sha256= prefix is accepted", async () => {
    const { fetch } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": `sha256=${sign(SECRET, body)}`,
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Payload classification
// ---------------------------------------------------------------------------

describe("payload classification", () => {
  test("non-transcription event → 200 ignore (no fetch, no note)", async () => {
    const { fetch, calls } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = JSON.stringify({ meetingId: MEETING_ID, eventType: "Meeting started" });
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored?: boolean }).ignored).toBe(true);
    expect(calls.length).toBe(0);
    expect(made.vault.createCalls.length).toBe(0);
  });

  test("missing meetingId → 200 ignore", async () => {
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
    });
    const body = JSON.stringify({ eventType: "Transcription completed" });
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored?: boolean }).ignored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dedup (idempotency)
// ---------------------------------------------------------------------------

describe("dedup", () => {
  test("existing external_id → 200 deduped, no second note", async () => {
    const vault = new FakeVault();
    // Seed an already-ingested meeting note.
    vault.noteFixture("existing", "# Old", {
      tags: ["meeting"],
      metadata: { source: "fireflies", external_id: `fireflies:${MEETING_ID}` },
    });
    const { fetch, calls } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      vault,
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deduped?: boolean }).deduped).toBe(true);
    // No transcript fetch, no new note.
    expect(calls.length).toBe(0);
    expect(made.vault.createCalls.length).toBe(0);
  });

  test("a different meeting is not deduped against an existing one", async () => {
    const vault = new FakeVault();
    vault.noteFixture("existing", "# Old", {
      tags: ["meeting"],
      metadata: { source: "fireflies", external_id: "fireflies:OTHER" },
    });
    const { fetch } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      vault,
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(201);
    expect(made.vault.createCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Transcript fetch failures
// ---------------------------------------------------------------------------

describe("transcript fetch failures", () => {
  test("non-OK GraphQL HTTP → 502, no note", async () => {
    const { fetch } = mockFetch(async () => new Response("nope", { status: 500 }));
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(502);
    expect(made.vault.createCalls.length).toBe(0);
  });

  test("network throw → 502", async () => {
    const { fetch } = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(502);
  });

  test("GraphQL errors array → 502", async () => {
    const { fetch } = mockFetch(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "bad id" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// End-to-end transform → note
// ---------------------------------------------------------------------------

describe("end-to-end ingest", () => {
  test("writes a #meeting note with the expected body + metadata", async () => {
    const { fetch } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET, tag: "meeting" },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    expect(res.status).toBe(201);
    const created = made.vault.createCalls[0];
    expect(created?.tags).toEqual(["meeting"]);
    expect(created?.metadata).toMatchObject({
      source: "fireflies",
      external_id: `fireflies:${MEETING_ID}`,
      title: "Sprint Planning",
    });
    expect(created?.content).toContain("# Sprint Planning");
    expect(created?.content).toContain("**Alice:** Kicking off planning.");
    expect(created?.content).toContain("## Summary");
    expect(created?.content).toContain("Planned the sprint.");
  });

  test("honors a custom tag from config", async () => {
    const { fetch } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: {
        fireflies_api_key: API_KEY,
        fireflies_webhook_secret: SECRET,
        tag: "meeting/fireflies",
      },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    await postWebhook(made.backend, "fireflies", body, { "x-hub-signature": sign(SECRET, body) });
    expect(made.vault.createCalls[0]?.tags).toEqual(["meeting/fireflies"]);
  });

  test("the api key + secret never appear in the response body", async () => {
    const { fetch } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    const res = await postWebhook(made.backend, "fireflies", body, {
      "x-hub-signature": sign(SECRET, body),
    });
    const text = await res.text();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene: nothing logged carries the secret/key
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
  test("secrets never appear in any log line", async () => {
    const { fetch } = mockFetch(async () => transcriptResponse());
    made = await makeBackend({
      config: { fireflies_api_key: API_KEY, fireflies_webhook_secret: SECRET },
      build: { fetchImpl: fetch },
    });
    const body = completeBody();
    await postWebhook(made.backend, "fireflies", body, { "x-hub-signature": sign(SECRET, body) });
    const allLogs = [...made.logs.logs, ...made.logs.warns, ...made.logs.errors].join("\n");
    expect(allLogs).not.toContain(API_KEY);
    expect(allLogs).not.toContain(SECRET);
  });
});
