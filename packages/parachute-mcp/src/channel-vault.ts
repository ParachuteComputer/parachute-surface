/**
 * `GET /api/channel-vault` — "which vault backs this Buzz channel?"
 *
 * WHY. A channel's vault is a fact the HUB owns (the operator attaches it with
 * `parachute vault attach-channel`, design "Channel-attached vaults —
 * membership becomes access" §1), and up to now every agent on a channel had
 * to be told that fact out of band and repeat it as `--vault <name>` on every
 * invocation. One wrong name and the turn appends to the wrong vault, or to
 * none. Asking the hub removes the out-of-band step entirely: the agent knows
 * its relay and its channel id — buzz-acp puts both in its environment — and
 * the hub turns that pair into a vault name.
 *
 * The route is authenticated but NOT membership-gated (the hub cannot verify
 * channel membership: a NIP-98 request carries no proof of it), because the
 * answer is a NAME. Every read of the vault itself is separately ACL'd, so
 * learning the name buys nothing on its own.
 *
 * WIRE SHAPE, matching parachute-hub `src/api-channel-vaults.ts` exactly:
 *
 *   200 `{ vault, mode, synced_at }`   bound
 *   404 `{ error: "not_found", … }`    the route exists, the channel is unbound
 *   400 `{ error: "invalid_request" }` relay/channel missing or unusable
 *   401                                the hub rejected the signature
 *
 * The two 404s are DIFFERENT ANSWERS and this module keeps them apart: a hub
 * that predates the route falls through to its generic `not found` (a plain
 * text body), which means "ask a newer hub", not "this channel is unbound".
 * Conflating them would have `doctor` tell an operator to attach a channel on
 * a hub that has no attach command.
 *
 * NOTHING HERE THROWS. Every outcome — including a dead network — is a variant
 * of {@link ChannelVaultLookup}, because the loudest caller is `doctor`, whose
 * whole contract is that a diagnostic step never crashes the diagnosis.
 *
 * SECRET DISCIPLINE: the signing key is never seen here. The caller injects an
 * already-signing `fetch` (`makeSigningFetch`), which is the same NIP-98 path
 * every other hub call in this package takes.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { EXIT, TimeoutError, messageOf } from "./exit.js";

/** One binding, as the hub reports it. */
export interface ChannelVaultBinding {
  /** Vault INSTANCE name — the same namespace `--vault` takes. */
  vault: string;
  /** `sync` | `frozen`, per the hub. Reported, never interpreted, here. */
  mode?: string;
  /** Last successful roster sync (hub PR 5). `null`/absent = never synced. */
  syncedAt?: string;
}

/**
 * Every way the question can be answered. Deliberately four variants rather
 * than "binding or throw": `unbound` and `unsupported` both arrive as a 404
 * and mean opposite things to an operator, and `error` must stay separable
 * from both so `doctor` can report it without failing.
 */
export type ChannelVaultLookup =
  /** The channel is attached to a vault. */
  | { status: "bound"; binding: ChannelVaultBinding }
  /** The route answered, and no vault is attached to this channel. */
  | { status: "unbound" }
  /** This hub does not serve the route at all (it predates hub#947). */
  | { status: "unsupported"; reason: string }
  /** The question could not be asked or answered. Carries an exit code. */
  | { status: "error"; reason: string; exitCode: number };

/** Path segment the hub serves the read side on. */
const CHANNEL_VAULT_PATH = "/api/channel-vault";

/** Longest slice of a hub error body that may reach a message. */
const MAX_BODY_ECHO = 200;

/**
 * `https://hub.example/mcp` → `https://hub.example/api/channel-vault?…`.
 *
 * The configured hub URL names the MCP DOOR; the REST API sits beside it. The
 * `/mcp` suffix is dropped rather than the whole path replaced, so a hub
 * mounted under a prefix (`https://host/pfx/mcp`) resolves to
 * `https://host/pfx/api/channel-vault` rather than escaping to the origin.
 *
 * `relay` is passed as the caller normalized it (`relayHostOf`: scheme
 * stripped, lower-cased). The hub re-normalizes with the same rules and
 * matches case-insensitively, so the two agree by construction — but sending
 * the normalized form keeps the NIP-98 `u` tag equal to a URL the hub can also
 * derive, and keeps one channel from forking into two bindings.
 */
export function channelVaultUrl(hubUrl: string, relayHost: string, channelId: string): string {
  // `hubUrl` comes from config.ts, which has already parsed it with `new URL`
  // and stored `.href`, so this cannot throw on any value that got this far.
  // It is still never echoed on failure: the URL constructor puts the FULL raw
  // input on `error.input`.
  const url = new URL(hubUrl);
  const base = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  url.pathname = `${base}${CHANNEL_VAULT_PATH}`;
  url.search = new URLSearchParams({ relay: relayHost, channel: channelId }).toString();
  url.hash = "";
  return url.href;
}

