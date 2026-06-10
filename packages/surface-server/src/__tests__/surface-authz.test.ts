import { describe, expect, test } from "bun:test";
import { GrantStore } from "../authz/grant-store.ts";
import { createSurfaceAuthz } from "../authz/surface-authz.ts";
import type { Actor, Note } from "../types.ts";
import { ACTIONS, LEVEL_ACTIONS, grantMatchesNote, levelAllows } from "../types.ts";
import { deliverSnapshot, grantNote, makeTestCtx } from "./helpers.ts";

const OPERATOR: Actor = { kind: "operator", subject: "op", scopes: ["vault:default:write"] };
const ANON: Actor = { kind: "anon" };
const capActor = (capabilityId: string, subjectId: string | null = null): Actor => ({
  kind: "audience",
  sessionId: "s",
  capabilityId,
  subjectId,
});

function note(overrides: Partial<Note> = {}): Note {
  return { id: "n1", createdAt: "2026-06-10T00:00:00Z", ...overrides };
}

async function makeAuthz(grants: ReturnType<typeof grantNote>[]) {
  const t = makeTestCtx();
  const store = new GrantStore(t.ctx);
  const ready = store.start();
  deliverSnapshot(t.vault.subscriptions[0]!, grants);
  await ready;
  return { authz: createSurfaceAuthz(store), t };
}

describe("level→action table (design §6)", () => {
  test("the ladder is cumulative; manage_* is reachable from NO level", () => {
    expect(LEVEL_ACTIONS.view).toEqual(["read"]);
    expect(LEVEL_ACTIONS.comment).toEqual(["read", "comment"]);
    expect(LEVEL_ACTIONS.suggest).toEqual(["read", "comment", "suggest"]);
    expect(LEVEL_ACTIONS.edit).toEqual(["read", "comment", "suggest", "edit_content"]);
    for (const level of ["view", "comment", "suggest", "edit"] as const) {
      expect(levelAllows(level, "manage_grants")).toBe(false);
      expect(levelAllows(level, "manage_tags")).toBe(false);
      expect(levelAllows(level, "manage_path")).toBe(false);
    }
  });
});

describe("grantMatchesNote", () => {
  test("note grants match by id only", () => {
    const g = {
      id: "g",
      subject: "public",
      resourceType: "note" as const,
      resource: "n1",
      level: "view" as const,
      expiresAt: null,
    };
    expect(grantMatchesNote(g, note({ id: "n1" }))).toBe(true);
    expect(grantMatchesNote(g, note({ id: "n2" }))).toBe(false);
  });

  test("path grants are PREFIX-SEGMENT locked (docs/x ≠ docs/xy)", () => {
    const g = {
      id: "g",
      subject: "public",
      resourceType: "path" as const,
      resource: "docs/x",
      level: "view" as const,
      expiresAt: null,
    };
    expect(grantMatchesNote(g, note({ path: "docs/x" }))).toBe(true);
    expect(grantMatchesNote(g, note({ path: "docs/x/deep.md" }))).toBe(true);
    expect(grantMatchesNote(g, note({ path: "docs/xy" }))).toBe(false); // the classic prefix leak
    expect(grantMatchesNote(g, note({ path: "other/docs/x" }))).toBe(false);
    expect(grantMatchesNote(g, note({}))).toBe(false); // pathless note
  });

  test("tag grants require literal tag membership", () => {
    const g = {
      id: "g",
      subject: "public",
      resourceType: "tag" as const,
      resource: "meeting",
      level: "view" as const,
      expiresAt: null,
    };
    expect(grantMatchesNote(g, note({ tags: ["meeting", "x"] }))).toBe(true);
    expect(grantMatchesNote(g, note({ tags: ["meeting/sub"] }))).toBe(false); // namespace ≠ membership
    expect(grantMatchesNote(g, note({}))).toBe(false);
  });
});

describe("can(actor, note, action)", () => {
  test("operator: every action, grants never consulted", async () => {
    const { authz, t } = await makeAuthz([]);
    for (const action of ACTIONS) {
      expect(await authz.can(OPERATOR, note(), action)).toBe(true);
    }
    expect(t.vault.queryCalls).toBe(0);
  });

  test("anon sees nothing without a public grant", async () => {
    const { authz } = await makeAuthz([]);
    expect(await authz.can(ANON, note(), "read")).toBe(false);
  });

  test("anon reads what `public` grants — and only that action set", async () => {
    const { authz } = await makeAuthz([
      grantNote({
        id: "g",
        subjectType: "public",
        resourceType: "note",
        resource: "n1",
        level: "view",
      }),
    ]);
    expect(await authz.can(ANON, note(), "read")).toBe(true);
    expect(await authz.can(ANON, note(), "comment")).toBe(false);
    expect(await authz.can(ANON, note({ id: "n2" }), "read")).toBe(false);
  });

  test("audience: strongest matching grant wins (max-of-grants)", async () => {
    const { authz } = await makeAuthz([
      grantNote({
        id: "g1",
        subjectType: "capability",
        subject: "c1",
        resourceType: "tag",
        resource: "shared",
        level: "view",
      }),
      grantNote({
        id: "g2",
        subjectType: "subject",
        subject: "s1",
        resourceType: "tag",
        resource: "shared",
        level: "edit",
      }),
    ]);
    const target = note({ tags: ["shared"] });
    // Capability-only actor: view.
    expect(await authz.can(capActor("c1"), target, "read")).toBe(true);
    expect(await authz.can(capActor("c1"), target, "edit_content")).toBe(false);
    // Same capability bound to subject s1: edit wins.
    expect(await authz.can(capActor("c1", "s1"), target, "edit_content")).toBe(true);
  });

  test("audience: manage_* denied even at edit level (tags are the sharing scope)", async () => {
    const { authz } = await makeAuthz([
      grantNote({
        id: "g",
        subjectType: "capability",
        subject: "c1",
        resourceType: "note",
        resource: "n1",
        level: "edit",
      }),
    ]);
    const actor = capActor("c1");
    expect(await authz.can(actor, note(), "edit_content")).toBe(true);
    expect(await authz.can(actor, note(), "manage_tags")).toBe(false);
    expect(await authz.can(actor, note(), "manage_path")).toBe(false);
    expect(await authz.can(actor, note(), "manage_grants")).toBe(false);
  });

  test("levelFor returns the strongest level or null", async () => {
    const { authz } = await makeAuthz([
      grantNote({
        id: "g",
        subjectType: "capability",
        subject: "c1",
        resourceType: "note",
        resource: "n1",
        level: "suggest",
      }),
    ]);
    expect(await authz.levelFor(capActor("c1"), note())).toBe("suggest");
    expect(await authz.levelFor(capActor("other"), note())).toBeNull();
    expect(await authz.levelFor(OPERATOR, note())).toBeNull(); // actor-plane, not grant-plane
  });
});
