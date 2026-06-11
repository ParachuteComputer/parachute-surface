/**
 * P10 — createVaultReconciler. Every test drives a REAL Y.Doc through the
 * machine; the FakeVault enforces vault's actual optimistic-concurrency
 * contract (verbatim `if_updated_at`, 409 on stale baseline) and hands out
 * deliberately OPAQUE version strings so any parse/normalize of
 * `updatedAt` breaks loudly (design §9).
 */

import { describe, expect, test } from "bun:test";
import { type Note, VaultNotFoundError } from "@openparachute/surface-client";
import * as Y from "yjs";
import {
  RECONCILER_ORIGIN,
  type ReconcilerEvent,
  type ReconcilerHooks,
  type VaultReconciler,
  createVaultReconciler,
} from "../reconciler/reconciler.ts";
import { type FakeSubscription, type TestCtx, deliverSnapshot, makeTestCtx } from "./helpers.ts";

/** Plain Y.Text hooks — engine-agnostic, format-agnostic (the kit seam). */
const textHooks: ReconcilerHooks = {
  seed(doc, note) {
    const text = doc.getText("content");
    text.delete(0, text.length);
    text.insert(0, note.content ?? "");
  },
  serialize(doc) {
    return doc.getText("content").toString();
  },
};

function textOf(doc: Y.Doc): string {
  return doc.getText("content").toString();
}

function editText(doc: Y.Doc, append: string): void {
  const text = doc.getText("content");
  text.insert(text.length, append);
}

async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** start() + first snapshot → live. */
async function startLive(
  rec: VaultReconciler,
  t: TestCtx,
  notes: Note[],
): Promise<FakeSubscription> {
  const ready = rec.start();
  const sub = t.vault.subscriptions[0];
  if (!sub) throw new Error("no subscription opened");
  deliverSnapshot(sub, notes);
  await ready;
  return sub;
}

function collectEvents(rec: VaultReconciler): ReconcilerEvent[] {
  const events: ReconcilerEvent[] = [];
  rec.on((ev) => events.push(ev));
  return events;
}

/** §9: no force flag EVER rides a reconciler writeback. */
function expectNoForce(t: TestCtx): void {
  for (const call of t.vault.updateCalls) {
    expect("force" in call.payload).toBe(false);
  }
}

describe("load", () => {
  test("seeds an unpopulated doc from the vault and persists the baseline", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "hello vault");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });

    const doc = await rec.load("n1");
    expect(textOf(doc)).toBe("hello vault");

    const entry = t.store.get("ydoc/n1");
    expect(entry).not.toBeNull();
    expect(entry?.sourceVersion).toBe(note.updatedAt as string); // verbatim opaque string
    expect(entry?.dirty).toBe(false);

    // Seeding is a reconciler-origin transaction: it must NOT count as a
    // local edit (no writeback gets scheduled).
    await sleep(30);
    expect(t.vault.updateCalls.length).toBe(0);
  });

  test("throws the FRIENDLY error for a note the vault doesn't have (typed not-found normalized, #109)", async () => {
    const t = makeTestCtx();
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks });
    // The vault client THROWS a typed not-found (never resolves null) —
    // the machine normalizes it so the guidance branch is reachable.
    await expect(rec.load("missing")).rejects.toThrow(
      /create the note in the vault before loading its doc/,
    );
  });

  test("double-load returns the same doc; a different provided doc throws", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "x");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks });
    const doc = await rec.load("n1");
    expect(await rec.load("n1")).toBe(doc);
    await expect(rec.load("n1", new Y.Doc())).rejects.toThrow(/different Y.Doc/);
  });

  test("populated re-seed guard: never seeds over a doc that carries state", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "vault content");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });

    const provided = new Y.Doc();
    provided.getText("content").insert(0, "live client state");
    const doc = await rec.load("n1", provided);

    expect(doc).toBe(provided);
    expect(textOf(doc)).toBe("live client state"); // NOT clobbered by the seed

    // The baseline adopted is the CURRENT vault version: a writeback from
    // the guarded doc succeeds against it.
    editText(doc, "!");
    await rec.flush("n1");
    expect(t.vault.updateCalls.length).toBe(1);
    expect(t.vault.updateCalls[0]?.payload.if_updated_at).toBe(note.updatedAt as string);
    expect(t.vault.notes.get("n1")?.content).toBe("live client state!");
    expectNoForce(t);
  });
});

