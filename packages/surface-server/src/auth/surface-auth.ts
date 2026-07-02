/**
 * createSurfaceAuth — P7, the kit's actor-resolution primitive.
 *
 * `resolveActor(req)` has exactly three branches (design "The decided
 * trust architecture"):
 *
 *   (a) **Operator** — `Authorization: Bearer <hub JWT>` validated via
 *       `@openparachute/scope-guard` against the hub's JWKS (the channel
 *       precedent, `parachute-channel/src/hub-jwt.ts`). v1 accepts
 *       `aud=vault.<name>` + scope `vault:<name>:write` for the owner
 *       branch (doc "Open questions" — a cleaner per-surface audience is
 *       an issuance evolution). No app-plane owner row, no COLLAB_TOKEN:
 *       hub identity, everywhere, HTTP and WS alike (one unified
 *       connection authorizer — pass the upgrade Request here too).
 *   (b) **Audience** — `Authorization: Capability <token>` (programmatic)
 *       or the path-scoped session cookie (browsers, set by the entry
 *       route). Backed by the AudienceStore.
 *   (c) **Anon** — neither presented.
 *
 * PRESENTED-BUT-INVALID credentials never degrade to anon: a malformed /
 * expired / revoked Bearer or Capability is a typed 401 refusal, so a
 * caller can't probe its way down the ladder.
 *
 * Capability transport (design §4): the raw token rides only the ENTRY
 * URL — the entry route verifies, creates a link-session, sets an
 * httpOnly `SameSite=Lax` cookie path-scoped to `${mount}/`, and 302s to
 * a clean URL. Browsers thereafter ride the cookie; programmatic clients
 * use `Authorization: Capability <token>`.
 *
 * ENTRY PATH NOTE: design §4 names `GET ${mount}/a/<token>`, but P4
 * containment (as built in R3a) forwards EXACTLY `${mount}/api/*` and
 * `${mount}/ws` to a backend — `${mount}/a/*` never reaches it. v1
 * therefore EMITS entry URLs at `${mount}/api/a/<token>` (works inside
 * today's containment) while ACCEPTING `${mount}/a/<token>` too, so if
 * the host later forwards the short namespace, old kit versions keep
 * working. The cookie stays path-scoped to `${mount}/` either way (a
 * scope that covers both the api namespace and the static bundle).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type HubJwtClaims,
  HubJwtError,
  type ScopeGuard,
  createScopeGuard,
} from "@openparachute/scope-guard";
import type { SurfaceHostContext } from "@openparachute/surface";
import type { Actor, AudienceActor } from "../types.ts";
import { ANON } from "../types.ts";
import { AudienceStore, type SessionRecord, type SubjectRecord } from "./audience-store.ts";
import { signToken, verifyToken } from "./capability.ts";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // personal links: 7 days to exchange

/** Cookie carrying the link-session id — path-scoped per surface. */
export const SESSION_COOKIE = "surface_session";

/**
 * Best-effort read of the hub's persisted public origin from
 * `<root>/expose-state.json` — the same self-heal vault/channel/hub do
 * (see `parachute-channel/src/hub-jwt.ts`): on an exposed box the hub
 * mints `iss: <public origin>`, so a kit booted without
 * `PARACHUTE_HUB_ORIGIN` must recover that origin or 401 every operator
 * token. Never self-heals to loopback.
 */
function readExposeStateHubOrigin(): string | undefined {
  try {
    const root = process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
    const p = resolve(root, "expose-state.json");
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      hubOrigin?: string;
      canonicalFqdn?: string;
    };
    const origin = raw.hubOrigin ?? (raw.canonicalFqdn ? `https://${raw.canonicalFqdn}` : "");
    const trimmed = origin.replace(/\/$/, "");
    if (!trimmed) return undefined;
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(trimmed)) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/** Env → expose-state self-heal → loopback (dev-only last resort). */
export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  const exposed = readExposeStateHubOrigin();
  if (exposed) return exposed;
  return DEFAULT_HUB_LOOPBACK;
}

