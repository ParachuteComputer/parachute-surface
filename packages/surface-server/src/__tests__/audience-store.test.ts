import { describe, expect, test } from "bun:test";
import { AudienceStore } from "../auth/audience-store.ts";
import { makeTestCtx } from "./helpers.ts";

function makeStore(now?: () => Date) {
  const { store } = makeTestCtx();
  return new AudienceStore(store, now ? { now } : {});
}

describe("AudienceStore", () => {
  test("secret is minted once and persists across instances", () => {
    const { store } = makeTestCtx();
    const a = new AudienceStore(store);
    const s1 = a.secret();
    expect(s1.byteLength).toBe(32);
    expect(a.secret()).toBe(s1);
    const b = new AudienceStore(store);
    expect(Buffer.from(b.secret()).equals(Buffer.from(s1))).toBe(true);
  });

  test("subjects: create, get, find by email, passwordHash is null v1 room", () => {
    const a = makeStore();
    const subject = a.createSubject("pat@example.com");
    expect(subject.passwordHash).toBeNull();
    expect(a.getSubject(subject.id)?.email).toBe("pat@example.com");
    expect(a.findSubjectByEmail("pat@example.com")?.id).toBe(subject.id);
    expect(a.findSubjectByEmail("nobody@example.com")).toBeNull();
  });

  test("capability lifecycle: usable → revoked fails closed", () => {
    const a = makeStore();
    const cap = a.createCapability({ kind: "cap" });
    expect(a.capabilityUsable(a.getCapability(cap.id))).toBe(true);
    expect(a.revokeCapability(cap.id)).toBe(true);
    expect(a.capabilityUsable(a.getCapability(cap.id))).toBe(false);
    // Double revoke is a no-op
    expect(a.revokeCapability(cap.id)).toBe(false);
  });

  test("capability expiry fails closed (including unparseable expiry)", () => {
    let nowMs = Date.parse("2026-06-10T12:00:00Z");
    const a = makeStore(() => new Date(nowMs));
    const expiring = a.createCapability({ kind: "cap", expiresAt: "2026-06-10T13:00:00Z" });
    expect(a.capabilityUsable(a.getCapability(expiring.id))).toBe(true);
    nowMs = Date.parse("2026-06-10T13:00:01Z");
    expect(a.capabilityUsable(a.getCapability(expiring.id))).toBe(false);

    const garbage = a.createCapability({ kind: "cap", expiresAt: "not-a-date" });
    expect(a.capabilityUsable(a.getCapability(garbage.id))).toBe(false);
  });

  test("unknown capability is unusable", () => {
    const a = makeStore();
    expect(a.capabilityUsable(a.getCapability("missing"))).toBe(false);
  });

  test("sessions resolve while fresh and expire on TTL", () => {
    let nowMs = Date.parse("2026-06-10T12:00:00Z");
    const a = makeStore(() => new Date(nowMs));
    const cap = a.createCapability({ kind: "cap" });
    const session = a.createSession({ capabilityId: cap.id, ttlMs: 60_000 });
    expect(a.resolveSession(session.id)?.capabilityId).toBe(cap.id);
    nowMs += 60_001;
    expect(a.resolveSession(session.id)).toBeNull();
  });

  test("revoking the capability kills its live sessions immediately", () => {
    const a = makeStore();
    const cap = a.createCapability({ kind: "cap" });
    const session = a.createSession({ capabilityId: cap.id, ttlMs: 60_000 });
    expect(a.resolveSession(session.id)).not.toBeNull();
    a.revokeCapability(cap.id);
    expect(a.resolveSession(session.id)).toBeNull();
  });

  test("personal-link exchange stamp persists", () => {
    const a = makeStore();
    const subject = a.createSubject("pat@example.com");
    const lnk = a.createCapability({ kind: "lnk", subjectId: subject.id });
    expect(a.getCapability(lnk.id)?.exchangedAt).toBeNull();
    a.markExchanged(lnk.id);
    expect(a.getCapability(lnk.id)?.exchangedAt).not.toBeNull();
    expect(a.getCapability(lnk.id)?.subjectId).toBe(subject.id);
  });

  test("deleteSession removes the record", () => {
    const a = makeStore();
    const cap = a.createCapability({ kind: "cap" });
    const session = a.createSession({ capabilityId: cap.id, ttlMs: 60_000 });
    a.deleteSession(session.id);
    expect(a.resolveSession(session.id)).toBeNull();
  });
});