describe("writeback", () => {
  test("debounced writeback sends if_updated_at VERBATIM, never force, and adopts the ack", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const doc = await rec.load("n1");

    editText(doc, " + local");
    await until(() => t.vault.updateCalls.length === 1);
    const first = t.vault.updateCalls[0];
    expect(first?.payload.content).toBe("base + local");
    expect(first?.payload.if_updated_at).toBe(note.updatedAt as string); // "v-1", verbatim
    expect(first && "force" in first.payload).toBe(false);

    // Ack adopted: the store baseline moves to the response's version.
    const acked = t.vault.notes.get("n1")?.updatedAt as string;
    await until(() => t.store.get("ydoc/n1")?.sourceVersion === acked);
    expect(t.store.get("ydoc/n1")?.dirty).toBe(false);

    // A second edit writes back against the ACKED version (still verbatim).
    editText(doc, "!");
    await until(() => t.vault.updateCalls.length === 2);
    expect(t.vault.updateCalls[1]?.payload.if_updated_at).toBe(acked);
    expectNoForce(t);
  });

  test("flush is a no-op for a clean doc", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "clean");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks });
    await rec.load("n1");
    await rec.flush("n1");
    await rec.flush(); // all-docs variant
    expect(t.vault.updateCalls.length).toBe(0);
  });

  test("409 → fetch winner → re-seed into the live doc in ONE transaction", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    // Live stream (the external edit below arrives WITHOUT an SSE event —
    // the 409 is the machine's backstop, not the primary signal).
    await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    // A connected client, wired through the real update relay.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    let relayedUpdates = 0;
    doc.on("update", (update: Uint8Array) => {
      relayedUpdates++;
      Y.applyUpdate(client, update);
    });

    editText(doc, " + doomed local");
    const winner = t.vault.externalEdit("n1", "external wins"); // bumps the version under us

    const updatesBeforeFlush = relayedUpdates;
    await rec.flush("n1");

    // The stale writeback was attempted with the verbatim old baseline…
    expect(t.vault.updateCalls.length).toBe(1);
    expect(t.vault.updateCalls[0]?.payload.if_updated_at).toBe("v-1");
    expectNoForce(t);
    // …409ed, and the winner was re-seeded ATOMICALLY: exactly one update
    // reached the connected client — no torn intermediate state.
    expect(relayedUpdates - updatesBeforeFlush).toBe(1);
    expect(textOf(doc)).toBe("external wins");
    expect(textOf(client)).toBe("external wins");
    expect(events).toEqual([{ type: "writeback-conflict", noteId: "n1", note: winner }]);

    // The machine converged on the winner's version: the next writeback
    // baselines against it and SUCCEEDS.
    editText(doc, " + recovered");
    await rec.flush("n1");
    expect(t.vault.updateCalls[1]?.payload.if_updated_at).toBe(winner.updatedAt as string);
    expect(t.vault.notes.get("n1")?.content).toBe("external wins + recovered");
    expect(t.store.get("ydoc/n1")?.dirty).toBe(false);
  });

  test("transient writeback failure → writeback-error event + capped-backoff retry", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const events = collectEvents(rec);
    const doc = await rec.load("n1");
    await startLive(rec, t, [t.vault.notes.get("n1") as Note]);

    t.vault.updateError = new Error("vault is having a bad time");
    editText(doc, "!");
    await until(() => t.vault.updateCalls.length === 1);
    await until(() => events.some((e) => e.type === "writeback-error"));
    expect(t.store.get("ydoc/n1")?.dirty).toBe(true); // nothing acked

    t.vault.updateError = null;
    await until(() => t.vault.updateCalls.length >= 2); // the retry lands
    await until(() => t.store.get("ydoc/n1")?.dirty === false);
    expect(t.vault.notes.get("n1")?.content).toBe("base!");
    expectNoForce(t);
  });

  test("serialize hook failure → hook-error event, no write, no auto-retry", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const broken: ReconcilerHooks = {
      ...textHooks,
      serialize() {
        throw new Error("author bug");
      },
    };
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: broken, debounceMs: 5 });
    const events = collectEvents(rec);
    const doc = await rec.load("n1");
    editText(doc, "!");
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: "hook-error", noteId: "n1", hook: "serialize" });
    await sleep(30); // deterministic failure: no retry loop
    expect(t.vault.updateCalls.length).toBe(0);
    expect(events.length).toBe(1);
  });
});

