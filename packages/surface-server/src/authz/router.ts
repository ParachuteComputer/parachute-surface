/**
 * createSurfaceRouter — the deny-by-default gateway composing P7 + P8.
 *
 * Every route DECLARES its access requirement; there is no implicit
 * "authenticated by default" or "open by default" — an undeclared path is
 * a 404 and an undeclared access shape doesn't compile. The composed
 * `fetch` is what a surface returns from `createBackend(ctx)` (or
 * delegates to for its `${mount}/api/*` namespace).
 *
 * Built-in, default-on (each per-route opt-outable where sane):
 *
 *   - **rate limit** — fail-closed, keyed off the hub-stamped client IP
 *     (P7; null IP shares a collective per-layer bucket, limited never
 *     unlimited). Applied before any auth work so token brute-force and
 *     credential-stuffing pay the limiter first.
 *   - **entry route** — `GET ${mount}/api/a/<token>` (capability/link
 *     exchange, design §4) handled before route matching.
 *   - **actor resolution** — presented-but-invalid credentials are a 401
 *     refusal, never a downgrade to anon.
 *   - **origin check** — cookie-authenticated mutations require a
 *     same-origin `Origin` header (CSRF; default-on per design P7).
 *   - **note access** — `note`-kind routes resolve the target note and
 *     ask `can()`. Denials and missing notes are the SAME 404 (no
 *     existence oracle; the conformance suite pins this).
 *   - **error boundary** — a throwing handler is a generic 500 (the host
 *     has its own containment; this keeps surface logs attributed).
 */

import type { SurfaceHostContext } from "@openparachute/surface";
import { isMutation, originAllowed } from "../auth/origin-check.ts";
import { type RateLimitOptions, RateLimiter, rateLimitedResponse } from "../auth/rate-limit.ts";
import type { SurfaceAuth } from "../auth/surface-auth.ts";
import type { Action, Actor, Note } from "../types.ts";
import type { SurfaceAuthz } from "./surface-authz.ts";

/** What a matched route's handler receives. */
export interface RouteContext {
  actor: Actor;
  /** Decoded `:param` segments. */
  params: Record<string, string>;
  /** The resolved note — present iff the route's access kind is `note`. */
  note?: Note;
  ctx: SurfaceHostContext;
}

export type RouteHandler = (req: Request, route: RouteContext) => Response | Promise<Response>;

/**
 * The access declaration — REQUIRED on every route.
 *
 *   - `public`    — anyone, including anon. For truly open endpoints
 *                   (health, public projections). Still rate-limited.
 *   - `audience`  — any authenticated actor (operator or audience).
 *   - `operator`  — hub-validated operator only.
 *   - `note`      — resolve a note and require `can(actor, note, action)`.
 *                   The note id comes from the `:param` named by
 *                   `noteParam` (default `"id"`), or a custom `resolve`.
 */
export type RouteAccess =
  | { kind: "public" }
  | { kind: "audience" }
  | { kind: "operator" }
  | {
      kind: "note";
      action: Action;
      /** Which `:param` carries the note id/path. Default `"id"`. */
      noteParam?: string;
      /** Custom resolution (overrides `noteParam`). Null → 404. */
      resolve?: (params: Record<string, string>, req: Request) => Promise<Note | null>;
    };

export interface SurfaceRoute {
  /** Uppercase HTTP method (`GET`, `POST`, …). */
  method: string;
  /**
   * Mount-relative pattern, e.g. `/api/doc/:id`. Segments starting with
   * `:` capture (decoded) into `params`.
   */
  path: string;
  access: RouteAccess;
  handler: RouteHandler;
  /**
   * Opt out of the cookie-mutation origin check for THIS route (e.g. an
   * intentionally cross-origin webhook that carries its own token).
   * Default ON.
   */
  originCheck?: boolean;
}

export interface SurfaceRouterOptions {
  routes: SurfaceRoute[];
  /** Rate-limiter tuning, or `false` to disable router-wide (not advised). */
  rateLimit?: RateLimitOptions | false;
}

export interface SurfaceRouter {
  /** Plug into `SurfaceBackend.fetch` (or delegate from it). */
  fetch(req: Request): Promise<Response>;
}

