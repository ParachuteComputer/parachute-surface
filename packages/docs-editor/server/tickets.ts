/**
 * Collab WS tickets — the bridge between the HTTP trust plane and the
 * Hocuspocus Auth protocol message.
 *
 * Why tickets: the host's WS pump hands a backend frames + trust signals,
 * not the upgrade Request — and a browser audience session rides an
 * httpOnly cookie its JS can't read, so neither the cookie nor a hub JWT
 * can ride the WS handshake into the backend. Instead the client calls
 * `POST ${mount}/api/collab/ticket` over the NORMAL gateway (cookie or
 * Bearer — the same P7 actor resolution as every route), receives a
 * short-lived single-use opaque ticket, and presents it as the Hocuspocus
 * `token`. `onAuthenticate` redeems it back into the actor.
 *
 * Properties: single-use (redeem deletes), short TTL (default 60s — the
 * client mints per connect), in-memory only (a restart invalidates
 * outstanding tickets; clients just re-mint). The ticket never grants
 * anything itself — every document the connection opens is still
 * authorized per-document against the GrantStore at `onAuthenticate`
 * time, with the REDEEMED actor.
 */

import { randomBytes } from "node:crypto";
import type { Actor } from "@openparachute/surface-server";

interface TicketRecord {
  actor: Actor;
  expiresAtMs: number;
}

export interface TicketStoreOptions {
  /** Ticket lifetime. Default 60s. */
  ttlMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
}

export class TicketStore {
  readonly #tickets = new Map<string, TicketRecord>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(opts: TicketStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Mint a single-use ticket bound to `actor`. */
  mint(actor: Actor): { ticket: string; expiresInMs: number } {
    this.#sweep();
    const ticket = `tkt_${randomBytes(24).toString("base64url")}`;
    this.#tickets.set(ticket, { actor, expiresAtMs: this.#now() + this.#ttlMs });
    return { ticket, expiresInMs: this.#ttlMs };
  }

  /** Redeem (single-use): the bound actor, or null (unknown/expired/reused). */
  redeem(ticket: string): Actor | null {
    const record = this.#tickets.get(ticket);
    if (!record) return null;
    this.#tickets.delete(ticket);
    if (record.expiresAtMs <= this.#now()) return null;
    return record.actor;
  }

  /** Drop expired tickets (called on mint — bounds the map). */
  #sweep(): void {
    const now = this.#now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAtMs <= now) this.#tickets.delete(ticket);
    }
  }

  get size(): number {
    return this.#tickets.size;
  }
}