describe("the external-edit signal (SSE)", () => {
  test("start() subscribes on the working tag (expand exact) under the shutdown signal", async () => {
    const t = makeTestCtx();
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks });
    const sub = await startLive(rec, t, []);
    expect(sub.query).toEqual({ tag: "doc", expand: "exact" });
    expect(sub.opts.signal).toBe(t.controller.signal);
    expect(rec.live).toBe(true);
    expect(rec.tag).toBe("doc");
  });

  test("external edit WINS: unwritten local edits are dropped, doc re-seeded", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    editText(doc, " + unwritten local"); // dirty, debounce far away
    const winner = t.vault.externalEdit("n1", "external truth");
    sub.handlers.onUpsert(t.vault.notes.get("n1") as Note);

    await until(() => events.length === 1);
    expect(events[0]).toEqual({ type: "external-edit", noteId: "n1", note: winner });
    expect(textOf(doc)).toBe("external truth");
    expect(t.vault.updateCalls.length).toBe(0); // the dropped local edit never wrote back
    expect(t.store.get("ydoc/n1")?.dirty).toBe(false);
    expect(t.store.get("ydoc/n1")?.sourceVersion).toBe(winner.updatedAt as string);
  });

  test("own writeback echo is suppressed without a fetch or an event", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    editText(doc, "!");
    await until(() => t.vault.updateCalls.length === 1);
    await until(() => t.store.get("ydoc/n1")?.dirty === false);

    const fetchesBefore = t.vault.getNoteCalls;
    sub.handlers.onUpsert(t.vault.notes.get("n1") as Note); // the echo
    await sleep(30);
    expect(events).toEqual([]);
    expect(t.vault.getNoteCalls).toBe(fetchesBefore); // hint fast-path: no fetch
    expect(textOf(doc)).toBe("base!");
  });

  test("echo racing an in-flight writeback does not clobber (per-note queue ordering)", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    editText(doc, " + local");
    let release: () => void = () => undefined;
    t.vault.updateGate = new Promise<void>((r) => {
      release = r;
    });
    const flushing = rec.flush("n1");
    await until(() => t.vault.updateCalls.length === 1);

    // Vault committed; the SSE echo lands BEFORE our HTTP response returns.
    sub.handlers.onUpsert(t.vault.notes.get("n1") as Note);
    release();
    t.vault.updateGate = null;
    await flushing;
    await sleep(30); // let the queued check run after the writeback settles

    expect(events).toEqual([]); // the echo was recognized, nothing re-seeded
    expect(textOf(doc)).toBe("base + local"); // local edits intact
    expect(t.store.get("ydoc/n1")?.dirty).toBe(false);
    expectNoForce(t);
  });

  test("note removed → note-removed event, state dropped, tracking detached", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    sub.handlers.onRemove("n1");
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ type: "note-removed", noteId: "n1" });
    expect(t.store.get("ydoc/n1")).toBeNull();

    editText(doc, "ghost edit"); // detached: no writeback ever fires
    await sleep(30);
    expect(t.vault.updateCalls.length).toBe(0);
  });

  test("reconnect snapshot reconciles: changed notes re-seed, absent notes are removed", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "one");
    t.vault.noteFixture("n2", "two");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [
      t.vault.notes.get("n1") as Note,
      t.vault.notes.get("n2") as Note,
    ]);
    const doc1 = await rec.load("n1");
    await rec.load("n2");

    const winner = t.vault.externalEdit("n1", "one, edited elsewhere");
    t.vault.notes.delete("n2");
    deliverSnapshot(sub, [winner]); // the self-correcting reconnect snapshot

    await until(() => events.length === 2);
    expect(events).toContainEqual({ type: "external-edit", noteId: "n1", note: winner });
    expect(events).toContainEqual({ type: "note-removed", noteId: "n2" });
    expect(textOf(doc1)).toBe("one, edited elsewhere");
    expect(t.store.get("ydoc/n2")).toBeNull();
  });
});

