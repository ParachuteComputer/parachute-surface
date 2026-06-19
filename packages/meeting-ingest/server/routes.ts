/**
 * The meeting-ingest surface's routes, riding the kit's deny-by-default
 * gateway (`createSurfaceRouter`).
 *
 * Trust shape:
 *
 *   - **`POST /api/webhook/<provider>`** is PUBLIC (`access: { kind:
 *     "public" }`) and OPTS OUT of the cookie-origin check (`originCheck:
 *     false`) — it's an external webhook that carries its own HMAC auth, not
 *     a cookie. Auth is the provider's signature over the RAW body, verified
 *     against the operator-set shared secret. No hub identity is involved.
 *   - **`GET /api/me`** is public (a session probe for the config page).
 *   - **`GET /api/config-status`** is operator-only — reports WHICH config
 *     keys are set (booleans only), never the secret values, so the operator
 *     can confirm setup from the surface page.
 *
 * SECURITY INVARIANTS (hard):
 *   - secrets are read ONLY from `ctx.config`; never logged, never returned.
 *   - the webhook never echoes the request body on a refusal.
 *   - the transcript is never logged at info level.
 *   - the ONLY vault effect is the single `createNote` on a fresh meeting.
 */

import type { SurfaceHostContext } from "@openparachute/surface";
import type { SurfaceRoute } from "@openparachute/surface-server";
import type { MeetingProvider, ProviderConfig } from "./providers/types.ts";
import { externalIdFor } from "./providers/types.ts";
import { buildMeetingNote } from "./transform.ts";

/** Default tag for ingested meeting notes. */
export const DEFAULT_TAG = "meeting";

/** Header Fireflies signs its webhook deliveries with. */
const SIGNATURE_HEADER = "x-hub-signature";

export interface RoutesDeps {
  ctx: SurfaceHostContext;
  /** Providers keyed by their `name` (route slug). */
  providers: Record<string, MeetingProvider>;
  /** Resolved working tag (config `tag` or {@link DEFAULT_TAG}). */
  tag: string;
  /** Test seam for the transcript fetch. */
  fetchImpl?: typeof fetch;
}

/** Read the provider's config (api key + webhook secret) from `ctx.config`. */
function providerConfig(ctx: SurfaceHostContext, provider: MeetingProvider): ProviderConfig {
  const apiKey = ctx.config.get(`${provider.name}_api_key`);
  const webhookSecret = ctx.config.get(`${provider.name}_webhook_secret`);
  return {
    apiKey: typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined,
    webhookSecret:
      typeof webhookSecret === "string" && webhookSecret.length > 0 ? webhookSecret : undefined,
  };
}

/**
 * Has a meeting with this external id already been ingested? Dedup by the
 * `external_id` metadata shorthand-equality scan (JSON-scan equality — no
 * indexed-field declaration required vault-side).
 */
async function alreadyIngested(
  ctx: SurfaceHostContext,
  tag: string,
  externalId: string,
): Promise<boolean> {
  const matches = await ctx.vault.queryNotes({
    tag,
    expand: "exact",
    metadata: { external_id: externalId },
    limit: 1,
  });
  return matches.length > 0;
}

/** Build the webhook handler for one provider. */
function webhookHandler(deps: RoutesDeps, provider: MeetingProvider) {
  const { ctx, tag, fetchImpl } = deps;
  return async (req: Request): Promise<Response> => {
    // Read the RAW body ONCE — reused for HMAC verification and JSON parse.
    const rawBody = await req.text();
    const cfg = providerConfig(ctx, provider);
    const verdict = provider.verifyAndParse(rawBody, req.headers.get(SIGNATURE_HEADER), cfg);

    switch (verdict.kind) {
      case "not-configured":
        ctx.log.warn(`${provider.name} webhook rejected: no webhook secret configured`);
        return Response.json(
          { error: "not_configured", message: `${provider.name} webhook secret is not configured` },
          { status: 503 },
        );
      case "unsigned":
        ctx.log.warn(`${provider.name} webhook rejected: missing/invalid signature`);
        return Response.json({ error: "unauthorized" }, { status: 401 });
      case "ignore":
        // Benign delivery (non-completion event, no meetingId) — ack so the
        // provider doesn't retry. The reason is operational, not the body.
        ctx.log.log(`${provider.name} webhook ignored: ${verdict.reason}`);
        return Response.json({ ok: true, ignored: true });
      case "transcription-complete":
        break;
    }

    const { meetingId } = verdict;
    const externalId = externalIdFor(provider, meetingId);

    // Idempotency: webhooks retry. A meeting we already ingested is a 200
    // no-op — no second note, no second fetch.
    if (await alreadyIngested(ctx, tag, externalId)) {
      ctx.log.log(`${provider.name} webhook: ${externalId} already ingested — skipping`);
      return Response.json({ ok: true, deduped: true });
    }

    let transcript: Awaited<ReturnType<MeetingProvider["fetchTranscript"]>>;
    try {
      transcript = await provider.fetchTranscript(meetingId, cfg, fetchImpl);
    } catch (err) {
      // Fetch failures are 502 so the provider retries (transient API/auth).
      // Log the message (never the transcript body).
      ctx.log.error(`${provider.name} transcript fetch failed: ${(err as Error).message}`);
      return Response.json({ error: "fetch_failed" }, { status: 502 });
    }

    const payload = buildMeetingNote(provider, transcript, { tag });
    const note = await ctx.vault.createNote(payload);
    ctx.log.log(`${provider.name} ingested ${externalId} → note ${note.id}`);
    return Response.json({ ok: true, note_id: note.id }, { status: 201 });
  };
}

export function buildRoutes(deps: RoutesDeps): SurfaceRoute[] {
  const { ctx, providers } = deps;
  const routes: SurfaceRoute[] = [
    // -- session probe (config page) --------------------------------------
    {
      method: "GET",
      path: "/api/me",
      access: { kind: "public" },
      handler: async (_req, { actor }) => Response.json({ kind: actor.kind }),
    },
    // -- operator config status (booleans only, NEVER secret values) ------
    {
      method: "GET",
      path: "/api/config-status",
      access: { kind: "operator" },
      handler: async () => {
        const status = Object.values(providers).map((p) => {
          const cfg = providerConfig(ctx, p);
          return {
            provider: p.name,
            apiKeySet: cfg.apiKey !== undefined,
            webhookSecretSet: cfg.webhookSecret !== undefined,
          };
        });
        const tagValue = ctx.config.get("tag");
        return Response.json({
          tag:
            typeof tagValue === "string" && tagValue.trim().length > 0
              ? tagValue.trim()
              : DEFAULT_TAG,
          providers: status,
        });
      },
    },
  ];

  // One public webhook route per provider.
  for (const provider of Object.values(providers)) {
    routes.push({
      method: "POST",
      path: `/api/webhook/${provider.name}`,
      access: { kind: "public" },
      // External webhook with its own HMAC auth — not a cookie session, so
      // the cookie-origin CSRF check must NOT apply.
      originCheck: false,
      handler: webhookHandler(deps, provider),
    });
  }

  return routes;
}
