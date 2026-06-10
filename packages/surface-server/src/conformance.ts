/**
 * Gateway conformance suite — a PUBLIC EXPORT of the kit (design P8:
 * "the deny-by-default router with conformance tests any surface can run
 * against its own routes"). This is a product feature, not repo test
 * plumbing: a surface author imports it, points it at their composed
 * backend `fetch`, and gets the trust-architecture invariants pinned in
 * their own test suite (the generated case table is also what a
 * SECURITY.md actor table cites — design §13).
 *
 * Framework-agnostic by design: cases are `{ name, run() }` where `run`
 * throws on violation. Register them with any runner:
 *
 * ```ts
 * import { test } from "bun:test";
 * import { gatewayConformanceCases } from "@openparachute/surface-server/conformance";
 *
 * for (const c of gatewayConformanceCases(opts)) test(c.name, () => c.run());
 * ```
 *
 * What the suite pins:
 *
 *   - **anon-sees-nothing** — every declared protected probe refuses an
 *     unauthenticated request (401/403/404) AND leaks no content marker.
 *   - **deny-by-default** — an undeclared route under the api namespace
 *     is a 404, anonymous or not.
 *   - **leak conditions / path+tag locks** — a scoped actor's `allowed`
 *     probes succeed while its `denied` probes (out-of-scope notes,
 *     notes outside a path lock, notes missing a tag lock, mutations
 *     above its level) refuse without leaking markers — and a denied
 *     note-read is indistinguishable from a missing note (no existence
 *     oracle).
 *   - **entry hygiene** — the capability entry 302s to a clean URL (no
 *     token in `Location`), sets an httpOnly cookie path-scoped to the
 *     surface's mount, and never reflects the token in the body.
 *   - **cookie-mutation origin check** — a cookie-authenticated mutation
 *     without a same-origin `Origin` header is refused.
 */

export interface ConformanceProbe {
  /** Default `GET`. */
  method?: string;
  /** Mount-relative path (`/api/...`) or absolute (`/surface/x/api/...`). */
  path: string;
  /** Optional JSON body for mutation probes. */
  body?: unknown;
  /** Extra headers (e.g. a content-type override). */
  headers?: Record<string, string>;
  /**
   * Strings that must NEVER appear in a refused response's body — e.g. a
   * distinctive phrase from the protected note's content.
   */
  mustNotContain?: string[];
}

export interface ScopedActorSpec {
  /** How the actor authenticates, e.g. `Capability cap_<id>.<sig>`. */
  authorization: string;
  /** Probes that MUST succeed (2xx) for this actor. */
  allowed?: ConformanceProbe[];
  /**
   * Probes that MUST refuse (401/403/404) for this actor without leaking
   * `mustNotContain` markers — the leak-condition and path/tag-lock pins.
   */
  denied?: ConformanceProbe[];
}

export interface GatewayConformanceOptions {
  /** The surface's composed request handler (usually `backend.fetch`). */
  fetch: (req: Request) => Response | Promise<Response>;
  /** The surface's mount path, e.g. `/surface/my-surface`. */
  mount: string;
  /** Origin used to synthesize request URLs. Default `https://surface.test`. */
  origin?: string;
  /** Protected routes that must refuse anon (the anon-sees-nothing pin). */
  protectedProbes?: ConformanceProbe[];
  /** Scoped actors with allowed/denied probe pairs (locks + leaks). */
  actors?: ScopedActorSpec[];
  /**
   * A VALID raw capability token — enables the entry-hygiene case
   * (redirect strips token, cookie is httpOnly + path-scoped).
   *
   * FRESHNESS + ORDERING: the entry-hygiene case AND the cookie-mutation
   * case EACH exchange this token. A multi-use capability (`cap_…`)
   * supports both in any order; a SINGLE-USE personal link (`lnk_…`) is
   * consumed by whichever case runs first, and the other then FAILS
   * LOUDLY (it never passes vacuously). Supply a `cap` token, or mint a
   * fresh token per run.
   */
  entryToken?: string;
  /**
   * A mutation route reachable with a session cookie — enables the
   * cookie-mutation origin-check case. The suite first exchanges
   * `entryToken` for a cookie (requires `entryToken`); if that exchange
   * is refused (e.g. the token was already consumed), the case fails
   * loudly rather than passing without probing the mutation — see the
   * `entryToken` freshness note.
   */
  cookieMutationProbe?: ConformanceProbe;
}

export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

class ConformanceViolation extends Error {}

function fail(message: string): never {
  throw new ConformanceViolation(message);
}

const REFUSAL_STATUSES = new Set([401, 403, 404]);