interface CompiledRoute extends SurfaceRoute {
  segments: string[];
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** Match a compiled pattern against path segments; null = no match. */
function matchRoute(route: CompiledRoute, segments: string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const pattern = route.segments[i] as string;
    const actual = segments[i] as string;
    if (pattern.startsWith(":")) {
      try {
        params[pattern.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null; // malformed escape — no match (deny-by-default 404)
      }
    } else if (pattern !== actual) {
      return null;
    }
  }
  return params;
}

export function createSurfaceRouter(
  ctx: SurfaceHostContext,
  auth: SurfaceAuth,
  authz: SurfaceAuthz,
  opts: SurfaceRouterOptions,
): SurfaceRouter {
  const limiter = opts.rateLimit === false ? null : new RateLimiter(opts.rateLimit);
  const compiled: CompiledRoute[] = opts.routes.map((r) => ({
    ...r,
    method: r.method.toUpperCase(),
    segments: r.path.split("/").filter((s) => s.length > 0),
  }));

  return {
    async fetch(req: Request): Promise<Response> {
      // 1. Rate limit — before ANY auth or routing work (fail-closed).
      if (limiter) {
        const verdict = limiter.check(RateLimiter.keyFor(ctx.clientIp(req), ctx.layer(req)));
        if (!verdict.allowed) return rateLimitedResponse(verdict);
      }

      // 2. The capability entry route (design §4).
      if (auth.isEntryRequest(req)) {
        return auth.handleEntry(req).response;
      }

      // 3. Resolve the actor. Presented-but-invalid → 401, never anon.
      const resolved = await auth.resolveActor(req);
      if (!resolved.ok) return resolved.refusal.response();
      const actor = resolved.actor;

      // 4. Match a declared route; everything else is a 404.
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname === ctx.mount || pathname.startsWith(`${ctx.mount}/`)) {
        pathname = pathname.slice(ctx.mount.length) || "/";
      }
      const segments = pathname.split("/").filter((s) => s.length > 0);
      let matched: { route: CompiledRoute; params: Record<string, string> } | null = null;
      let sawPathMatch = false;
      for (const route of compiled) {
        const params = matchRoute(route, segments);
        if (params === null) continue;
        sawPathMatch = true;
        if (route.method === req.method.toUpperCase()) {
          matched = { route, params };
          break;
        }
      }
      if (!matched) {
        return sawPathMatch
          ? Response.json({ error: "method_not_allowed" }, { status: 405 })
          : notFound();
      }
      const { route, params } = matched;

      // 5. Origin check — cookie-authenticated mutations only (default ON).
      const cookieAuthed = actor.kind === "audience" && actor.sessionId !== "";
      if (
        route.originCheck !== false &&
        cookieAuthed &&
        isMutation(req.method) &&
        !originAllowed(req)
      ) {
        return Response.json(
          {
            error: "origin_mismatch",
            message:
              "cookie-authenticated mutations require a same-origin Origin header — programmatic clients should present `Authorization: Capability <token>` instead",
          },
          { status: 403 },
        );
      }

      // 6. Access enforcement.
      try {
        const access = route.access;
        if (access.kind === "operator") {
          if (actor.kind !== "operator") {
            return actor.kind === "anon"
              ? Response.json({ error: "unauthorized" }, { status: 401 })
              : Response.json({ error: "forbidden" }, { status: 403 });
          }
        } else if (access.kind === "audience") {
          if (actor.kind === "anon") {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
        } else if (access.kind === "note") {
          const note = access.resolve
            ? await access.resolve(params, req)
            : await resolveNoteByParam(ctx, params, access.noteParam ?? "id");
          // Missing and denied are the SAME response — no existence oracle.
          if (note === null) return notFound();
          if (!(await authz.can(actor, note, access.action))) return notFound();
          return await route.handler(req, { actor, params, note, ctx });
        }
        // public falls through with no check (rate limit already paid).
        return await route.handler(req, { actor, params, ctx });
      } catch (err) {
        ctx.log.error(`route ${route.method} ${route.path} failed: ${(err as Error).message}`);
        return Response.json({ error: "internal" }, { status: 500 });
      }
    },
  };
}

async function resolveNoteByParam(
  ctx: SurfaceHostContext,
  params: Record<string, string>,
  param: string,
): Promise<Note | null> {
  const id = params[param];
  if (!id) return null;
  return await ctx.vault.getNote(id);
}
