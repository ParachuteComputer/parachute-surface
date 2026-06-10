/**
 * SurfaceAuthz — P8's `can(actor, note, action)`.
 *
 * The decision procedure (design §6):
 *
 *   1. **Operator** → allowed, every action. The operator is the actor
 *      plane's `own`; it never consults grants (and is therefore immune
 *      to GrantStore degradation — backend-down degrades the audience,
 *      not the operator).
 *   2. **`manage_*` actions** → operator-only, full stop. No grant level
 *      reaches them: tags are the sharing scope (writing them is
 *      privilege escalation) and a path move can carry a note out of a
 *      path-locked grant.
 *   3. **Audience / anon** → resolve the actor's grant subjects
 *      (`public` [+ `cap:<id>` + `subject:<id>`]), pull their unexpired
 *      grants, keep those matching THIS note (id / path-prefix / tag),
 *      take the strongest level, check the level→action table.
 *      No matching grant → deny. Deny is the default everywhere.
 */

import type { Action, Actor, Note } from "../types.ts";
import {
  type Level,
  grantMatchesNote,
  grantSubjectsFor,
  levelAllows,
  levelRank,
} from "../types.ts";
import type { GrantStore } from "./grant-store.ts";

export class SurfaceAuthz {
  readonly #grants: GrantStore;

  constructor(grants: GrantStore) {
    this.#grants = grants;
  }

  get grants(): GrantStore {
    return this.#grants;
  }

  /**
   * The strongest grant level `actor` holds on `note`, or null when no
   * grant matches (deny). Operator returns null too — callers must check
   * `actor.kind` first (or just use {@link can}, which does).
   */
  async levelFor(actor: Actor, note: Note): Promise<Level | null> {
    const subjects = grantSubjectsFor(actor);
    if (subjects.length === 0) return null;
    const grants = await this.#grants.grantsForSubjects(subjects);
    let best: Level | null = null;
    for (const grant of grants) {
      if (!grantMatchesNote(grant, note)) continue;
      if (best === null || levelRank(grant.level) > levelRank(best)) {
        best = grant.level;
      }
    }
    return best;
  }

  /** THE enforcement question. Deny-by-default in every branch. */
  async can(actor: Actor, note: Note, action: Action): Promise<boolean> {
    if (actor.kind === "operator") return true;
    if (action === "manage_grants" || action === "manage_tags" || action === "manage_path") {
      return false; // operator-only, no grant level reaches these
    }
    const level = await this.levelFor(actor, note);
    if (level === null) return false;
    return levelAllows(level, action);
  }
}

/** P8 factory — pairs with `createSurfaceAuth` inside `createBackend(ctx)`. */
export function createSurfaceAuthz(grants: GrantStore): SurfaceAuthz {
  return new SurfaceAuthz(grants);
}
