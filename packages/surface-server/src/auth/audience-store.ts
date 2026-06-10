/**
 * AudienceStore — the surface's OPERATIONAL identity records, persisted in
 * the per-surface state store (`ctx.store`, SQLite — deleted with the
 * surface). Knowledge (who may access what) lives in the vault-native
 * GrantStore; this store holds only the machinery records (design §5:
 * "Sessions/caches stay app-side either way — operational, not
 * knowledge"):
 *
 *   - **subjects** — audience identities for personal links, keyed by a
 *     random id, carrying an email. `passwordHash` is nullable SCHEMA
 *     ROOM ONLY (design §3): no password endpoints exist in v1; the field
 *     means passwords/passkeys are a v2 feature-add, not a migration.
 *   - **capabilities** — mint records for both token kinds: expiry,
 *     revocation, single-use exchange state for personal links.
 *   - **sessions** — link-sessions created at the entry route (cookie) or
 *     ridden by `Authorization: Capability` programmatic clients.
 *
 * Storage layout: one JSON blob per record under prefixed keys
 * (`auth/subject/<id>`, `auth/capability/<id>`, `auth/session/<id>`),
 * plus the signing secret under `auth/secret`. The store's `list()` is
 * metadata-only and key-ordered, so prefix scans are cheap at v1 scale.
 */

import type { SurfaceHostContext } from "@openparachute/surface";
import { newSecret, newTokenId } from "./capability.ts";

const SECRET_KEY = "auth/secret";
const SUBJECT_PREFIX = "auth/subject/";
const CAPABILITY_PREFIX = "auth/capability/";
const SESSION_PREFIX = "auth/session/";

/** An email-bound audience identity (personal links bind to one). */
export interface SubjectRecord {
  id: string;
  email: string;
  /**
   * v2 room (design §3) — ALWAYS null in v1; no code path sets or reads
   * it beyond persistence.
   */
  passwordHash: string | null;
  createdAt: string;
}

/** Mint record for a capability (`cap`) or personal link (`lnk`). */
export interface CapabilityRecord {
  id: string;
  kind: "cap" | "lnk";
  /** Personal links bind a subject; shareable capabilities don't. */
  subjectId: string | null;
  createdAt: string;
  /** ISO expiry; null = no expiry (grant rows may still expire). */
  expiresAt: string | null;
  /** Set on revoke — verification fails closed from then on. */
  revokedAt: string | null;
  /**
   * Personal links are SINGLE-USE: the entry exchange stamps this and any
   * further exchange is refused (re-issue = the recovery flow). Always
   * null for `cap` tokens (multi-use by design).
   */
  exchangedAt: string | null;
}

/** A link-session — what the cookie (or Capability header) resolves to. */
export interface SessionRecord {
  id: string;
  capabilityId: string;
  subjectId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AudienceStoreOptions {
  /** Clock seam (tests). */
  now?: () => Date;
}

export class AudienceStore {
  readonly #store: SurfaceHostContext["store"];
  readonly #now: () => Date;
  #secret: Uint8Array | null = null;

  constructor(store: SurfaceHostContext["store"], opts: AudienceStoreOptions = {}) {
    this.#store = store;
    this.#now = opts.now ?? (() => new Date());
  }

  // ---------- secret custody ----------