describe("degraded stream (fail-closed)", () => {
  test("on drop, external state is unknown: revalidates before the next writeback", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    sub.handlers.onStatus?.("reconnecting");
    expect(rec.live).toBe(false);

    editText(doc, " + degraded edit");
    const fetchesBefore = t.vault.getNoteCalls;
    await rec.flush("n1");
    expect(t.vault.getNoteCalls).toBe(fetchesBefore + 1); // revalidated first
    expect(t.vault.updateCalls.length).toBe(1); // clean revalidation → the write proceeds
    expect(t.vault.notes.get("n1")?.content).toBe("base + degraded edit");
    expectNoForce(t);
  });

  test("revalidation catches an unseen external edit: it wins, nothing is written", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");

    sub.handlers.onStatus?.("reconnecting");
    editText(doc, " + doomed");
    const winner = t.vault.externalEdit("n1", "edited while blind");

    await rec.flush("n1");
    expect(t.vault.updateCalls.length).toBe(0); // never wrote blind
    expect(textOf(doc)).toBe("edited while blind");
    expect(events).toEqual([{ type: "external-edit", noteId: "n1", note: winner }]);
  });

  test("revalidation failure defers the writeback; the retry lands once the vault answers", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");
    sub.handlers.onStatus?.("reconnecting");

    t.vault.getNoteError = new Error("vault unreachable");
    editText(doc, "!");
    await rec.flush("n1");
    expect(t.vault.updateCalls.length).toBe(0); // deferred, not blind-written
    expect(t.logs.warns.some((w) => w.includes("writeback deferred"))).toBe(true);

    t.vault.getNoteError = null;
    await until(() => t.vault.updateCalls.length === 1); // capped-backoff retry
    expect(t.vault.notes.get("n1")?.content).toBe("base!");
    expectNoForce(t);
  });
});

describe("persistence over ctx.store (the SurfaceStateStore substrate)", () => {
  test("unload flushes + persists; reload restores without a vault fetch", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const doc = await rec.load("n1");
    editText(doc, " + kept");

    await rec.unload("n1");
    expect(t.vault.updateCalls.length).toBe(1); // unload flushed the pending edit
    const acked = t.vault.notes.get("n1")?.updatedAt as string;

    const fetchesBefore = t.vault.getNoteCalls;
    const reloaded = await rec.load("n1");
    expect(reloaded).not.toBe(doc); // a fresh instance…
    expect(textOf(reloaded)).toBe("base + kept"); // …restored from the snapshot
    expect(t.vault.getNoteCalls).toBe(fetchesBefore); // without a vault fetch

    editText(reloaded, "!");
    await rec.flush("n1");
    expect(t.vault.updateCalls[1]?.payload.if_updated_at).toBe(acked); // baseline survived the round-trip
    expectNoForce(t);
  });

  test("dirty crash recovery: a restored dirty snapshot resumes its writeback with the persisted baseline verbatim", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "old vault content");

    // A prior process crashed after persisting but before writing back.
    const crashed = new Y.Doc();
    crashed.getText("content").insert(0, "recovered local edit");
    t.store.put("ydoc/n1", Y.encodeStateAsUpdate(crashed), {
      sourceVersion: note.updatedAt as string,
      dirty: true,
    });

    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const doc = await rec.load("n1");
    expect(textOf(doc)).toBe("recovered local edit");

    await until(() => t.vault.updateCalls.length === 1); // resumed automatically
    expect(t.vault.updateCalls[0]?.payload.if_updated_at).toBe(note.updatedAt as string);
    expect(t.vault.notes.get("n1")?.content).toBe("recovered local edit");
    expectNoForce(t);
  });

  test("stop() flushes everything and unsubscribes", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const sub = await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    const doc = await rec.load("n1");
    editText(doc, " + final");

    await rec.stop();
    expect(sub.unsubscribed).toBe(true);
    expect(t.vault.updateCalls.length).toBe(1);
    expect(t.vault.notes.get("n1")?.content).toBe("base + final");
    expect(t.store.get("ydoc/n1")?.dirty).toBe(false);
    expectNoForce(t);
  });

  test("load() after stop() rejects loudly — no untracked observer entry", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    await startLive(rec, t, [t.vault.notes.get("n1") as Note]);
    await rec.stop();

    await expect(rec.load("n1")).rejects.toThrow(/reconciler is stopped/);
    // Nothing got registered: no doc state persisted, no vault fetch fired.
    expect(t.store.get("ydoc/n1")).toBeNull();
    expect(t.vault.updateCalls.length).toBe(0);
  });
});