/** The `{ vault, mode, synced_at }` body, if that is what came back. */
function parseBinding(body: string): ChannelVaultBinding | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as { vault?: unknown; mode?: unknown; synced_at?: unknown };
  if (typeof obj.vault !== "string" || obj.vault === "") return undefined;
  return {
    vault: obj.vault,
    ...(typeof obj.mode === "string" ? { mode: obj.mode } : {}),
    ...(typeof obj.synced_at === "string" ? { syncedAt: obj.synced_at } : {}),
  };
}

/**
 * Is this 404 the ROUTE saying "no such binding", or the hub saying "no such
 * route"?
 *
 * The route answers with a JSON `{ error: "not_found" }`; every generic 404 in
 * parachute-hub's dispatch is the plain text `not found`. Anything that is not
 * the route's own JSON shape is therefore read as "this hub is too old",
 * which is the fail-safe direction: telling an operator to upgrade a hub that
 * is merely unbound costs a minute, while telling them to attach a channel on
 * a hub with no attach command costs an afternoon.
 */
function isUnboundBody(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  return (parsed as { error?: unknown }).error === "not_found";
}

/** A body slice safe to put in a one-line reason. */
function echo(body: string): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat.length > MAX_BODY_ECHO ? `${flat.slice(0, MAX_BODY_ECHO)}…` : flat;
}

export interface ChannelVaultQuery {
  /** The hub's MCP door URL, as configured. */
  hubUrl: string;
  /** Relay host, already normalized by `relayHostOf`. */
  relayHost: string;
  channelId: string;
  /** A `fetch` that signs — `makeSigningFetch(key.sk)`. */
  fetch: FetchLike;
  /** Per-request budget in ms. */
  timeoutMs?: number;
}

/**
 * Ask the hub which vault backs `(relay, channel)`.
 *
 * Redirects are NOT followed, for the same reason the `http` subcommand
 * refuses them: the NIP-98 `u` tag pins the signature to one exact URL, so a
 * followed redirect would carry a signature for the wrong target and be
 * rejected — as an auth failure, three steps from the real cause.
 */
export async function lookupChannelVault(q: ChannelVaultQuery): Promise<ChannelVaultLookup> {
  let url: string;
  try {
    url = channelVaultUrl(q.hubUrl, q.relayHost, q.channelId);
  } catch {
    // Never re-thrown or echoed: `new URL`'s error carries the full raw input.
    return {
      status: "error",
      reason: "the configured hub URL is not usable as a REST base",
      exitCode: EXIT.usage,
    };
  }

  let response: Response;
  try {
    response = await q.fetch(url, {
      method: "GET",
      redirect: "manual",
      ...(q.timeoutMs !== undefined ? { signal: AbortSignal.timeout(q.timeoutMs) } : {}),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const why =
      timedOut && q.timeoutMs !== undefined
        ? new TimeoutError(q.timeoutMs).message
        : messageOf(err);
    return { status: "error", reason: `${url}: ${why}`, exitCode: EXIT.transport };
  }

  const body = await response.text().catch(() => "");

  if (response.status === 200) {
    const binding = parseBinding(body);
    if (!binding) {
      return {
        status: "error",
        reason: `${url}: 200 with a body this build does not understand (${echo(body)})`,
        exitCode: EXIT.transport,
      };
    }
    return { status: "bound", binding };
  }

  if (response.status === 404) {
    if (isUnboundBody(body)) return { status: "unbound" };
    return {
      status: "unsupported",
      reason: `${url}: 404 without the route's own not_found body (${echo(body) || "empty body"})`,
    };
  }

  // 405 is the same fact as an old-hub 404 when something else claims the
  // path: the route as this build knows it is not there.
  if (response.status === 405) {
    return { status: "unsupported", reason: `${url}: 405 — this path is not the read route here` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "error",
      reason: `${url}: ${response.status} — the hub rejected this key's signature`,
      exitCode: EXIT.auth,
    };
  }

  return {
    status: "error",
    reason: `${url}: HTTP ${response.status} ${echo(body)}`.trimEnd(),
    exitCode: EXIT.transport,
  };
}

/**
 * The one-line fix an operator needs when a channel turns out to be unbound.
 * Shared by `channel-context` (which raises it) and `doctor` (which reports
 * it), so the two never drift into two different command lines.
 *
 * The hub's CLI grammar is `attach-channel` under `parachute vault`; the
 * design calls the verb `attach-channel-vault`. This prints what the hub
 * actually accepts (parachute-hub `src/commands/vault-channels.ts`).
 */
export function attachHint(relayHost: string, channelId: string): string {
  return `attach it on the hub (\`parachute vault attach-channel --relay ${relayHost} --channel ${channelId} --vault <name>\`)`;
}

/** The one-line fix when the hub predates the route. */
export const OLD_HUB_HINT =
  "this hub does not serve /api/channel-vault yet — upgrade the hub, or pass --vault <name>";
