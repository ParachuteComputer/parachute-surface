import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DraftBody, bodyEquals, clearDraft, draftKey, loadDraft, saveDraft } from "./store";

const body = (over: Partial<DraftBody> = {}): DraftBody => ({
  content: "hello",
  path: "Notes/one",
  tags: ["a", "b"],
  ...over,
});

describe("draft store", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("keys per vault and scope", () => {
    expect(draftKey("v1", "new")).toBe("notes:draft:v1:new");
    expect(draftKey("v2", "note-9")).toBe("notes:draft:v2:note-9");
  });

  it("round-trips a body with a savedAt stamp", () => {
    saveDraft("v1", "new", body());
    const loaded = loadDraft("v1", "new");
    expect(loaded?.body).toEqual(body());
    expect(typeof loaded?.savedAt).toBe("string");
    expect(Number.isNaN(Date.parse(loaded?.savedAt ?? ""))).toBe(false);
  });

  it("returns null when nothing is stored", () => {
    expect(loadDraft("v1", "new")).toBeNull();
  });

  it("isolates drafts per vault and per scope", () => {
    saveDraft("v1", "new", body({ content: "v1-new" }));
    saveDraft("v1", "note-1", body({ content: "v1-note" }));
    expect(loadDraft("v2", "new")).toBeNull();
    expect(loadDraft("v1", "note-1")?.body.content).toBe("v1-note");
    expect(loadDraft("v1", "new")?.body.content).toBe("v1-new");
  });

  it("clears a draft", () => {
    saveDraft("v1", "new", body());
    clearDraft("v1", "new");
    expect(loadDraft("v1", "new")).toBeNull();
  });

  it("survives a corrupt blob or a wrong-shape body", () => {
    localStorage.setItem(draftKey("v1", "new"), "{not json");
    expect(loadDraft("v1", "new")).toBeNull();
    localStorage.setItem(draftKey("v1", "new"), JSON.stringify({ body: { content: 5 } }));
    expect(loadDraft("v1", "new")).toBeNull();
  });

  describe("bodyEquals", () => {
    it("is true for identical bodies and tag-order-insensitive", () => {
      expect(bodyEquals(body(), body())).toBe(true);
      expect(bodyEquals(body({ tags: ["a", "b"] }), body({ tags: ["b", "a"] }))).toBe(true);
    });
    it("is false when content, path, or tag set differs", () => {
      expect(bodyEquals(body(), body({ content: "x" }))).toBe(false);
      expect(bodyEquals(body(), body({ path: "x" }))).toBe(false);
      expect(bodyEquals(body(), body({ tags: ["a"] }))).toBe(false);
    });
  });
});