/**
 * Parse `PARACHUTE_HUB_ORIGINS` (comma-separated) into a deduped origin list —
 * the hub's multi-origin iss-set (hub#692), same shape vault's `hub-jwt.ts`
 * ships. A hub reachable at several legitimate origins (loopback + tailnet +
 * public FQDN) mints `iss: <request origin>`; the supervisor publishes the
 * full set via this env var so a token minted under any of them validates.
 *
 * SECURITY INVARIANT: this set is ADDITIVE membership checking that runs
 * AFTER JWKS signature verification inside scope-guard — never a substitute
 * for it. It comes only from operator/supervisor env config, NEVER from a
 * request Host header.
 *
 * BACK-COMPAT INVARIANT: when `PARACHUTE_HUB_ORIGINS` is UNSET this returns
 * `[]`. scope-guard's `resolveAcceptedIssuers` sees an empty set and collapses
 * to the single canonical hub origin — byte-identical to before.
 */
export function parseHubOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const origin = part.trim().replace(/\/$/, "");
    if (origin.length > 0) seen.add(origin);
  }
  return Array.from(seen);
}

/**
 * A refusal `resolveActor` produced — convert with `.response()` or
 * branch on `.status`.
 */
export class AuthRefusal {
  readonly status: 401;
  readonly code: string;
  readonly message: string;
  constructor(code: string, message: string) {
    this.status = 401;
    this.code = code;
    this.message = message;
  }
  response(): Response {
    return Response.json({ error: this.code, message: this.message }, { status: this.status });
  }
}

export type ResolveActorResult = { ok: true; actor: Actor } | { ok: false; refusal: AuthRefusal };

export interface MintCapabilityArgs {
  /** ISO expiry for the capability record; null/omitted = no expiry. */
  expiresAt?: string | null;
}

export interface MintedCapability {
  /** The capability id — grant rows attach to subject `cap:<id>`. */
  id: string;
  /** The raw bearer (`cap_<id>.<sig>`). Hand out once; not re-derivable. */
  token: string;
  /** Entry URL path (`${mount}/a/<token>`) — origin-relative. */
  entryPath: string;
}

export interface MintPersonalLinkArgs {
  email: string;
  /** ISO expiry for the EXCHANGE window. Default: 7 days from mint. */
  expiresAt?: string | null;
}

export interface MintedPersonalLink {
  /** The link capability id — grants for the link itself attach to `cap:<id>`. */
  id: string;
  /** The bound subject — durable grants attach to `subject:<subjectId>`. */
  subjectId: string;
  /** The raw single-use token (`lnk_<id>.<sig>`). */
  token: string;
  /** Entry URL path (`${mount}/a/<token>`) — origin-relative. */
  entryPath: string;
  /**
   * True when an operator-configured email sender accepted the message.
   * False = no sender configured (or it failed): the link MUST be shown
   * inline for copy-paste — email is optional operator config per
   * module-credential-ownership, never a prerequisite.
   */
  delivered: boolean;
}

/**
 * Optional outbound-email seam. The surface owns its email credential
 * (module-credential-ownership); the kit only defines the calling shape.
 */
export type EmailSender = (args: {
  to: string;
  entryPath: string;
  token: string;
}) => Promise<void>;

export interface SurfaceAuthOptions {
  /** Override the hub origin for JWKS/issuer pinning (default: getHubOrigin()). */
  hubOrigin?: string | (() => string);
  /** Override the vault audience/scope pin (default: ctx.vault.vaultName). */
  vaultName?: string;
  /** Link-session TTL. Default 7 days. */
  sessionTtlMs?: number;
  /** Optional operator-configured outbound email for personal links. */
  sendEmail?: EmailSender;
  /** Clock seam (tests). */
  now?: () => Date;
  /**
   * Test seam: replace the scope-guard validator. Production always uses
   * the real `createScopeGuard` against the hub's JWKS.
   */
  validateHubJwt?: (token: string, expectedAudience: string) => Promise<HubJwtClaims>;
}

export interface ExchangeResult {
  response: Response;
  /** Set when a session was created (302 + cookie path). */
  session?: SessionRecord;
}

