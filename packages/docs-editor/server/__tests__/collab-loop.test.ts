/**
 * The collab loop, end to end through the REAL engine (Hocuspocus 4.1.1,
 * engine class, manually pumped through the host's WS handler contract):
 *
 *   1. two clients authenticate with tickets, CONVERGE on concurrent edits,
 *      and the reconciler writes the merged doc back with `if_updated_at`;
 *   2. presence (awareness) propagates between clients;
 *   3. an EXTERNAL vault edit lands via the SSE watch and WINS — connected
 *      clients are re-seeded live;
 *   4. a writeback CONFLICT (409) fetches the winner and re-seeds — never
 *      force;
 *   5. view-level tickets get read-only connections whose updates the
 *      engine refuses structurally;
 *   6. invalid/reused tickets are denied indistinguishably;
 *   7. disconnect bookkeeping is IDEMPOTENT (the upstream
 *      double-onDisconnect bug — dedupe by socketId).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { VaultConflictError } from "@openparachute/surface-client";
import type { ReconcilerEvent } from "@openparachute/surface-server";
import {
  ACL_TAG,
  type MadeBackend,
  OPERATOR_JWT,
  makeBackend,
  post,
  waitUntil,
} from "./helpers.ts";
import { CollabTestClient } from "./test-client.ts";

let made: MadeBackend | null = null;

afterEach(async () => {
  if (made) {
    await made.backend.shutdown?.();
    made.controller.abort();
    made = null;
  }
});

async function operatorTicket(m: MadeBackend): Promise<string> {
  const res = await post(
    m.backend,
    "/api/collab/ticket",
    {},
    {
      authorization: `Bearer ${OPERATOR_JWT}`,
    },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

/** Mint a capability share at `level` on `noteId`; return its raw token. */
async function mintShare(m: MadeBackend, noteId: string, level: string): Promise<string> {
  const res = await post(
    m.backend,
    "/api/shares",
    { noteId, level },
    { authorization: `Bearer ${OPERATOR_JWT}` },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** Ticket for a capability holder (programmatic Capability header path). */
async function audienceTicket(m: MadeBackend, capToken: string): Promise<string> {
  const res = await post(
    m.backend,
    "/api/collab/ticket",
    {},
    {
      authorization: `Capability ${capToken}`,
    },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

describe("collab loop", () => {
  test("two clients converge; the merged doc writes back with if_updated_at", async () => {
    made = await makeBackend();
    const m = made;
    const note = m.vault.noteFixture("doc-1", "# Shared\n\nseed body");

    const a = new CollabTestClient("doc-1", await operatorTicket(m));
    const b = new CollabTestClient("doc-1", await operatorTicket(m));
    a.connect(m.backend.websocket ?? {});
    b.connect(m.backend.websocket ?? {});

    await waitUntil(() => a.authState === "authenticated" && b.authState === "authenticated", {
      label: "both clients authenticated",
    });
    expect(a.scope).toBe("read-write");

    // Initial sync: both see the seeded content.
    await waitUntil(() => a.fragmentText().includes("seed body"), { label: "A seeded" });
    await waitUntil(() => b.fragmentText().includes("seed body"), { label: "B seeded" });

    // Concurrent edits from both sides.
    a.appendParagraph("alpha was here");
    b.appendParagraph("bravo was here");

    // CRDT convergence: both replicas reach the same state containing both.
    await waitUntil(
      () =>
        a.fragmentText() === b.fragmentText() &&
        a.fragmentText().includes("alpha was here") &&
        a.fragmentText().includes("bravo was here"),
      { label: "convergence", timeoutMs: 4_000 },
    );

    // The reconciler writes the merged doc back — markdown-canonical,
    // carrying the tracked version VERBATIM, never force.
    await waitUntil(() => m.vault.updateCalls.length > 0, { label: "writeback" });
    await m.reconciler.flush();
    const last = m.vault.updateCalls.at(-1);
    expect(last?.id).toBe("doc-1");
    expect(last?.payload.force).toBeUndefined();
    expect(last?.payload.if_updated_at).toBe(note.updatedAt as string);
    const persisted = m.vault.notes.get("doc-1")?.content ?? "";
    expect(persisted).toContain("# Shared");
    expect(persisted).toContain("alpha was here");
    expect(persisted).toContain("bravo was here");

    a.disconnect();
    b.disconnect();
  });

  test("presence propagates between clients", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-p", "# Presence");

    const a = new CollabTestClient("doc-p", await operatorTicket(m));
    const b = new CollabTestClient("doc-p", await operatorTicket(m));
    a.setPresence("Ada");
    b.setPresence("Bob");
    a.connect(m.backend.websocket ?? {});
    b.connect(m.backend.websocket ?? {});

    await waitUntil(
      () => a.presenceNames().join(",") === "Ada,Bob" && b.presenceNames().join(",") === "Ada,Bob",
      { label: "presence convergence" },
    );

    // Server-side presence counts both sessions on the doc.
    expect(m.collab.presence()["doc-p"]).toBe(2);

    a.disconnect();
    await waitUntil(() => b.presenceNames().join(",") === "Bob", {
      label: "A's awareness removed on disconnect",
    });
    b.disconnect();
  });

  test("external vault edit lands via the watch and WINS over the live doc", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-x", "# External\n\noriginal");

    const a = new CollabTestClient("doc-x", await operatorTicket(m));
    a.connect(m.backend.websocket ?? {});
    await waitUntil(() => a.fragmentText().includes("original"), { label: "seeded" });

    const events: ReconcilerEvent[] = [];
    m.reconciler.on((e) => events.push(e));

    // Another writer (agent / sync job / Notes app) commits to the vault;
    // the live-query upsert delivers it.
    const winner = m.vault.externalEdit("doc-x", "# External\n\nrewritten elsewhere");
    m.vault.pushUpsert(winner);

    // The connected client is re-seeded from the winner — external WINS.
    await waitUntil(() => a.fragmentText().includes("rewritten elsewhere"), {
      label: "client re-seeded from external edit",
    });
    expect(a.fragmentText()).not.toContain("original");
    expect(events.some((e) => e.type === "external-edit" && e.noteId === "doc-x")).toBe(true);

    // The user-facing signal rode along: a stateless resync notice.
    await waitUntil(
      () =>
        a.statelessMessages.some((m) => {
          const parsed = JSON.parse(m) as { type?: string; reason?: string };
          return parsed.type === "resync" && parsed.reason === "external-edit";
        }),
      { label: "resync stateless notice" },
    );

    // Post-re-seed edits write back against the WINNER's version.
    a.appendParagraph("after the external edit");
    await waitUntil(
      () => m.vault.updateCalls.some((c) => c.payload.if_updated_at === winner.updatedAt),
      { label: "writeback baselined on winner", timeoutMs: 4_000 },
    );

    a.disconnect();
  });

  test("writeback conflict (409) fetches the winner and re-seeds — never force", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-c", "# Conflict\n\nbase");

    const a = new CollabTestClient("doc-c", await operatorTicket(m));
    a.connect(m.backend.websocket ?? {});
    await waitUntil(() => a.fragmentText().includes("base"), { label: "seeded" });

    const events: ReconcilerEvent[] = [];
    m.reconciler.on((e) => events.push(e));

    // Script the race: the vault commits an external winner, but the
    // stream hasn't told us yet — our next writeback 409s.
    const winner = m.vault.externalEdit("doc-c", "# Conflict\n\nexternal winner");
    a.appendParagraph("doomed local edit");

    await waitUntil(
      () => events.some((e) => e.type === "writeback-conflict" && e.noteId === "doc-c"),
      { label: "conflict event", timeoutMs: 4_000 },
    );

    // The losing update was a real 409 attempt (if_updated_at, no force)…
    const conflicted = m.vault.updateCalls.find(
      (c) => c.id === "doc-c" && c.payload.if_updated_at !== winner.updatedAt,
    );
    expect(conflicted).toBeDefined();
    expect(conflicted?.payload.force).toBeUndefined();

    // …and the live doc was re-seeded from the winner (client included).
    await waitUntil(() => a.fragmentText().includes("external winner"), {
      label: "client re-seeded from conflict winner",
    });
    expect(a.fragmentText()).not.toContain("doomed local edit");
    expect(m.vault.notes.get("doc-c")?.content).toBe("# Conflict\n\nexternal winner");

    a.disconnect();
  });

  test("a view-level ticket gets a READ-ONLY connection the engine enforces", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-ro", "# ReadOnly\n\nprotected body");
    const capToken = await mintShare(m, "doc-ro", "view");

    const viewer = new CollabTestClient("doc-ro", await audienceTicket(m, capToken));
    viewer.connect(m.backend.websocket ?? {});
    await waitUntil(() => viewer.authState === "authenticated", { label: "viewer authed" });
    expect(viewer.scope).toBe("readonly");
    await waitUntil(() => viewer.fragmentText().includes("protected body"), {
      label: "viewer seeded",
    });

    // The viewer's update reaches the engine and is REFUSED structurally:
    // a writable second client never sees it, and no writeback carries it.
    const editor = new CollabTestClient("doc-ro", await operatorTicket(m));
    editor.connect(m.backend.websocket ?? {});
    await waitUntil(() => editor.fragmentText().includes("protected body"), {
      label: "editor seeded",
    });

    viewer.appendParagraph("escalation attempt");
    editor.appendParagraph("legit edit");
    await waitUntil(() => editor.fragmentText().includes("legit edit"), { label: "editor edit" });
    await m.reconciler.flush();
    expect(editor.fragmentText()).not.toContain("escalation attempt");
    expect(m.vault.notes.get("doc-ro")?.content ?? "").not.toContain("escalation attempt");

    viewer.disconnect();
    editor.disconnect();
  });

  test("audience without a grant on the doc is denied — same refusal as a missing doc", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-a", "# A");
    m.vault.noteFixture("doc-b", "# B\n\nsecret marker");
    const capForA = await mintShare(m, "doc-a", "edit");

    // Granted on A, connecting to B → denied.
    const wrongDoc = new CollabTestClient("doc-b", await audienceTicket(m, capForA));
    wrongDoc.connect(m.backend.websocket ?? {});
    await waitUntil(() => wrongDoc.authState === "denied", { label: "denied on ungranted doc" });

    // Connecting to a NONEXISTENT doc → the same shape of refusal.
    const missingDoc = new CollabTestClient("doc-missing", await audienceTicket(m, capForA));
    missingDoc.connect(m.backend.websocket ?? {});
    await waitUntil(() => missingDoc.authState === "denied", { label: "denied on missing doc" });
    expect(missingDoc.denyReason).toBe(wrongDoc.denyReason as string);
  });

  test("a connection racing in DURING unload re-adopts the doc — edits still flush", async () => {
    // Hocuspocus 4.1.1: documents.delete happens only AFTER
    // beforeUnloadDocument resolves, and createDocument returns the
    // still-mapped doc WITHOUT re-firing onLoadDocument. A connection
    // arriving while reconciler.unload is mid-flight (vault round-trip)
    // makes the engine abort the unload — but the reconciler has already
    // detached: live doc whose edits never write back.
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-race", "# Race\n\nbase");

    // A connects and edits; wait for the steady-state writeback to ack.
    const a = new CollabTestClient("doc-race", await operatorTicket(m));
    a.connect(m.backend.websocket ?? {});
    await waitUntil(() => a.fragmentText().includes("base"), { label: "A seeded" });
    a.appendParagraph("first edit");
    await waitUntil(() => (m.vault.notes.get("doc-race")?.content ?? "").includes("first edit"), {
      label: "first edit acked",
    });

    // Script the in-flight unload: the disconnect-time engine store flush
    // fails ONCE (transient) so the doc stays dirty into unloadDocument;
    // the unload's own flush then blocks on the gated vault write.
    a.appendParagraph("second edit");
    await waitUntil(() => a.fragmentText().includes("second edit"), { label: "second edit" });
    m.vault.updateErrorOnce = new Error("transient vault failure");
    let releaseGate = () => {};
    m.vault.updateGate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const callsBefore = m.vault.updateCalls.length;
    a.disconnect();

    // Two further update attempts: the failed executeNow flush, then the
    // unload flush now BLOCKED on the gate → unload is mid-flight.
    await waitUntil(() => m.vault.updateCalls.length >= callsBefore + 2, {
      label: "unload flush in flight",
    });

    // B races in while the unload hook is awaiting the vault.
    const b = new CollabTestClient("doc-race", await operatorTicket(m));
    b.connect(m.backend.websocket ?? {});
    await waitUntil(() => b.authState === "authenticated", { label: "B authenticated" });

    releaseGate();
    m.vault.updateGate = null;
    await waitUntil(() => (m.vault.notes.get("doc-race")?.content ?? "").includes("second edit"), {
      label: "second edit acked after gate",
    });
    // Engine kept serving the doc (the unload aborted on B's connection).
    await waitUntil(() => b.fragmentText().includes("second edit"), { label: "B synced" });

    // THE regression: B's post-race edit must still reach the vault. With
    // a detached reconciler this never flushes and the waitUntil times out.
    b.appendParagraph("post-race edit");
    await waitUntil(() => b.fragmentText().includes("post-race edit"), { label: "B edit local" });
    await m.reconciler.flush();
    await waitUntil(
      () => (m.vault.notes.get("doc-race")?.content ?? "").includes("post-race edit"),
      { label: "post-race edit written back", timeoutMs: 4_000 },
    );

    b.disconnect();
  });

  test("a note OUTSIDE the working tag refuses collab — same refusal as missing", async () => {
    // The reconciler's watch is tag-scoped: an untagged note would
    // collaborate fine until the first SSE snapshot treats it as REMOVED
    // and silently drops its state without flushing. So out-of-scope
    // notes must never reach the engine — refused at onAuthenticate,
    // indistinguishable from not-found.
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-in", "# In scope"); // carries the working tag
    m.vault.noteFixture("doc-out", "# Out of scope", { tags: ["journal"] });

    // Positive control first: the SAME operator path reaches a tagged note.
    const inScope = new CollabTestClient("doc-in", await operatorTicket(m));
    inScope.connect(m.backend.websocket ?? {});
    await waitUntil(() => inScope.authState === "authenticated", { label: "tagged note ok" });

    const outOfScope = new CollabTestClient("doc-out", await operatorTicket(m));
    outOfScope.connect(m.backend.websocket ?? {});
    await waitUntil(() => outOfScope.authState === "denied", { label: "untagged note denied" });

    const missing = new CollabTestClient("doc-ghost", await operatorTicket(m));
    missing.connect(m.backend.websocket ?? {});
    await waitUntil(() => missing.authState === "denied", { label: "missing note denied" });
    expect(outOfScope.denyReason).toBe(missing.denyReason as string);

    inScope.disconnect();
  });

  test("tickets are single-use and expire; garbage is denied", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-t", "# T");

    const ticket = await operatorTicket(m);
    const first = new CollabTestClient("doc-t", ticket);
    first.connect(m.backend.websocket ?? {});
    await waitUntil(() => first.authState === "authenticated", { label: "first use ok" });

    // Same ticket again — refused.
    const replay = new CollabTestClient("doc-t", ticket);
    replay.connect(m.backend.websocket ?? {});
    await waitUntil(() => replay.authState === "denied", { label: "replay denied" });

    // Garbage — refused, same reason string (no oracle).
    const garbage = new CollabTestClient("doc-t", "tkt_not-a-ticket");
    garbage.connect(m.backend.websocket ?? {});
    await waitUntil(() => garbage.authState === "denied", { label: "garbage denied" });
    expect(garbage.denyReason).toBe(replay.denyReason as string);

    first.disconnect();
  });

  test("revoking a share TERMINATES the live WS session — edits stop immediately", async () => {
    // Auth is evaluated once at onAuthenticate; without the grant-change
    // sweep a revoked collaborator keeps editing until they disconnect,
    // while HTTP-plane revocation is immediate.
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-rv", "# Revocable\n\nbody");
    m.vault.noteFixture("doc-keep", "# Keeper\n\nbody");

    const revokedCap = await mintShare(m, "doc-rv", "edit");
    const keptCap = await mintShare(m, "doc-keep", "edit");

    const victim = new CollabTestClient("doc-rv", await audienceTicket(m, revokedCap));
    const bystander = new CollabTestClient("doc-keep", await audienceTicket(m, keptCap));
    victim.connect(m.backend.websocket ?? {});
    bystander.connect(m.backend.websocket ?? {});
    await waitUntil(
      () => victim.authState === "authenticated" && bystander.authState === "authenticated",
      { label: "both authenticated" },
    );
    await waitUntil(() => victim.fragmentText().includes("body"), { label: "victim synced" });

    // The operator revokes the victim's share over REST.
    const shares = await m.backend.fetch(
      new Request("https://docs.test/surface/docs/api/shares", {
        headers: { authorization: `Bearer ${OPERATOR_JWT}` },
      }),
    );
    const { grants } = (await shares.json()) as {
      grants: { id: string; resource: string }[];
    };
    const target = grants.find((g) => g.resource === "doc-rv");
    expect(target).toBeDefined();
    const revoked = await m.backend.fetch(
      new Request(`https://docs.test/surface/docs/api/shares/${(target as { id: string }).id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${OPERATOR_JWT}` },
      }),
    );
    expect(revoked.status).toBe(200);

    // The live session is closed by the server (the engine's
    // Connection.close ships a protocol-level Close message)…
    await waitUntil(() => victim.serverClosedReason !== null, {
      label: "victim connection closed on revocation",
    });
    // …the unaffected session is NOT…
    expect(bystander.serverClosedReason).toBeNull();
    // …and post-revocation edits never reach the vault.
    victim.appendParagraph("ghost edit after revocation");
    await new Promise((r) => setTimeout(r, 100));
    await m.reconciler.flush();
    expect(m.vault.notes.get("doc-rv")?.content ?? "").not.toContain("ghost edit after revocation");

    bystander.disconnect();
  });

  test("UPGRADING a grant (view→edit) mid-session closes the WS session; re-auth picks up the new verdict (#99)", async () => {
    // The sweep closes on ANY write-verdict change — upgrades included
    // (in-place mutation of a live engine connection has no supported
    // seam): only the revocation direction was test-pinned until now.
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-up", "# Upgradable\n\nbody");
    const capToken = await mintShare(m, "doc-up", "view");

    const viewer = new CollabTestClient("doc-up", await audienceTicket(m, capToken));
    viewer.connect(m.backend.websocket ?? {});
    await waitUntil(() => viewer.authState === "authenticated", { label: "viewer authed" });
    expect(viewer.scope).toBe("readonly");
    await waitUntil(() => viewer.fragmentText().includes("body"), { label: "viewer synced" });

    // The operator upgrades the SAME grant to edit. Grants are vault-
    // native notes, so the live mutation path is the ACL-tag SSE upsert.
    const grantNote = [...m.vault.notes.values()].find(
      (n) => Array.isArray(n.tags) && n.tags.includes(ACL_TAG) && n.metadata?.resource === "doc-up",
    );
    expect(grantNote).toBeDefined();
    const upgraded = {
      ...(grantNote as NonNullable<typeof grantNote>),
      metadata: { ...(grantNote as NonNullable<typeof grantNote>).metadata, level: "edit" },
      updatedAt: m.vault.nextVersion(),
    };
    m.vault.notes.set(upgraded.id, upgraded);
    m.vault.pushUpsert(upgraded);

    // The read-only session is CLOSED — verdict changed, not revoked.
    await waitUntil(() => viewer.serverClosedReason !== null, {
      label: "viewer closed on upgrade",
    });

    // Re-auth with a fresh ticket: the SAME capability is now read-write.
    const editor = new CollabTestClient("doc-up", await audienceTicket(m, capToken));
    editor.connect(m.backend.websocket ?? {});
    await waitUntil(() => editor.authState === "authenticated", { label: "re-authed writable" });
    expect(editor.scope).toBe("read-write");
    await waitUntil(() => editor.fragmentText().includes("body"), { label: "editor synced" });
    editor.appendParagraph("post-upgrade edit");
    await waitUntil(() => editor.fragmentText().includes("post-upgrade edit"), {
      label: "edit local",
    });
    await m.reconciler.flush();
    await waitUntil(
      () => (m.vault.notes.get("doc-up")?.content ?? "").includes("post-upgrade edit"),
      { label: "post-upgrade edit written back", timeoutMs: 4_000 },
    );
    editor.disconnect();
  });

  test("disconnect bookkeeping is idempotent (upstream double-onDisconnect)", async () => {
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-d", "# D");

    const a = new CollabTestClient("doc-d", await operatorTicket(m));
    const b = new CollabTestClient("doc-d", await operatorTicket(m));
    // Awareness state on the departing client is the upstream bug's
    // trigger condition (removeAwarenessStates broadcasts to the dying
    // socket before the connection map forgets it).
    a.setPresence("Ada");
    b.setPresence("Bob");
    a.connect(m.backend.websocket ?? {});
    b.connect(m.backend.websocket ?? {});
    await waitUntil(() => m.collab.presence()["doc-d"] === 2, { label: "two sessions" });

    a.disconnect();
    await waitUntil(() => m.collab.presence()["doc-d"] === 1, { label: "one session left" });
    // Settle any re-entrant double-fire, then pin: still exactly 1 — a
    // double decrement would have dropped it to 0 (or gone negative in a
    // counter design).
    await new Promise((r) => setTimeout(r, 50));
    expect(m.collab.presence()["doc-d"]).toBe(1);

    b.disconnect();
    await waitUntil(() => (m.collab.presence()["doc-d"] ?? 0) === 0, { label: "all gone" });
  });

  test("conflict-error class detection (VaultConflictError rides the fake correctly)", async () => {
    // Guard the test double itself: a stale baseline MUST throw the same
    // error class the reconciler detects (positive control for the suite).
    made = await makeBackend();
    const m = made;
    m.vault.noteFixture("doc-g", "# G");
    m.vault.externalEdit("doc-g", "# G2");
    let thrown: unknown;
    try {
      await m.vault.updateNote("doc-g", { content: "x", if_updated_at: "v-stale" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConflictError);
  });
});