describe("typed not-found normalization (#109)", () => {
  // The live vault client THROWS `VaultNotFoundError` for a deleted note —
  // it never resolves null. These tests pin that a thrown typed not-found
  // during reconciler ops lands in the deleted-note branches (note-removed,
  // tracking dropped) instead of crashing the machine or retrying forever
  // against a gone note. Deletion normally arrives via SSE removal; these
  // are the fetch paths racing it.

  test("external check racing a deletion → note-removed, tracking dropped, no crash", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [note]);
    await rec.load("n1");

    // The note is gone by the time the stream hint triggers our fetch —
    // the fake (faithful to the live client) THROWS the typed not-found.
    t.vault.notes.delete("n1");
    sub.handlers.onUpsert({ ...note, updatedAt: "v-phantom" });

    await until(() => events.length === 1);
    expect(events[0]).toEqual({ type: "note-removed", noteId: "n1" });
    expect(t.store.get("ydoc/n1")).toBeNull();
    expect(t.logs.warns.some((w) => w.includes("external check"))).toBe(false); // not the failure path
  });

  test("degraded revalidation against a deleted note → note-removed, never writes, never retries", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [note]);
    const doc = await rec.load("n1");

    sub.handlers.onStatus?.("reconnecting"); // degraded: revalidate-first
    editText(doc, " + doomed");
    t.vault.notes.delete("n1"); // deleted while blind

    await rec.flush("n1");
    expect(events).toEqual([{ type: "note-removed", noteId: "n1" }]);
    expect(t.vault.updateCalls.length).toBe(0); // never wrote against the gone note
    expect(t.store.get("ydoc/n1")).toBeNull();

    const fetchesAfter = t.vault.getNoteCalls;
    await sleep(30); // no deferred-writeback retry loop survives the removal
    expect(t.vault.getNoteCalls).toBe(fetchesAfter);
    expect(t.vault.updateCalls.length).toBe(0);
  });

  test("conflict-winner fetch hits a typed not-found → note-removed, no retry", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const events = collectEvents(rec);
    await startLive(rec, t, [note]);
    const doc = await rec.load("n1");

    editText(doc, " + stale");
    t.vault.externalEdit("n1", "bumped under us"); // the writeback will 409
    // The winner fetch then sees the note already gone (typed not-found).
    t.vault.getNoteError = new VaultNotFoundError("note n1 not found");

    await rec.flush("n1");
    expect(t.vault.updateCalls.length).toBe(1); // the 409ed attempt
    expect(events).toEqual([{ type: "note-removed", noteId: "n1" }]); // NOT writeback-error
    expect(t.store.get("ydoc/n1")).toBeNull();

    t.vault.getNoteError = null;
    await sleep(30); // removal is terminal: no backoff retry fires
    expect(t.vault.updateCalls.length).toBe(1);
  });

  test("a NON-not-found fetch failure still rides the degraded path (normalization is narrow)", async () => {
    const t = makeTestCtx();
    const note = t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 5 });
    const events = collectEvents(rec);
    const sub = await startLive(rec, t, [note]);
    const doc = await rec.load("n1");
    sub.handlers.onStatus?.("reconnecting");

    t.vault.getNoteError = new Error("vault unreachable");
    editText(doc, "!");
    await rec.flush("n1");
    expect(events).toEqual([]); // no spurious removal
    expect(t.logs.warns.some((w) => w.includes("writeback deferred"))).toBe(true);
    expect(t.store.get("ydoc/n1")).not.toBeNull(); // tracking intact, retry pending

    t.vault.getNoteError = null;
    await until(() => t.vault.updateCalls.length === 1); // the retry lands
    expect(t.vault.notes.get("n1")?.content).toBe("base!");
  });
});

describe("events + origins", () => {
  test("reconciler-origin transactions are observable as such by surface listeners", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const doc = await rec.load("n1");

    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    t.vault.externalEdit("n1", "rewritten");
    editText(doc, "x"); // a local (non-reconciler) edit
    // Not started → degraded → revalidation catches the external edit and
    // re-seeds (a reconciler-origin transaction).
    await rec.flush("n1");

    expect(origins).toEqual([null, RECONCILER_ORIGIN]);
  });

  test("a throwing event handler is contained; on() unsubscribe works", async () => {
    const t = makeTestCtx();
    t.vault.noteFixture("n1", "base");
    const rec = createVaultReconciler(t.ctx, { tag: "doc", hooks: textHooks, debounceMs: 60_000 });
    const seen: ReconcilerEvent[] = [];
    const off = rec.on(() => {
      throw new Error("listener bug");
    });
    rec.on((ev) => seen.push(ev));

    const doc = await rec.load("n1");
    editText(doc, "x");
    t.vault.externalEdit("n1", "winner");
    await rec.flush("n1"); // external-edit reseed → both handlers invoked

    expect(seen.length).toBe(1); // the second handler still ran
    expect(t.logs.warns.some((w) => w.includes("event handler threw"))).toBe(true);

    off();
    // (unsubscribing the throwing handler; no further warns on the next event)
    const warnsBefore = t.logs.warns.length;
    editText(doc, "y");
    t.vault.externalEdit("n1", "winner 2");
    await rec.flush("n1");
    expect(seen.length).toBe(2);
    expect(t.logs.warns.length).toBe(warnsBefore);
  });
});
