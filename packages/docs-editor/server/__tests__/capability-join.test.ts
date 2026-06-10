/**
 * The capability-link JOIN flow, browser-shaped (design §4 transport):
 * entry URL → verify → link-session → httpOnly path-scoped cookie → clean
 * 302 — then the cookie IS the audience identity for docs, tickets, and
 * the origin-checked mutations. Personal links exchange single-use.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  MOUNT,
  type MadeBackend,
  OPERATOR_JWT,
  ORIGIN,
  get,
  makeBackend,
  post,
} from "./helpers.ts";

let made: MadeBackend | null = null;

afterEach(async () => {
  if (made) {
    await made.backend.shutdown?.();
    made.controller.abort();
    made = null;
  }
});

async function mintShare(
  m: MadeBackend,
  body: Record<string, unknown>,
): Promise<{ entryPath: string; token?: string; delivered?: boolean }> {
  const res = await post(m.backend, "/api/shares", body, {
    authorization: `Bearer ${OPERATOR_JWT}`,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { entryPath: string; token?: string };
}

/** Follow the entry URL like a browser; return the session cookie pair. */
async function joinViaEntry(m: MadeBackend, entryPath: string): Promise<string> {
  const res = await m.backend.fetch(new Request(`${ORIGIN}${entryPath}`));
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location).toBe(`${MOUNT}/`); // clean URL — no token residue
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain(`Path=${MOUNT}/`);
  const pair = setCookie.split(";")[0] ?? "";
  expect(pair.length).toBeGreaterThan(0);
  return pair;
}

describe("capability-link join", () => {
  test("invitee joins via entry URL and works through the cookie session", async () => {
    const m = await makeBackend();
    made = m;
    m.vault.noteFixture("doc-j", "# Joinable\n\nshared body");
    const share = await mintShare(m, { noteId: "doc-j", level: "edit" });

    const cookie = await joinViaEntry(m, share.entryPath);

    // /api/me sees an audience link session.
    const me = await get(m.backend, "/api/me", { cookie });
    expect(await me.json()).toEqual({ kind: "audience", subject: "link" });

    // The granted doc lists and reads through the cookie.
    const list = await get(m.backend, "/api/docs", { cookie });
    const { docs } = (await list.json()) as { docs: { id: string }[] };
    expect(docs.map((d) => d.id)).toEqual(["doc-j"]);
    const read = await get(m.backend, "/api/doc/doc-j", { cookie });
    expect(read.status).toBe(200);

    // Cookie-authenticated mutations require a same-origin Origin header
    // (CSRF posture) — then succeed with one.
    const noOrigin = await post(m.backend, "/api/collab/ticket", {}, { cookie });
    expect(noOrigin.status).toBe(403);
    const crossOrigin = await post(
      m.backend,
      "/api/collab/ticket",
      {},
      {
        cookie,
        origin: "https://evil.example",
      },
    );
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await post(
      m.backend,
      "/api/collab/ticket",
      {},
      {
        cookie,
        origin: ORIGIN,
      },
    );
    expect(sameOrigin.status).toBe(200);
    const { ticket } = (await sameOrigin.json()) as { ticket: string };
    expect(ticket.startsWith("tkt_")).toBe(true);
  });

  test("a capability entry link is multi-use (anyone with the link)", async () => {
    const m = await makeBackend();
    made = m;
    m.vault.noteFixture("doc-j", "# J");
    const share = await mintShare(m, { noteId: "doc-j", level: "view" });

    const first = await joinViaEntry(m, share.entryPath);
    const second = await joinViaEntry(m, share.entryPath);
    expect(first).not.toBe(second); // distinct sessions
    for (const cookie of [first, second]) {
      const read = await get(m.backend, "/api/doc/doc-j", { cookie });
      expect(read.status).toBe(200);
    }
  });

  test("a personal link is SINGLE-use; re-exchange is refused", async () => {
    const m = await makeBackend();
    made = m;
    m.vault.noteFixture("doc-j", "# J");
    const share = await mintShare(m, {
      noteId: "doc-j",
      level: "comment",
      email: "invitee@example.com",
    });
    // No email sender configured → the link renders inline for copy-paste.
    expect(share.delivered).toBe(false);

    const cookie = await joinViaEntry(m, share.entryPath);
    const me = await get(m.backend, "/api/me", { cookie });
    expect(await me.json()).toEqual({ kind: "audience", subject: "personal" });

    // Second exchange of the same single-use link: refused.
    const replay = await m.backend.fetch(new Request(`${ORIGIN}${share.entryPath}`));
    expect(replay.status).toBe(401);
  });

  test("garbage and truncated entry tokens are refused uniformly", async () => {
    const m = await makeBackend();
    made = m;
    const garbage = await m.backend.fetch(new Request(`${ORIGIN}${MOUNT}/api/a/cap_garbage.nope`));
    const truncated = await m.backend.fetch(new Request(`${ORIGIN}${MOUNT}/api/a/cap_x`));
    expect(garbage.status).toBe(401);
    expect(truncated.status).toBe(401);
    expect(await garbage.text()).toBe(await truncated.text());
  });

  test("a dead cookie degrades to anon (UI can offer re-entry), never 500s", async () => {
    const m = await makeBackend();
    made = m;
    const me = await get(m.backend, "/api/me", { cookie: "surface_session=long-gone" });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ kind: "anon" });
  });
});
