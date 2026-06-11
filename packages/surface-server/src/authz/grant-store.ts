/**
 * GrantStore — vault-native grants with an SSE-fed enforcement cache
 * (design §5; R4 picks option (a), the vault-native backing).
 *
 * Each grant is a vault note tagged `surface-acl/<surface>` with the
 * grant row as metadata (`subject_type, subject, resource_type, resource,
 * level, expires_at`). The vault is the source of truth — inspectable,
 * synced, agent-visible, reinstall-surviving; **revocation = delete the
 * note** and the live query propagates it.
 *
 * Enforcement never round-trips the vault per request: an in-memory cache
 * is fed by `ctx.vault.subscribe(...)` (surface-client Tier 1 live-query
 * SSE — snapshot on (re)connect, then upsert/remove). Reconnects deliver
 * a fresh snapshot, so the cache self-corrects.
 *
 * FAIL-CLOSED ON STREAM LOSS (the load-bearing property): while the
 * stream is down, the cache may be missing a revocation — serving allows
 * from it would be stale-allow widening. So while degraded, reads either
 * **revalidate** (a single-flight one-shot `queryNotes` refresh, bounded
 * by a short reuse window) or **deny** (revalidation failed → empty grant
 * set, which denies everything). Stale-allow never happens; stale-DENY
 * (a freshly-minted grant not visible while degraded) is the accepted
 * degradation direction.
 *
 * Grant-note parse failures fail closed too: an unparseable row grants
 * nothing (it is skipped, with a warn) — never "defaults".
 */

import type { SurfaceHostContext } from "@openparachute/surface";
import type { Note } from "@openparachute/surface-client";
import type { Grant, Level, ResourceType } from "../types.ts";
import { RESOURCE_TYPES, isLevel } from "../types.ts";

/** The ACL tag for one surface. */
export function aclTagFor(surface: string): string {
  return `surface-acl/${surface}`;
}

/** Derive the surface name from its mount path (`/surface/<name>`). */
export function surfaceNameFromMount(mount: string): string {
  const seg = mount
    .split("/")
    .filter((s) => s.length > 0)
    .pop();
  if (!seg) throw new Error(`GrantStore: cannot derive surface name from mount "${mount}"`);
  return seg;
}

/** Wire subject_type values on grant notes. */
export type GrantSubjectType = "public" | "capability" | "subject";

export interface CreateGrantArgs {
  /**
   * Composed subject key: `"public"`, `"cap:<capabilityId>"`, or
   * `"subject:<subjectId>"` — same vocabulary `grantSubjectsFor` emits.
   */
  subject: string;
  resourceType: ResourceType;
  resource: string;
  level: Level;
  /** ISO expiry; omitted = standing until revoked. */
  expiresAt?: string | null;
  /** Human-readable note content (defaults to a generated description). */
  description?: string;
}

export interface GrantStoreOptions {
  /** Override the surface name (default: derived from `ctx.mount`). */
  surface?: string;
  /**
   * How long a degraded-mode revalidation result may be reused before the
   * next read triggers another one-shot query. Default 5s.
   */
  revalidateReuseMs?: number;
  /** Clock seam (tests). */
  now?: () => Date;
}

/** Decompose a composed subject key into wire parts. */
function subjectParts(subject: string): { type: GrantSubjectType; id: string } {
  if (subject === "public") return { type: "public", id: "" };
  if (subject.startsWith("cap:")) return { type: "capability", id: subject.slice(4) };
  if (subject.startsWith("subject:")) return { type: "subject", id: subject.slice(8) };
  throw new Error(
    `GrantStore: invalid subject "${subject}" — expected "public", "cap:<id>", or "subject:<id>"`,
  );
}

/** Compose the cache key from wire parts. */
function composeSubject(type: GrantSubjectType, id: string): string {
  if (type === "public") return "public";
  return type === "capability" ? `cap:${id}` : `subject:${id}`;
}

/**
 * Parse a grant note's metadata into a {@link Grant}. Null on ANY
 * malformed field — an unparseable grant row grants nothing.
 */