export class SurfaceAuth {
  readonly #ctx: SurfaceHostContext;
  readonly store: AudienceStore;
  readonly #vaultName: string;
  readonly #sessionTtlMs: number;
  readonly #now: () => Date;
  readonly #sendEmail: EmailSender | undefined;
  readonly #validate: (token: string, expectedAudience: string) => Promise<HubJwtClaims>;
  readonly #guard: ScopeGuard | null;

  constructor(ctx: SurfaceHostContext, opts: SurfaceAuthOptions = {}) {
    this.#ctx = ctx;
    this.store = new AudienceStore(ctx.store, opts.now !== undefined ? { now: opts.now } : {});
    this.#vaultName = opts.vaultName ?? ctx.vault.vaultName;
    this.#sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#now = opts.now ?? (() => new Date());
    this.#sendEmail = opts.sendEmail;
    if (opts.validateHubJwt) {
      this.#guard = null;
      this.#validate = opts.validateHubJwt;
    } else {
      const origin = opts.hubOrigin ?? (() => getHubOrigin());
      const guard = createScopeGuard({
        hubOrigin: origin,
        // Multi-origin iss-set (hub#692): accept the hub's full legitimate-
        // origin set (published via PARACHUTE_HUB_ORIGINS). Resolver form —
        // re-evaluated per validation call. Env unset → `[]` → scope-guard
        // collapses to the single hubOrigin (byte-identical to before).
        // Additive after signature verify; see parseHubOrigins.
        allowedIssuers: () => parseHubOrigins(process.env.PARACHUTE_HUB_ORIGINS),
      });
      this.#guard = guard;
      this.#validate = (token, expectedAudience) =>
        guard.validateHubJwt(token, { expectedAudience });
    }
  }

  /** The vault this surface pins operator tokens to (`vault.<name>`). */
  get vaultName(): string {
    return this.#vaultName;
  }

  /** Expected `aud` for the operator branch. */
  get expectedAudience(): string {
    return `vault.${this.#vaultName}`;
  }

  /** Required scope for the operator branch. */
  get requiredScope(): string {
    return `vault:${this.#vaultName}:write`;
  }

  // -------------------------------------------------------------------
  // resolveActor — the three branches
  // -------------------------------------------------------------------

  async resolveActor(req: Request): Promise<ResolveActorResult> {
    const auth = req.headers.get("authorization");

    if (auth) {
      const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
      if (bearer) return await this.#resolveOperator(bearer);
      const capability = /^Capability\s+(.+)$/i.exec(auth)?.[1]?.trim();
      if (capability) return this.#resolveCapabilityHeader(capability);
      return {
        ok: false,
        refusal: new AuthRefusal(
          "unsupported_authorization",
          "Authorization must be `Bearer <hub JWT>` or `Capability <token>`",
        ),
      };
    }

    const sessionId = this.#sessionCookie(req);
    if (sessionId) {
      const session = this.store.resolveSession(sessionId);
      // A dead cookie is NOT a refusal: cookies linger long past their
      // sessions and the bearer didn't assert anything — fall to anon so
      // public pages still render and the UI can offer re-entry.
      if (session) return { ok: true, actor: this.#audienceActor(session) };
    }

    return { ok: true, actor: ANON };
  }

  async #resolveOperator(bearer: string): Promise<ResolveActorResult> {
    let claims: HubJwtClaims;
    try {
      claims = await this.#validate(bearer, this.expectedAudience);
    } catch (err) {
      const message =
        err instanceof HubJwtError
          ? `hub JWT rejected (${err.code}): ${err.message}`
          : `hub JWT rejected: ${(err as Error).message ?? String(err)}`;
      return { ok: false, refusal: new AuthRefusal("invalid_token", message) };
    }
    if (!claims.scopes.includes(this.requiredScope)) {
      return {
        ok: false,
        refusal: new AuthRefusal(
          "insufficient_scope",
          `operator branch requires scope '${this.requiredScope}'`,
        ),
      };
    }
    return {
      ok: true,
      actor: { kind: "operator", subject: claims.sub, scopes: claims.scopes },
    };
  }

