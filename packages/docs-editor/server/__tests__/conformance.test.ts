/**
 * The kit's PUBLIC gateway conformance suite (P8) wired against the docs
 * backend — anon-sees-nothing, deny-by-default, scoped-actor locks + leak
 * conditions, entry hygiene, and the cookie-mutation origin check. The
 * suite carries its own positive controls (an actor's `allowed` probes
 * must 2xx), so a vacuous pass fails loudly.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { gatewayConformanceCases } from "@openparachute/surface-server/conformance";
import { MOUNT, type MadeBackend, OPERATOR_JWT, ORIGIN, makeBackend, post } from "./helpers.ts";

const SECRET_A = "granted-doc-marker-alpha";
const SECRET_B = "ungranted-doc-marker-bravo";
const SECRET_C = "untagged-note-marker-charlie";

// The kit's cases are generated synchronously up front — build the backend
// and its fixtures at module load (woven-boulder's pattern).
const made: MadeBackend = await makeBackend();
made.vault.noteFixture("doc-a", `# Granted\n\n${SECRET_A}`);
made.vault.noteFixture("doc-b", `# Ungranted\n\n${SECRET_B}`);
// Outside the working tag: must be indistinguishable from missing on every
// note-kind read (the tag-scoped reconciler would silently drop its edits).
made.vault.noteFixture("note-out", `# Journal\n\n${SECRET_C}`, { tags: ["journal"] });

async function mintCap(level: string, noteId: string): Promise<string> {
  const res = await post(
    made.backend,
    "/api/shares",
    { noteId, level },
    { authorization: `Bearer ${OPERATOR_JWT}` },
  );
  if (res.status !== 201) throw new Error(`share mint failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

// One capability scoped view-on-doc-a (the locked actor), plus fresh
// capabilities for the entry-hygiene and cookie-mutation cases (each case
// consumes an exchange; cap tokens are multi-use so one would do, but
// fresh ones keep the cases independent).
const viewCapA = await mintCap("view", "doc-a");
const entryCap = await mintCap("view", "doc-a");

afterAll(async () => {
  await made.backend.shutdown?.();
  made.controller.abort();
});

describe("kit gateway conformance", () => {
  const cases = gatewayConformanceCases({
    fetch: (req) => made.backend.fetch(req),
    mount: MOUNT,
    origin: ORIGIN,
    protectedProbes: [
      { path: "/api/docs", mustNotContain: [SECRET_A, SECRET_B] },
      { path: "/api/doc/doc-a", mustNotContain: [SECRET_A] },
      { path: "/api/doc/doc-b", mustNotContain: [SECRET_B] },
      { path: "/api/doc/note-out", mustNotContain: [SECRET_C] },
      // Nonexistent id: anon must get a REFUSAL (401/403/404), never a 500
      // — the missing-note existence oracle the kit normalizes away.
      { path: "/api/doc/doc-ghost" },
      { method: "POST", path: "/api/collab/ticket" },
      { method: "POST", path: "/api/docs", body: { title: "x" } },
      { path: "/api/shares" },
      {
        method: "POST",
        path: "/api/shares",
        body: { noteId: "doc-a", level: "edit" },
      },
      { path: "/api/collab/status" },
    ],
    actors: [
      {
        // view-on-doc-a: reads its doc, leaks nothing else, can't mutate.
        authorization: `Capability ${viewCapA}`,
        allowed: [{ path: "/api/doc/doc-a" }, { path: "/api/docs" }],
        denied: [
          { path: "/api/doc/doc-b", mustNotContain: [SECRET_B] },
          { path: "/api/doc/note-out", mustNotContain: [SECRET_C] },
          { path: "/api/doc/doc-ghost" },
          { path: "/api/shares", mustNotContain: [SECRET_A, SECRET_B] },
          { method: "POST", path: "/api/docs", body: { title: "esc" } },
          {
            method: "POST",
            path: "/api/shares",
            body: { noteId: "doc-b", level: "edit" },
            mustNotContain: [SECRET_B],
          },
          { path: "/api/collab/status" },
        ],
      },
    ],
    entryToken: entryCap,
    cookieMutationProbe: { method: "POST", path: "/api/collab/ticket" },
  });

  for (const c of cases) {
    test(c.name, async () => {
      await c.run();
    });
  }
});

describe("operator branch", () => {
  test("an invalid bearer is a 401 refusal — never a downgrade to anon", async () => {
    const res = await made.backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/me`, {
        headers: { authorization: "Bearer forged" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("the operator bearer reaches operator routes", async () => {
    const res = await made.backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/collab/status`, {
        headers: { authorization: `Bearer ${OPERATOR_JWT}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});