  /** The per-surface signing secret — minted + persisted on first use. */
  secret(): Uint8Array {
    if (this.#secret) return this.#secret;
    const existing = this.#store.get(SECRET_KEY);
    if (existing && existing.blob.byteLength === 32) {
      this.#secret = existing.blob;
      return this.#secret;
    }
    const fresh = newSecret();
    this.#store.put(SECRET_KEY, fresh);
    this.#secret = fresh;
    return fresh;
  }

  // ---------- subjects ----------

  createSubject(email: string): SubjectRecord {
    const record: SubjectRecord = {
      id: newTokenId(),
      email,
      passwordHash: null,
      createdAt: this.#now().toISOString(),
    };
    this.#put(SUBJECT_PREFIX + record.id, record);
    return record;
  }

  getSubject(id: string): SubjectRecord | null {
    return this.#get<SubjectRecord>(SUBJECT_PREFIX + id);
  }

  /**
   * Existing subject for an email (exact match), or null.
   *
   * Deliberate v1 trade-off: a linear scan of the store's keys on every
   * personal-link mint. A surface's per-surface state store is small and
   * mints are infrequent, so O(n) is acceptable; revisit with an email
   * index if a surface accrues a large audience.
   */
  findSubjectByEmail(email: string): SubjectRecord | null {
    for (const meta of this.#store.list()) {
      if (!meta.key.startsWith(SUBJECT_PREFIX)) continue;
      const rec = this.#get<SubjectRecord>(meta.key);
      if (rec && rec.email === email) return rec;
    }
    return null;
  }

  // ---------- capabilities ----------

  createCapability(args: {
    kind: "cap" | "lnk";
    subjectId?: string | null;
    expiresAt?: string | null;
  }): CapabilityRecord {
    const record: CapabilityRecord = {
      id: newTokenId(),
      kind: args.kind,
      subjectId: args.subjectId ?? null,
      createdAt: this.#now().toISOString(),
      expiresAt: args.expiresAt ?? null,
      revokedAt: null,
      exchangedAt: null,
    };
    this.#put(CAPABILITY_PREFIX + record.id, record);
    return record;
  }

  getCapability(id: string): CapabilityRecord | null {
    return this.#get<CapabilityRecord>(CAPABILITY_PREFIX + id);
  }

  /**
   * Is this capability presentable right now? Fail-closed on missing,
   * revoked, or expired records.
   */
  capabilityUsable(record: CapabilityRecord | null): record is CapabilityRecord {
    if (!record) return false;
    if (record.revokedAt !== null) return false;
    if (record.expiresAt !== null) {
      const expires = Date.parse(record.expiresAt);
      // Unparseable expiry fails closed.
      if (Number.isNaN(expires) || expires <= this.#now().getTime()) return false;
    }
    return true;
  }

  /** Stamp the single-use exchange on a personal link. */
  markExchanged(id: string): void {
    const rec = this.getCapability(id);
    if (!rec) return;
    rec.exchangedAt = this.#now().toISOString();
    this.#put(CAPABILITY_PREFIX + id, rec);
  }

  /** Revoke a capability — sessions minted from it die with it. */
  revokeCapability(id: string): boolean {
    const rec = this.getCapability(id);
    if (!rec || rec.revokedAt !== null) return false;
    rec.revokedAt = this.#now().toISOString();
    this.#put(CAPABILITY_PREFIX + id, rec);
    return true;
  }

  // ---------- sessions ----------

  createSession(args: {
    capabilityId: string;
    subjectId?: string | null;
    ttlMs: number;
  }): SessionRecord {
    const createdAt = this.#now();
    const record: SessionRecord = {
      id: newTokenId() + newTokenId(), // 256-bit session id
      capabilityId: args.capabilityId,
      subjectId: args.subjectId ?? null,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + args.ttlMs).toISOString(),
    };
    this.#put(SESSION_PREFIX + record.id, record);
    return record;
  }

  /**
   * Resolve a presented session id. Fail-closed: unknown/expired sessions
   * and sessions whose backing capability is no longer usable (revoked,
   * expired, deleted) all return null — capability revocation kills its
   * live sessions immediately.
   */
  resolveSession(id: string): SessionRecord | null {
    const rec = this.#get<SessionRecord>(SESSION_PREFIX + id);
    if (!rec) return null;
    const expires = Date.parse(rec.expiresAt);
    if (Number.isNaN(expires) || expires <= this.#now().getTime()) return null;
    const cap = this.getCapability(rec.capabilityId);
    if (!this.capabilityUsable(cap)) return null;
    return rec;
  }

  deleteSession(id: string): void {
    this.#store.delete(SESSION_PREFIX + id);
  }

  // ---------- plumbing ----------

  #put(key: string, value: unknown): void {
    this.#store.put(key, JSON.stringify(value));
  }

  #get<T>(key: string): T | null {
    const entry = this.#store.get(key);
    if (!entry) return null;
    try {
      return JSON.parse(new TextDecoder().decode(entry.blob)) as T;
    } catch {
      return null;
    }
  }
}