  #resolveCapabilityHeader(token: string): ResolveActorResult {
    const parsed = verifyToken(this.store.secret(), token);
    if (!parsed) {
      return { ok: false, refusal: new AuthRefusal("invalid_capability", "capability rejected") };
    }
    const record = this.store.getCapability(parsed.id);
    if (!this.store.capabilityUsable(record)) {
      return { ok: false, refusal: new AuthRefusal("invalid_capability", "capability rejected") };
    }
    if (record.kind === "lnk") {
      // Personal links are entry-URL-only: exchange them, don't ride them.
      return {
        ok: false,
        refusal: new AuthRefusal(
          "invalid_capability",
          "personal links must be exchanged via the entry URL",
        ),
      };
    }
    // Header presentation is sessionless — synthesize a per-request actor.
    return {
      ok: true,
      actor: {
        kind: "audience",
        sessionId: "",
        capabilityId: record.id,
        subjectId: record.subjectId,
      },
    };
  }

  #audienceActor(session: SessionRecord): AudienceActor {
    return {
      kind: "audience",
      sessionId: session.id,
      capabilityId: session.capabilityId,
      subjectId: session.subjectId,
    };
  }

  #sessionCookie(req: Request): string | null {
    const header = req.headers.get("cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE) {
        const v = part.slice(eq + 1).trim();
        return v.length > 0 ? v : null;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------
  // Mint / revoke
  // -------------------------------------------------------------------

  /**
   * Mint a shareable capability link. Grants for it attach to subject
   * `cap:<id>` (the caller writes those via the GrantStore — typically the
   * operator route handler does both in one motion).
   */
  mintCapability(args: MintCapabilityArgs = {}): MintedCapability {
    const record = this.store.createCapability({
      kind: "cap",
      expiresAt: args.expiresAt ?? null,
    });
    const token = signToken(this.store.secret(), "cap", record.id);
    return { id: record.id, token, entryPath: this.entryPathFor(token) };
  }

  /**
   * Mint a personal link bound to an email subject — single-use exchange
   * into a session; re-issue is the recovery flow. Email delivery is
   * OPTIONAL operator config: without a sender (or on send failure) the
   * link renders inline for copy-paste (`delivered: false`).
   */
  async mintPersonalLink(args: MintPersonalLinkArgs): Promise<MintedPersonalLink> {
    const subject: SubjectRecord =
      this.store.findSubjectByEmail(args.email) ?? this.store.createSubject(args.email);
    const expiresAt =
      args.expiresAt !== undefined
        ? args.expiresAt
        : new Date(this.#now().getTime() + DEFAULT_LINK_TTL_MS).toISOString();
    const record = this.store.createCapability({
      kind: "lnk",
      subjectId: subject.id,
      expiresAt,
    });
    const token = signToken(this.store.secret(), "lnk", record.id);
    const entryPath = this.entryPathFor(token);
    let delivered = false;
    if (this.#sendEmail) {
      try {
        await this.#sendEmail({ to: args.email, entryPath, token });
        delivered = true;
      } catch (err) {
        this.#ctx.log.warn(
          `personal-link email to ${args.email} failed — rendering inline: ${(err as Error).message}`,
        );
      }
    }
    return { id: record.id, subjectId: subject.id, token, entryPath, delivered };
  }

  /** Revoke a capability: live sessions minted from it die immediately. */
  revokeCapability(id: string): boolean {
    return this.store.revokeCapability(id);
  }

  /**
   * Origin-relative entry path for a raw token. Lives inside the api
   * namespace — see the ENTRY PATH NOTE in the module header.
   */
  entryPathFor(token: string): string {
    return `${this.#ctx.mount}/api/a/${token}`;
  }

  // -------------------------------------------------------------------
  // Entry route — verify → session → cookie → clean-URL 302 (design §4)
  // -------------------------------------------------------------------

  /** The token segment when `req` targets the entry route, else null. */
  #entryToken(req: Request): string | null {
    const path = new URL(req.url).pathname;
    for (const prefix of [`${this.#ctx.mount}/api/a/`, `${this.#ctx.mount}/a/`]) {
      if (path.startsWith(prefix)) return path.slice(prefix.length);
    }
    return null;
  }

  /** Does this request target the entry route? */
  isEntryRequest(req: Request): boolean {
    return this.#entryToken(req) !== null;
  }

  /**
   * Handle the entry route: verify the token, enforce the single-use
   * exchange for personal links, create a link-session, set the httpOnly
   * path-scoped cookie, and 302 to a clean URL (`?to=` is honored only
   * when it stays inside the surface's mount — no open redirect, and
   * never a URL that still carries a token).
   */
  handleEntry(req: Request): ExchangeResult {
    const url = new URL(req.url);
    if (req.method !== "GET") {
      return { response: Response.json({ error: "method_not_allowed" }, { status: 405 }) };
    }
    const token = this.#entryToken(req) ?? "";
    const parsed = token.length > 0 ? verifyToken(this.store.secret(), token) : null;
    if (!parsed) return { response: this.#entryRefusal() };
    const record = this.store.getCapability(parsed.id);
    if (!this.store.capabilityUsable(record)) return { response: this.#entryRefusal() };
    if (record.kind !== parsed.kind) return { response: this.#entryRefusal() };

    if (record.kind === "lnk") {
      if (record.exchangedAt !== null) {
        // Single-use: a second exchange is refused — re-issue to recover.
        return { response: this.#entryRefusal() };
      }
      this.store.markExchanged(record.id);
    }

    const session = this.store.createSession({
      capabilityId: record.id,
      subjectId: record.subjectId,
      ttlMs: this.#sessionTtlMs,
    });

    const location = this.#cleanRedirectTarget(url);
    const cookie = this.#sessionSetCookie(req, session);
    return {
      response: new Response(null, {
        status: 302,
        headers: { Location: location, "Set-Cookie": cookie },
      }),
      session,
    };
  }

  /** Uniform refusal — invalid, expired, revoked, and used all look alike. */
  #entryRefusal(): Response {
    return Response.json(
      { error: "invalid_link", message: "This link is invalid, expired, or already used." },
      { status: 401 },
    );
  }

  /**
   * Redirect target after entry: `?to=<path>` when it's a clean path
   * INSIDE the mount, else the surface root. Absolute URLs, traversal and
   * re-entry paths are all rejected.
   */
  #cleanRedirectTarget(url: URL): string {
    const mount = this.#ctx.mount;
    const to = url.searchParams.get("to") ?? "";
    if (
      to.startsWith(`${mount}/`) &&
      !to.startsWith(`${mount}/a/`) &&
      !to.startsWith(`${mount}/api/a/`) &&
      !to.startsWith("//") &&
      !to.includes("..") &&
      !to.includes("\\")
    ) {
      return to;
    }
    return `${mount}/`;
  }

  #sessionSetCookie(req: Request, session: SessionRecord): string {
    const mount = this.#ctx.mount;
    const maxAge = Math.floor(this.#sessionTtlMs / 1000);
    const attrs = [
      `${SESSION_COOKIE}=${session.id}`,
      `Path=${mount}/`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
    ];
    if (this.#isHttps(req)) attrs.push("Secure");
    return attrs.join("; ");
  }

  #isHttps(req: Request): boolean {
    const proto = req.headers.get("x-forwarded-proto");
    if (proto) return proto.split(",")[0]?.trim().toLowerCase() === "https";
    try {
      return new URL(req.url).protocol === "https:";
    } catch {
      return false;
    }
  }

  /** Test seam — drop scope-guard caches (JWKS, revocation). */
  resetGuardCaches(): void {
    this.#guard?.resetJwksCache();
    this.#guard?.resetRevocationCache();
  }
}

/** P7 factory — the shape surface authors call inside `createBackend(ctx)`. */
export function createSurfaceAuth(
  ctx: SurfaceHostContext,
  opts: SurfaceAuthOptions = {},
): SurfaceAuth {
  return new SurfaceAuth(ctx, opts);
}