export function gatewayConformanceCases(opts: GatewayConformanceOptions): ConformanceCase[] {
  const origin = opts.origin ?? "https://surface.test";
  const mount = opts.mount;

  const resolvePath = (path: string): string => (path.startsWith(mount) ? path : `${mount}${path}`);

  const buildRequest = (probe: ConformanceProbe, headers: Record<string, string> = {}): Request => {
    const method = (probe.method ?? "GET").toUpperCase();
    const init: RequestInit = {
      method,
      headers: {
        ...(probe.body !== undefined ? { "content-type": "application/json" } : {}),
        ...probe.headers,
        ...headers,
      },
      ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
    };
    return new Request(`${origin}${resolvePath(probe.path)}`, init);
  };

  const probeLabel = (probe: ConformanceProbe): string =>
    `${(probe.method ?? "GET").toUpperCase()} ${resolvePath(probe.path)}`;

  const assertRefused = async (res: Response, probe: ConformanceProbe, who: string) => {
    if (!REFUSAL_STATUSES.has(res.status)) {
      fail(`${who} ${probeLabel(probe)} expected refusal (401/403/404), got ${res.status}`);
    }
    if (probe.mustNotContain && probe.mustNotContain.length > 0) {
      const body = await res.text();
      for (const marker of probe.mustNotContain) {
        if (body.includes(marker)) {
          fail(`${who} ${probeLabel(probe)} refusal body leaks marker ${JSON.stringify(marker)}`);
        }
      }
    }
  };

  const cases: ConformanceCase[] = [];

  // ---- anon-sees-nothing -------------------------------------------------
  for (const probe of opts.protectedProbes ?? []) {
    cases.push({
      name: `conformance: anon-sees-nothing — ${probeLabel(probe)}`,
      run: async () => {
        const res = await opts.fetch(buildRequest(probe));
        await assertRefused(res, probe, "anon");
      },
    });
  }

  // ---- deny-by-default ----------------------------------------------------
  cases.push({
    name: "conformance: deny-by-default — undeclared route is 404",
    run: async () => {
      const res = await opts.fetch(new Request(`${origin}${mount}/api/__conformance_undeclared__`));
      if (res.status !== 404) {
        fail(`undeclared route expected 404, got ${res.status}`);
      }
    },
  });

  // ---- scoped actors: locks + leak conditions ------------------------------
  (opts.actors ?? []).forEach((actor, i) => {
    const who = `actor[${i}]`;
    for (const probe of actor.allowed ?? []) {
      cases.push({
        name: `conformance: ${who} allowed — ${probeLabel(probe)}`,
        run: async () => {
          const res = await opts.fetch(buildRequest(probe, { authorization: actor.authorization }));
          if (res.status < 200 || res.status >= 300) {
            fail(`${who} ${probeLabel(probe)} expected 2xx, got ${res.status}`);
          }
        },
      });
    }
    for (const probe of actor.denied ?? []) {
      cases.push({
        name: `conformance: ${who} denied (no leak) — ${probeLabel(probe)}`,
        run: async () => {
          const res = await opts.fetch(buildRequest(probe, { authorization: actor.authorization }));
          await assertRefused(res, probe, who);
        },
      });
    }
  });

  // ---- entry hygiene --------------------------------------------------------
  if (opts.entryToken !== undefined) {
    const token = opts.entryToken;
    cases.push({
      name: "conformance: entry redirect strips the token + path-scopes the cookie",
      run: async () => {
        const res = await opts.fetch(new Request(`${origin}${mount}/api/a/${token}`));
        if (res.status !== 302) fail(`entry expected 302, got ${res.status}`);
        const location = res.headers.get("location") ?? "";
        if (location.includes(token)) fail("entry Location still carries the raw token");
        const cookie = res.headers.get("set-cookie") ?? "";
        if (!cookie) fail("entry set no session cookie");
        if (!/httponly/i.test(cookie)) fail("entry session cookie is not HttpOnly");
        if (!/samesite=lax/i.test(cookie)) fail("entry session cookie is not SameSite=Lax");
        if (!cookie.toLowerCase().includes(`path=${mount.toLowerCase()}/`)) {
          fail(`entry session cookie is not path-scoped to ${mount}/`);
        }
        const body = await res.text();
        if (body.includes(token)) fail("entry response body reflects the raw token");
      },
    });
  }

  // ---- cookie-mutation origin check ---------------------------------------
  if (opts.cookieMutationProbe && opts.entryToken !== undefined) {
    const token = opts.entryToken;
    const probe = opts.cookieMutationProbe;
    cases.push({
      name: `conformance: cookie mutation without same-origin Origin is refused — ${probeLabel(probe)}`,
      run: async () => {
        const entry = await opts.fetch(new Request(`${origin}${mount}/api/a/${token}`));
        const setCookie = entry.headers.get("set-cookie") ?? "";
        const pair = setCookie.split(";")[0];
        // VACUOUS-PASS GUARD: this case can only probe the mutation with a
        // real session cookie. A refused exchange (single-use token already
        // consumed — e.g. by the entry-hygiene case) must FAIL the case
        // loudly, never let it pass without probing anything.
        if (entry.status !== 302 || !pair) {
          fail(
            `could not obtain session cookie (entry exchange returned ${entry.status}) — entry token already consumed; supply a fresh entryToken or run this case first`,
          );
        }
        // No Origin header at all — must refuse.
        const noOrigin = await opts.fetch(buildRequest(probe, { cookie: pair }));
        if (noOrigin.status !== 403) {
          fail(`cookie mutation without Origin expected 403, got ${noOrigin.status}`);
        }
        // Cross-site Origin — must refuse.
        const crossOrigin = await opts.fetch(
          buildRequest(probe, { cookie: pair, origin: "https://evil.example" }),
        );
        if (crossOrigin.status !== 403) {
          fail(`cookie mutation with cross-site Origin expected 403, got ${crossOrigin.status}`);
        }
      },
    });
  }

  return cases;
}
