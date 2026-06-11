import { describe, expect, test } from "bun:test";
import {
  GrantStore,
  aclTagFor,
  parseGrantNote,
  surfaceNameFromMount,
} from "../authz/grant-store.ts";
import { deliverSnapshot, grantNote, makeTestCtx } from "./helpers.ts";

describe("naming", () => {
  test("surfaceNameFromMount + aclTagFor", () => {
    expect(surfaceNameFromMount("/surface/woven-boulder")).toBe("woven-boulder");
    expect(aclTagFor("woven-boulder")).toBe("surface-acl/woven-boulder");
    expect(() => surfaceNameFromMount("/")).toThrow();
  });
});

describe("parseGrantNote (malformed rows grant NOTHING)", () => {
  test("parses the canonical shape", () => {
    const grant = parseGrantNote(
      grantNote({
        id: "g1",
        subjectType: "capability",
        subject: "abc",
        resourceType: "tag",
        resource: "meeting",
        level: "view",
      }),
    );
    expect(grant).toEqual({
      id: "g1",
      subject: "cap:abc",
      resourceType: "tag",
      resource: "meeting",
      level: "view",
      expiresAt: null,
    });
  });

  test("public subject composes to `public`", () => {
    const grant = parseGrantNote(
      grantNote({
        id: "g2",
        subjectType: "public",
        resourceType: "tag",
        resource: "t",
        level: "view",
      }),
    );
    expect(grant?.subject).toBe("public");
  });

  test("malformed variants → null", () => {
    const base = grantNote({
      id: "g3",
      subjectType: "subject",
      subject: "s1",
      resourceType: "note",
      resource: "n1",
      level: "edit",
    });
    const mutations: Array<Record<string, unknown>> = [
      { subject_type: "owner" }, // unknown subject type ("own" is never grantable)
      { subject: "" }, // empty subject for non-public
      { resource_type: "vault" }, // unknown resource type
      { resource: "" }, // empty resource
      { level: "admin" }, // unknown level
      { level: 4 }, // non-string level
      { expires_at: 12345 }, // non-string expiry
    ];
    for (const patch of mutations) {
      const note = { ...base, metadata: { ...base.metadata, ...patch } };
      expect(parseGrantNote(note)).toBeNull();
    }
    expect(parseGrantNote({ id: "x", createdAt: "now" })).toBeNull(); // no metadata at all
  });
});

describe("GrantStore live cache", () => {
  test("start() resolves on first snapshot; reads come from the cache", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    expect(store.tag).toBe("surface-acl/demo");
    const ready = store.start();
    const sub = t.vault.subscriptions[0];
    expect(sub).toBeDefined();
    expect(sub?.query).toEqual({ tag: "surface-acl/demo", expand: "exact" });
    deliverSnapshot(sub!, [
      grantNote({
        id: "g1",
        subjectType: "capability",
        subject: "abc",
        resourceType: "tag",
        resource: "t",
        level: "view",
      }),
    ]);
    await ready;
    expect(store.live).toBe(true);
    const grants = await store.grantsForSubjects(["cap:abc"]);
    expect(grants.map((g) => g.id)).toEqual(["g1"]);
    expect(t.vault.queryCalls).toBe(0); // enforcement never round-trips while live
  });

  test("upsert and remove keep the cache fresh; revocation propagates", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    deliverSnapshot(sub, []);
    await ready;

    sub.handlers.onUpsert(
      grantNote({
        id: "g1",
        subjectType: "subject",
        subject: "s1",
        resourceType: "note",
        resource: "n1",
        level: "edit",
      }),
    );
    expect((await store.grantsForSubjects(["subject:s1"])).length).toBe(1);

    sub.handlers.onRemove("g1"); // revocation = delete the note
    expect((await store.grantsForSubjects(["subject:s1"])).length).toBe(0);
  });

  test("a malformed upsert REPLACING a good row removes it (fail-closed)", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    const good = grantNote({
      id: "g1",
      subjectType: "subject",
      subject: "s1",
      resourceType: "note",
      resource: "n1",
      level: "edit",
    });
    deliverSnapshot(sub, [good]);
    await ready;
    sub.handlers.onUpsert({ ...good, metadata: { ...good.metadata, level: "superuser" } });
    expect((await store.grantsForSubjects(["subject:s1"])).length).toBe(0);
    expect(t.logs.warns.some((w) => w.includes("malformed grant note"))).toBe(true);
  });

  test("expired grants never match (unparseable expiry fails closed)", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx, { now: () => new Date("2026-06-10T12:00:00Z") });
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    deliverSnapshot(sub, [
      grantNote({
        id: "live",
        subjectType: "public",
        resourceType: "tag",
        resource: "t",
        level: "view",
        expiresAt: "2026-06-11T00:00:00Z",
      }),
      grantNote({
        id: "dead",
        subjectType: "public",
        resourceType: "tag",
        resource: "t",
        level: "view",
        expiresAt: "2026-06-09T00:00:00Z",
      }),
      grantNote({
        id: "junk",
        subjectType: "public",
        resourceType: "tag",
        resource: "t",
        level: "view",
        expiresAt: "whenever",
      }),
    ]);
    await ready;
    const grants = await store.grantsForSubjects(["public"]);
    expect(grants.map((g) => g.id)).toEqual(["live"]);
  });

  test("empty subject list short-circuits to []", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    expect(await store.grantsForSubjects([])).toEqual([]);
  });
});

