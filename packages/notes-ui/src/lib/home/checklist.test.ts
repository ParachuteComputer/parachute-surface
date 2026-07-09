import type { Note } from "@/lib/vault/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HomeChecklistState,
  deriveSteps,
  hasUserAuthoredNote,
  loadChecklistState,
  saveChecklistState,
  stepsComplete,
} from "./checklist";

const mk = (over: Partial<Note>): Note => ({
  id: over.id ?? "n",
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
  ...over,
});

describe("checklist persistence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("returns a clean default when nothing is stored", () => {
    expect(loadChecklistState("v1")).toEqual({ dismissed: false, overrides: {} });
  });

  it("round-trips dismissed + overrides through localStorage", () => {
    const state: HomeChecklistState = { dismissed: true, overrides: { connect: true } };
    saveChecklistState("v1", state);
    expect(loadChecklistState("v1")).toEqual(state);
  });

  it("keys per vault — one vault's state doesn't leak into another", () => {
    saveChecklistState("v1", { dismissed: true, overrides: { import: true } });
    expect(loadChecklistState("v2")).toEqual({ dismissed: false, overrides: {} });
  });

  it("ignores unknown step ids and non-boolean values in a stored blob", () => {
    localStorage.setItem(
      "notes:home-checklist:v1",
      JSON.stringify({ dismissed: "yes", overrides: { connect: true, bogus: 1, write: "x" } }),
    );
    // dismissed only true for a literal boolean; overrides filtered to known
    // boolean-valued steps.
    expect(loadChecklistState("v1")).toEqual({ dismissed: false, overrides: { connect: true } });
  });

  it("survives a corrupt JSON blob", () => {
    localStorage.setItem("notes:home-checklist:v1", "{not json");
    expect(loadChecklistState("v1")).toEqual({ dismissed: false, overrides: {} });
  });
});

describe("hasUserAuthoredNote", () => {
  it("is false for an empty / undefined vault", () => {
    expect(hasUserAuthoredNote(undefined)).toBe(false);
    expect(hasUserAuthoredNote([])).toBe(false);
  });

  it("is false when only seed guides exist", () => {
    const seeds = [
      mk({ id: "a", path: "Welcome to your vault 🪂", tags: ["guide"] }),
      mk({ id: "b", path: "Getting Started", tags: ["guide"] }),
    ];
    expect(hasUserAuthoredNote(seeds)).toBe(false);
  });

  it("ignores the app's own system notes under .parachute/", () => {
    const notes = [mk({ id: "s", path: ".parachute/notes/settings" })];
    expect(hasUserAuthoredNote(notes)).toBe(false);
  });

  it("is true once a real user note exists alongside seeds", () => {
    const notes = [
      mk({ id: "a", path: "Welcome to your vault 🪂", tags: ["guide"] }),
      mk({ id: "u", path: "My first thought", tags: ["capture"] }),
    ];
    expect(hasUserAuthoredNote(notes)).toBe(true);
  });
});

describe("deriveSteps", () => {
  const clean: HomeChecklistState = { dismissed: false, overrides: {} };

  it("auto-completes write from a user note; connect/import stay manual", () => {
    const steps = deriveSteps(clean, { hasUserNote: true, installed: false, installable: true });
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId.write).toMatchObject({ auto: true, done: true });
    expect(byId.connect).toMatchObject({ auto: false, done: false });
    expect(byId.import).toMatchObject({ auto: false, done: false });
  });

  it("honors manual overrides for connect + import", () => {
    const steps = deriveSteps(
      { dismissed: false, overrides: { connect: true, import: true } },
      { hasUserNote: false, installed: false, installable: true },
    );
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId.connect.done).toBe(true);
    expect(byId.import.done).toBe(true);
  });

  it("hides the install step where the platform can't install and isn't installed", () => {
    const steps = deriveSteps(clean, { hasUserNote: false, installed: false, installable: false });
    expect(steps.some((s) => s.id === "install")).toBe(false);
  });

  it("shows install as auto-done when already running standalone", () => {
    const steps = deriveSteps(clean, { hasUserNote: false, installed: true, installable: false });
    const install = steps.find((s) => s.id === "install");
    expect(install).toMatchObject({ auto: true, done: true });
  });

  it("stepsComplete is true only when every present step is done", () => {
    const allDone = deriveSteps(
      { dismissed: false, overrides: { connect: true, import: true } },
      { hasUserNote: true, installed: true, installable: false },
    );
    expect(stepsComplete(allDone)).toBe(true);

    const partial = deriveSteps(clean, {
      hasUserNote: true,
      installed: false,
      installable: true,
    });
    expect(stepsComplete(partial)).toBe(false);
  });
});
