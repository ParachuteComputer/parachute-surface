/**
 * Shared vocabulary for the surface-server kit (surface-runtime design
 * P7/P8).
 *
 * Two distinct vocabularies, deliberately (design §6):
 *
 *   - **Levels are GRANT vocabulary** — the wire format an operator grants
 *     at: `view < comment < suggest < edit`. `own` is never grantable;
 *     "operator" is an actor-plane fact (hub identity), not a grant row.
 *   - **Actions are ENFORCEMENT vocabulary** — what a route checks via
 *     `can(actor, note, action)`. Future grant kinds extend the
 *     level→action table without breaking rank-math call sites.
 *
 * The kit consumes the host contract types (`SurfaceHostContext` et al.)
 * straight from `@openparachute/surface` — TYPE-ONLY imports, erased at
 * runtime, so holding the kit never drags host runtime code into a
 * backend bundle. Vault wire types come from `@openparachute/surface-client`.
 */

import type { Note } from "@openparachute/surface-client";

/** Re-exported host contract — the kit's functions take the real thing. */
export type {
  SurfaceHostContext,
  SurfaceLogger,
  SurfaceStateStore,
  TrustLayer,
} from "@openparachute/surface";
export type { Note } from "@openparachute/surface-client";

// ---------------------------------------------------------------------------
// Levels (grant vocabulary)
// ---------------------------------------------------------------------------

/** The grantable ladder, weakest → strongest. `own` is NOT here by design. */
export const LEVELS = ["view", "comment", "suggest", "edit"] as const;
export type Level = (typeof LEVELS)[number];

/** Rank for max-of-grants resolution. Higher = stronger. */
export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Actions (enforcement vocabulary)
// ---------------------------------------------------------------------------

/**
 * The action enum `can()` enforces. `manage_*` actions are OPERATOR-ONLY by
 * kit policy: tags are the sharing scope (writing them is privilege
 * escalation) and path moves can carry a note out of a path-locked grant —
 * so no level on the grant ladder ever reaches them (design §6).
 */
export const ACTIONS = [
  "read",
  "comment",
  "suggest",
  "edit_content",
  "manage_grants",
  "manage_tags",
  "manage_path",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The level→action table (design §6). Each level allows everything the
 * weaker levels allow plus its own verb; `manage_*` is reachable from NO
 * level (operator-only).
 */
export const LEVEL_ACTIONS: Readonly<Record<Level, readonly Action[]>> = {
  view: ["read"],
  comment: ["read", "comment"],
  suggest: ["read", "comment", "suggest"],
  edit: ["read", "comment", "suggest", "edit_content"],
};

/** Does `level` allow `action` per the table? Operator never calls this. */
export function levelAllows(level: Level, action: Action): boolean {
  return LEVEL_ACTIONS[level].includes(action);
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * The operator — hub identity, validated per-request via scope-guard
 * against the hub's JWKS (design headline 2: "Operator identity = hub,
 * everywhere"; no app-plane owner row). Allowed every action.
 */
export interface OperatorActor {
  kind: "operator";
  /** Hub JWT `sub` — the operator's stable id. */
  subject: string;
  /** Parsed scope list from the validated JWT. */
  scopes: readonly string[];
}

/**
 * An audience member — a link-session created from a capability or
 * personal link (design §3/§4). Identity is THE SURFACE'S, never the
 * hub's. Authorization comes from the GrantStore: the actor's grant
 * subjects are `cap:<capabilityId>` and (when email-bound)
 * `subject:<subjectId>`, plus the implicit `public`.
 */
export interface AudienceActor {
  kind: "audience";
  /** The session backing this request (cookie or Capability header). */
  sessionId: string;
  /** The capability the session was exchanged from. */
  capabilityId: string;
  /** Email-bound subject id for personal links; null for anonymous links. */
  subjectId: string | null;
}

/** Unauthenticated. Sees only what `public` grants (usually: nothing). */
export interface AnonActor {
  kind: "anon";
}

export type Actor = OperatorActor | AudienceActor | AnonActor;

export const ANON: AnonActor = { kind: "anon" };

/**
 * Grant-subject keys an actor matches in the GrantStore. Everyone —
 * including anon — matches `public`; that's the explicit opt-in for
 * world-readable resources (absent a `public` grant, anon sees nothing).
 */
export function grantSubjectsFor(actor: Actor): string[] {
  if (actor.kind === "operator") return []; // operator never consults grants
  if (actor.kind === "anon") return ["public"];
  const subjects = ["public", `cap:${actor.capabilityId}`];
  if (actor.subjectId !== null) subjects.push(`subject:${actor.subjectId}`);
  return subjects;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** What a grant attaches to. */
export const RESOURCE_TYPES = ["note", "path", "tag"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * One grant row (vault-native: a note tagged `surface-acl/<surface>` with
 * this shape as indexed metadata — design §5 option (a), picked in R4).
 *
 *   - `subject` — `public`, `cap:<capabilityId>`, or `subject:<subjectId>`.
 *   - `resourceType`/`resource` — `note` (note id), `path` (vault path
 *     prefix), or `tag` (literal tag membership).
 *   - `level` — the grant ladder value.
 *   - `expiresAt` — ISO timestamp; expired grants are dead rows awaiting
 *     cleanup, never matched.
 */
export interface Grant {
  /** The backing vault note's id — revocation = delete that note. */
  id: string;
  subject: string;
  resourceType: ResourceType;
  resource: string;
  level: Level;
  expiresAt: string | null;
}

/** Does `grant` apply to `note`? Pure resource matching (no expiry/time). */
export function grantMatchesNote(grant: Grant, note: Note): boolean {
  switch (grant.resourceType) {
    case "note":
      return note.id === grant.resource;
    case "path": {
      if (note.path === undefined) return false;
      const prefix = grant.resource.endsWith("/") ? grant.resource : `${grant.resource}/`;
      return note.path === grant.resource || note.path.startsWith(prefix);
    }
    case "tag":
      return Array.isArray(note.tags) && note.tags.includes(grant.resource);
  }
}
