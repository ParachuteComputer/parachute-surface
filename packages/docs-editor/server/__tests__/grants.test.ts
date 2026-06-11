/**
 * Grant enforcement over the REST gateway: per-doc levels gate reads, the
 * doc list narrows to granted docs, operator routes refuse the audience,
 * deny-by-default 404s undeclared paths, and denied vs missing notes are
 * indistinguishable (no existence oracle).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type MadeBackend, OPERATOR_JWT, del, get, makeBackend, post } from "./helpers.ts";

let made: MadeBackend | null = null;

afterEach(async () => {
  if (made) {
    await made.backend.shutdown?.();
    made.controller.abort();
    made = null;
  }
});

const SECRET_A = "alpha-secret-marker";
const SECRET_B = "bravo-secret-marker";

async function setup(): Promise<{
  m: MadeBackend;
  capA: string; // view on doc-a only
}> {
  const m = await makeBackend();
  m.vault.noteFixture("doc-a", `# Doc A\n\n${SECRET_A}`);
  m.vault.noteFixture("doc-b", `# Doc B\n\n${SECRET_B}`);
  const res = await post(
    m.backend,
    "/api/shares",
    { noteId: "doc-a", level: "view" },
    { authorization: `Bearer ${OPERATOR_JWT}` },
  );
  expect(res.status).toBe(201);
  const { token } = (await res.json()) as { token: string };
  return { m, capA: token };
}

describe("grant enforcement", () => {
  test("operator sees every doc; the audience list narrows to granted docs", async () => {
    const { m, capA } = await setup();
    made = m;

    const opList = await get(m.backend, "/api/docs", {
      authorization: `Bearer ${OPERATOR_JWT}`,
    });
    expect(opList.status).toBe(200);
    const opDocs = ((await opList.json()) as { docs: { id: string; level: string }[] }).docs;
    expect(opDocs.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b"]);
    expect(opDocs.every((d) => d.level === "owner")).toBe(true);

    const audList = await get(m.backend, "/api/docs", {
      authorization: `Capability ${capA}`,
    });
    expect(audList.status).toBe(200);
    const audDocs = ((await audList.json()) as { docs: { id: string; level: string }[] }).docs;
    expect(audDocs).toEqual([expect.objectContaining({ id: "doc-a", level: "view" })]);
  });

  test("granted doc reads; ungranted doc and missing doc are the SAME 404", async () => {
    const { m, capA } = await setup();
    made = m;
    const auth = { authorization: `Capability ${capA}` };

    const granted = await get(m.backend, "/api/doc/doc-a", auth);
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as { content: string }).content).toContain(SECRET_A);

    const denied = await get(m.backend, "/api/doc/doc-b", auth);
    const missing = await get(m.backend, "/api/doc/doc-nope", auth);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });

  test("view level reports editable: false; an edit grant flips it", async () => {
    const { m, capA } = await setup();
    made = m;

    const viewRead = await get(m.backend, "/api/doc/doc-a", {
      authorization: `Capability ${capA}`,
    });
    expect(((await viewRead.json()) as { editable: boolean }).editable).toBe(false);

    const share = await post(
      m.backend,
      "/api/shares",
      { noteId: "doc-b", level: "edit" },
      { authorization: `Bearer ${OPERATOR_JWT}` },
    );
    const { token: capB } = (await share.json()) as { token: string };
    const editRead = await get(m.backend, "/api/doc/doc-b", {
      authorization: `Capability ${capB}`,
    });
    expect(((await editRead.json()) as { editable: boolean }).editable).toBe(true);
  });

  test("operator routes refuse the audience (403) and anon (401)", async () => {
    const { m, capA } = await setup();
    made = m;

    for (const probe of [
      () => post(m.backend, "/api/docs", { title: "x" }, { authorization: `Capability ${capA}` }),
      () => get(m.backend, "/api/shares", { authorization: `Capability ${capA}` }),
      () =>
        post(
          m.backend,
          "/api/shares",
          { noteId: "doc-a", level: "edit" },
          { authorization: `Capability ${capA}` },
        ),
      () => get(m.backend, "/api/collab/status", { authorization: `Capability ${capA}` }),
    ]) {
      const res = await probe();
      expect(res.status).toBe(403);
    }
    expect((await post(m.backend, "/api/docs", { title: "x" })).status).toBe(401);
  });

  test("revoking a share kills access immediately (capability + grant)", async () => {
    const { m, capA } = await setup();
    made = m;

    const shares = await get(m.backend, "/api/shares", {
      authorization: `Bearer ${OPERATOR_JWT}`,
    });
    const { grants } = (await shares.json()) as { grants: { id: string }[] };
    expect(grants).toHaveLength(1);
    const grantId = (grants[0] as { id: string }).id;

    const revoked = await del(m.backend, `/api/shares/${grantId}`, {
      authorization: `Bearer ${OPERATOR_JWT}`,
    });
    expect(revoked.status).toBe(200);

    // The capability itself is dead — presented-but-invalid is a 401
    // refusal, never a silent downgrade to anon.
    const after = await get(m.backend, "/api/doc/doc-a", {
      authorization: `Capability ${capA}`,
    });
    expect(after.status).toBe(401);
  });

  test("an expired grant stops matching (fail closed on time)", async () => {
    const m = await makeBackend();
    made = m;
    m.vault.noteFixture("doc-a", `# Doc A\n\n${SECRET_A}`);
    const res = await post(
      m.backend,
      "/api/shares",
      { noteId: "doc-a", level: "view", expiresAt: new Date(Date.now() - 1000).toISOString() },
      { authorization: `Bearer ${OPERATOR_JWT}` },
    );
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    // The capability record itself expired with the share → 401 refusal.
    const read = await get(m.backend, "/api/doc/doc-a", {
      authorization: `Capability ${token}`,
    });
    expect(read.status).toBe(401);
  });

  test("share minting refuses dangling targets and bad levels", async () => {
    const m = await makeBackend();
    made = m;
    m.vault.noteFixture("doc-a", "# A");
    const auth = { authorization: `Bearer ${OPERATOR_JWT}` };

    expect(
      (await post(m.backend, "/api/shares", { noteId: "doc-ghost", level: "view" }, auth)).status,
    ).toBe(404);
    expect(
      (await post(m.backend, "/api/shares", { noteId: "doc-a", level: "own" }, auth)).status,
    ).toBe(400);
    expect(
      (await post(m.backend, "/api/shares", { noteId: "doc-a", level: "admin" }, auth)).status,
    ).toBe(400);
  });

  test("share minting refuses notes OUTSIDE the working tag — same 404 as missing", async () => {
    // A grant on an out-of-scope note would invite collaborators into a
    // doc whose edits the tag-scoped reconciler watch silently discards
    // on its first snapshot. Untagged and missing are the SAME 404.
    const m = await makeBackend();
    made = m;
    m.vault.noteFixture("doc-in", "# In scope"); // working tag (positive control)
    m.vault.noteFixture("doc-out", "# Out of scope", { tags: ["journal"] });
    const auth = { authorization: `Bearer ${OPERATOR_JWT}` };

    const ok = await post(m.backend, "/api/shares", { noteId: "doc-in", level: "view" }, auth);
    expect(ok.status).toBe(201);

    const untagged = await post(
      m.backend,
      "/api/shares",
      { noteId: "doc-out", level: "view" },
      auth,
    );
    const missing = await post(
      m.backend,
      "/api/shares",
      { noteId: "doc-ghost", level: "view" },
      auth,
    );
    expect(untagged.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await untagged.text()).toBe(await missing.text());
  });

  test("deny-by-default: undeclared API paths 404; wrong method 405", async () => {
    const m = await makeBackend();
    made = m;
    expect((await get(m.backend, "/api/notes")).status).toBe(404);
    expect((await get(m.backend, "/api/admin")).status).toBe(404);
    expect((await post(m.backend, "/api/me", {})).status).toBe(405);
  });
});