describe("GrantStore fail-closed degradation (never stale-allow)", () => {
  test("stream loss → reads revalidate via one-shot query", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx, { revalidateReuseMs: 0 });
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    const grant = grantNote({
      id: "g1",
      subjectType: "capability",
      subject: "abc",
      resourceType: "tag",
      resource: "t",
      level: "view",
    });
    deliverSnapshot(sub, [grant]);
    await ready;

    // The operator revokes while the stream is down: the vault no longer
    // has the note, but the cache still does.
    sub.handlers.onStatus?.("reconnecting");
    expect(store.live).toBe(false);
    t.vault.notes.clear(); // truth: no grants

    const grants = await store.grantsForSubjects(["cap:abc"]);
    expect(grants).toEqual([]); // revalidation saw the revocation — no stale allow
    expect(t.vault.queryCalls).toBeGreaterThanOrEqual(1);
  });

  test("degraded + revalidation failure → deny (empty), with a warn", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx, { revalidateReuseMs: 0 });
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    deliverSnapshot(sub, [
      grantNote({
        id: "g1",
        subjectType: "capability",
        subject: "abc",
        resourceType: "tag",
        resource: "t",
        level: "view",
      }),
    ]);
    await ready;
    sub.handlers.onStatus?.("reconnecting");
    t.vault.queryError = new Error("vault unreachable");

    const grants = await store.grantsForSubjects(["cap:abc"]);
    expect(grants).toEqual([]); // stale-deny, not stale-allow
    expect(t.logs.warns.some((w) => w.includes("denying"))).toBe(true);
  });

  test("revalidation reuse window: one query serves a burst", async () => {
    const t = makeTestCtx();
    let now = Date.parse("2026-06-10T12:00:00Z");
    const store = new GrantStore(t.ctx, { revalidateReuseMs: 5000, now: () => new Date(now) });
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    deliverSnapshot(sub, []);
    await ready;
    sub.handlers.onStatus?.("reconnecting");

    await store.grantsForSubjects(["public"]);
    await store.grantsForSubjects(["public"]);
    expect(t.vault.queryCalls).toBe(1);
    now += 5001;
    await store.grantsForSubjects(["public"]);
    expect(t.vault.queryCalls).toBe(2);
  });

  test("a fresh snapshot restores live mode", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    const ready = store.start();
    const sub = t.vault.subscriptions[0]!;
    deliverSnapshot(sub, []);
    await ready;
    sub.handlers.onStatus?.("reconnecting");
    expect(store.live).toBe(false);
    deliverSnapshot(sub, []);
    expect(store.live).toBe(true);
  });
});

describe("GrantStore mutation (operator surface-domain ops)", () => {
  test("createGrant writes the canonical note shape + optimistic cache", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    const grant = await store.createGrant({
      subject: "cap:abc",
      resourceType: "note",
      resource: "n1",
      level: "comment",
      expiresAt: "2026-07-01T00:00:00Z",
    });
    const payload = t.vault.createdNotes[0]!;
    expect(payload.tags).toEqual(["surface-acl/demo"]);
    expect(payload.metadata).toEqual({
      subject_type: "capability",
      subject: "abc",
      resource_type: "note",
      resource: "n1",
      level: "comment",
      expires_at: "2026-07-01T00:00:00Z",
    });
    // Usable immediately on this instance (optimistic insert).
    expect(store.listGrants().map((g) => g.id)).toEqual([grant.id]);
  });

  test("createGrant rejects malformed subjects", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    await expect(
      store.createGrant({
        subject: "owner:me",
        resourceType: "note",
        resource: "n",
        level: "view",
      }),
    ).rejects.toThrow(/invalid subject/);
  });

  test("revokeGrant deletes the note and the cache row immediately", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    const grant = await store.createGrant({
      subject: "public",
      resourceType: "tag",
      resource: "t",
      level: "view",
    });
    await store.revokeGrant(grant.id);
    expect(t.vault.deletedIds).toEqual([grant.id]);
    expect(store.listGrants()).toEqual([]);
  });
});

describe("GrantStore onChange (the long-lived-authorization seam)", () => {
  test("fires on snapshot, upsert, remove, and local create/revoke; detach stops it", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    let fired = 0;
    const detach = store.onChange(() => {
      fired++;
    });

    const started = store.start();
    const sub = t.vault.subscriptions[0];
    if (!sub) throw new Error("no subscription registered");
    deliverSnapshot(sub, []);
    await started;
    expect(fired).toBe(1); // snapshot

    sub.handlers.onUpsert(
      grantNote({
        id: "g1",
        subjectType: "public",
        resourceType: "note",
        resource: "n1",
        level: "view",
      }),
    );
    expect(fired).toBe(2); // upsert

    sub.handlers.onRemove("g1");
    expect(fired).toBe(3); // remove

    const grant = await store.createGrant({
      subject: "public",
      resourceType: "note",
      resource: "n1",
      level: "view",
    });
    expect(fired).toBe(4); // optimistic create

    await store.revokeGrant(grant.id);
    expect(fired).toBe(5); // optimistic revoke

    detach();
    sub.handlers.onRemove("whatever");
    expect(fired).toBe(5); // detached — no further notifications
    store.stop();
  });

  test("a throwing handler is contained (warned, siblings still notified)", async () => {
    const t = makeTestCtx();
    const store = new GrantStore(t.ctx);
    let siblingFired = 0;
    store.onChange(() => {
      throw new Error("handler boom");
    });
    store.onChange(() => {
      siblingFired++;
    });
    await store.createGrant({
      subject: "public",
      resourceType: "note",
      resource: "n1",
      level: "view",
    });
    expect(siblingFired).toBe(1);
    expect(t.logs.warns.some((w) => w.includes("handler boom"))).toBe(true);
  });
});