export function parseGrantNote(note: Note): Grant | null {
  const meta = note.metadata;
  if (!meta || typeof meta !== "object") return null;
  const subjectType = meta.subject_type;
  if (subjectType !== "public" && subjectType !== "capability" && subjectType !== "subject") {
    return null;
  }
  const subjectId = meta.subject;
  if (subjectType !== "public" && (typeof subjectId !== "string" || subjectId.length === 0)) {
    return null;
  }
  const resourceType = meta.resource_type;
  if (
    typeof resourceType !== "string" ||
    !(RESOURCE_TYPES as readonly string[]).includes(resourceType)
  ) {
    return null;
  }
  const resource = meta.resource;
  if (typeof resource !== "string" || resource.length === 0) return null;
  if (!isLevel(meta.level)) return null;
  let expiresAt: string | null = null;
  if (meta.expires_at !== undefined && meta.expires_at !== null) {
    if (typeof meta.expires_at !== "string") return null;
    expiresAt = meta.expires_at;
  }
  return {
    id: note.id,
    subject: composeSubject(subjectType, typeof subjectId === "string" ? subjectId : ""),
    resourceType: resourceType as ResourceType,
    resource,
    level: meta.level,
    expiresAt,
  };
}

export class GrantStore {
  readonly #ctx: SurfaceHostContext;
  readonly #tag: string;
  readonly #now: () => Date;
  readonly #revalidateReuseMs: number;

  /** noteId → parsed grant. Rebuilt on every snapshot. */
  #cache = new Map<string, Grant>();
  /** True only between a delivered snapshot and the next stream loss. */
  #live = false;
  #unsubscribe: (() => void) | null = null;
  /** Single-flight degraded-mode revalidation. */
  #revalidating: Promise<void> | null = null;
  #revalidatedAt = 0;
  /** Change listeners — see {@link onChange}. */
  readonly #changeHandlers = new Set<() => void>();

  constructor(ctx: SurfaceHostContext, opts: GrantStoreOptions = {}) {
    this.#ctx = ctx;
    this.#tag = aclTagFor(opts.surface ?? surfaceNameFromMount(ctx.mount));
    this.#now = opts.now ?? (() => new Date());
    this.#revalidateReuseMs = opts.revalidateReuseMs ?? 5_000;
  }

  /** The ACL tag this store watches (`surface-acl/<surface>`). */
  get tag(): string {
    return this.#tag;
  }

  /**
   * Subscribe to grant-set changes — fired after ANY cache mutation:
   * stream snapshot/upsert/remove, degraded-revalidation rebuild, and the
   * local optimistic createGrant/revokeGrant writes. Coarse by design (no
   * payload): consumers holding long-lived authorization (live collab
   * connections) re-evaluate against `grantsForSubjects`/`can()` — the
   * enforcement read stays the single source of truth. Returns the
   * detach function. Handler errors are contained (warn, never thrown
   * into the stream).
   */
  onChange(handler: () => void): () => void {
    this.#changeHandlers.add(handler);
    return () => {
      this.#changeHandlers.delete(handler);
    };
  }

  // NOTE: a revalidation triggered FROM a consumer's change-handler work
  // (e.g. a session sweep calling can() in degraded mode) fires this again —
  // consumers must tolerate re-entrant notifications (the docs-editor sweep
  // handles it with a single-flight + re-queue bit).
  #notifyChange(): void {
    for (const handler of this.#changeHandlers) {
      try {
        handler();
      } catch (err) {
        this.#ctx.log.warn(`GrantStore: onChange handler threw (${(err as Error).message ?? err})`);
      }
    }
  }

  /** Is the live stream currently feeding the cache? */
  get live(): boolean {
    return this.#live;
  }

  /**
   * Start the live subscription. Resolves once the FIRST snapshot lands
   * (or rejects if the stream terminally fails before one arrives) so
   * callers can sequence "authz ready" into their backend factory.
   * Subscription lifetime is keyed to `ctx.shutdownSignal` and `stop()`.
   */
  start(): Promise<void> {
    if (this.#unsubscribe) return Promise.resolve();
    return new Promise<void>((resolveFirst, rejectFirst) => {
      let settled = false;
      const unsubscribe = this.#ctx.vault.subscribe(
        { tag: this.#tag, expand: "exact" },
        {
          onSnapshot: (notes) => {
            this.#cache = new Map();
            for (const note of notes) this.#absorb(note);
            this.#live = true;
            this.#notifyChange();
            if (!settled) {
              settled = true;
              resolveFirst();
            }
          },
          onUpsert: (note) => {
            this.#absorb(note);
            this.#notifyChange();
          },
          onRemove: (id) => {
            this.#cache.delete(id);
            this.#notifyChange();
          },
          onError: (err) => {
            this.#ctx.log.warn(`GrantStore stream error: ${(err as Error).message ?? err}`);
          },
          onStatus: (status) => {
            if (status === "open") return;
            // connecting / reconnecting / closed — the cache may miss a
            // revocation from here on: degrade (fail closed) until the
            // next snapshot.
            this.#live = false;
            if (status === "closed" && !settled) {
              settled = true;
              rejectFirst(new Error("GrantStore: subscription closed before first snapshot"));
            }
          },
        },
        { signal: this.#ctx.shutdownSignal },
      );
      this.#unsubscribe = unsubscribe;
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#live = false;
  }

  #absorb(note: Note): void {
    const grant = parseGrantNote(note);
    if (grant) {
      this.#cache.set(note.id, grant);
    } else {
      this.#cache.delete(note.id);
      this.#ctx.log.warn(`GrantStore: skipping malformed grant note ${note.id} (grants nothing)`);
    }
  }

  /**
   * Every unexpired grant for any of `subjects` — THE enforcement read.
   *
   * Live → straight from the cache. Degraded → revalidate first
   * (single-flight one-shot query, reused for `revalidateReuseMs`);
   * revalidation failure → EMPTY result (deny-by-default downstream).
   * Stale-allow never happens.
   */
  async grantsForSubjects(subjects: readonly string[]): Promise<Grant[]> {
    if (subjects.length === 0) return [];
    if (!this.#live) {
      try {
        await this.#revalidate();
      } catch (err) {
        this.#ctx.log.warn(
          `GrantStore: degraded and revalidation failed — denying (${(err as Error).message ?? err})`,
        );
        return [];
      }
    }
    const wanted = new Set(subjects);
    const nowMs = this.#now().getTime();
    const out: Grant[] = [];
    for (const grant of this.#cache.values()) {
      if (!wanted.has(grant.subject)) continue;
      if (grant.expiresAt !== null) {
        const expires = Date.parse(grant.expiresAt);
        if (Number.isNaN(expires) || expires <= nowMs) continue; // unparseable expiry fails closed
      }
      out.push(grant);
    }
    return out;
  }

  /** One-shot cache rebuild for degraded mode (single-flight + reuse window). */
  #revalidate(): Promise<void> {
    const nowMs = this.#now().getTime();
    if (nowMs - this.#revalidatedAt < this.#revalidateReuseMs) return Promise.resolve();
    if (this.#revalidating) return this.#revalidating;
    this.#revalidating = (async () => {
      try {
        const notes = await this.#ctx.vault.queryNotes({ tag: this.#tag, expand: "exact" });
        this.#cache = new Map();
        for (const note of notes) this.#absorb(note);
        this.#revalidatedAt = this.#now().getTime();
        this.#notifyChange();
      } finally {
        this.#revalidating = null;
      }
    })();
    return this.#revalidating;
  }

  // -------------------------------------------------------------------
  // Mutation (operator surface-domain ops)
  // -------------------------------------------------------------------

  /**
   * Write a grant note. The optimistic cache insert makes a fresh grant
   * usable immediately on THIS instance; the stream upsert confirms it.
   */
  async createGrant(args: CreateGrantArgs): Promise<Grant> {
    const parts = subjectParts(args.subject); // throws on malformed subject
    const description =
      args.description ??
      `Grant: ${args.subject} may ${args.level} ${args.resourceType} ${args.resource}`;
    const note = await this.#ctx.vault.createNote({
      content: description,
      tags: [this.#tag],
      metadata: {
        subject_type: parts.type,
        subject: parts.id,
        resource_type: args.resourceType,
        resource: args.resource,
        level: args.level,
        ...(args.expiresAt != null ? { expires_at: args.expiresAt } : {}),
      },
    });
    const grant: Grant = {
      id: note.id,
      subject: args.subject,
      resourceType: args.resourceType,
      resource: args.resource,
      level: args.level,
      expiresAt: args.expiresAt ?? null,
    };
    this.#cache.set(note.id, grant);
    this.#notifyChange();
    return grant;
  }

  /**
   * Revoke = delete the grant note. The cache delete is immediate and
   * local (narrowing is always safe); the stream remove propagates it to
   * any sibling consumers.
   */
  async revokeGrant(id: string): Promise<void> {
    this.#cache.delete(id);
    this.#notifyChange();
    await this.#ctx.vault.deleteNote(id);
  }

  /** Snapshot of the current (cached) grant set — operator listing UI. */
  listGrants(): Grant[] {
    return [...this.#cache.values()];
  }
}
