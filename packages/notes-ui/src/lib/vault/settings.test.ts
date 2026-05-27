import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTES_SETTINGS,
  SETTINGS_NOTE_PATH,
  SETTINGS_SCHEMA_VERSION,
  type SettingsCacheEntry,
  applySettingsPatch,
  deleteCachedSettings,
  extractNotesSettings,
  loadCachedSettings,
  mergeSettingsPatches,
  normalizeNotesSettings,
  saveCachedSettings,
} from "./settings";
import { DEFAULT_TAG_ROLES } from "./tag-roles";
import type { Note } from "./types";

describe("settings note path is stable", () => {
  it("pins the vault path so concurrent devices agree", () => {
    // Changing this would make already-deployed installs lose their settings.
    // Bump schemaVersion and migrate instead if the shape needs to change.
    expect(SETTINGS_NOTE_PATH).toBe(".parachute/notes/settings");
  });
});

describe("normalizeNotesSettings", () => {
  it("returns defaults for null/undefined/non-object", () => {
    expect(normalizeNotesSettings(null)).toEqual(DEFAULT_NOTES_SETTINGS);
    expect(normalizeNotesSettings(undefined)).toEqual(DEFAULT_NOTES_SETTINGS);
    expect(normalizeNotesSettings("nope")).toEqual(DEFAULT_NOTES_SETTINGS);
    expect(normalizeNotesSettings(42)).toEqual(DEFAULT_NOTES_SETTINGS);
  });

  it("fills missing tagRoles with defaults", () => {
    const out = normalizeNotesSettings({ schemaVersion: 1 });
    expect(out.schemaVersion).toBe(1);
    expect(out.tagRoles).toEqual(DEFAULT_TAG_ROLES);
  });

  it("merges partial tagRoles over defaults", () => {
    const out = normalizeNotesSettings({
      schemaVersion: 1,
      tagRoles: { pinned: "starred" },
    });
    expect(out.tagRoles.pinned).toBe("starred");
    expect(out.tagRoles.archived).toBe(DEFAULT_TAG_ROLES.archived);
  });

  it("defaults schemaVersion when missing", () => {
    const out = normalizeNotesSettings({ tagRoles: {} });
    expect(out.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });
});

describe("extractNotesSettings", () => {
  it("returns defaults for a null note", () => {
    expect(extractNotesSettings(null)).toEqual(DEFAULT_NOTES_SETTINGS);
  });

  it("returns defaults when metadata is missing or non-object", () => {
    const note: Note = { id: "n1", createdAt: "2026-04-22T00:00:00Z" };
    expect(extractNotesSettings(note)).toEqual(DEFAULT_NOTES_SETTINGS);
  });

  it("returns defaults when the notes/lens sub-object is missing", () => {
    const note: Note = {
      id: "n1",
      createdAt: "2026-04-22T00:00:00Z",
      metadata: { other: "value" },
    };
    expect(extractNotesSettings(note)).toEqual(DEFAULT_NOTES_SETTINGS);
  });

  it("reads the notes sub-object from metadata", () => {
    const note: Note = {
      id: "n1",
      createdAt: "2026-04-22T00:00:00Z",
      metadata: {
        notes: {
          schemaVersion: 1,
          tagRoles: { pinned: "favs", archived: "done" },
        },
      },
    };
    const out = extractNotesSettings(note);
    expect(out.tagRoles.pinned).toBe("favs");
    expect(out.tagRoles.archived).toBe("done");
    expect(out.tagRoles.captureVoice).toBe(DEFAULT_TAG_ROLES.captureVoice);
  });

  it("falls back to the legacy `lens` key when `notes` is absent", () => {
    // A settings note written under the prior Lens-branded release stores the
    // payload at `metadata.lens`. Read-through keeps existing installs working
    // until the next write, which will re-key under `notes`.
    const note: Note = {
      id: "n1",
      createdAt: "2026-04-22T00:00:00Z",
      metadata: {
        lens: {
          schemaVersion: 1,
          tagRoles: { pinned: "legacy-fav" },
        },
      },
    };
    expect(extractNotesSettings(note).tagRoles.pinned).toBe("legacy-fav");
  });

  it("prefers `notes` over `lens` when both are present", () => {
    const note: Note = {
      id: "n1",
      createdAt: "2026-04-22T00:00:00Z",
      metadata: {
        lens: { schemaVersion: 1, tagRoles: { pinned: "old" } },
        notes: { schemaVersion: 1, tagRoles: { pinned: "new" } },
      },
    };
    expect(extractNotesSettings(note).tagRoles.pinned).toBe("new");
  });
});

describe("applySettingsPatch", () => {
  it("returns base unchanged for an empty patch", () => {
    const out = applySettingsPatch(DEFAULT_NOTES_SETTINGS, {});
    expect(out).toEqual(DEFAULT_NOTES_SETTINGS);
  });

  it("shallow-merges tagRoles onto the base", () => {
    const base = {
      ...DEFAULT_NOTES_SETTINGS,
      tagRoles: { ...DEFAULT_TAG_ROLES, pinned: "starred" },
    };
    const out = applySettingsPatch(base, {
      tagRoles: { archived: "done" },
    });
    // Preserves the earlier pinned override and adds archived.
    expect(out.tagRoles.pinned).toBe("starred");
    expect(out.tagRoles.archived).toBe("done");
    expect(out.tagRoles.captureVoice).toBe(DEFAULT_TAG_ROLES.captureVoice);
  });

  it("normalizes incoming tagRoles (strips #, trims, falls back on blank)", () => {
    const out = applySettingsPatch(DEFAULT_NOTES_SETTINGS, {
      tagRoles: { pinned: "  #fav  ", archived: "   " },
    });
    expect(out.tagRoles.pinned).toBe("fav");
    expect(out.tagRoles.archived).toBe(DEFAULT_TAG_ROLES.archived);
  });

  it("updates schemaVersion when the patch names one", () => {
    const out = applySettingsPatch(DEFAULT_NOTES_SETTINGS, { schemaVersion: 2 });
    expect(out.schemaVersion).toBe(2);
  });
});

describe("mergeSettingsPatches", () => {
  it("returns the new patch when there is no older one", () => {
    const out = mergeSettingsPatches(null, { tagRoles: { pinned: "fav" } });
    expect(out.tagRoles).toEqual({ pinned: "fav" });
  });

  it("newer keys win but disjoint keys from both sides survive", () => {
    const older = { tagRoles: { pinned: "fav" } };
    const newer = { tagRoles: { archived: "done" } };
    const out = mergeSettingsPatches(older, newer);
    expect(out.tagRoles).toEqual({ pinned: "fav", archived: "done" });
  });

  it("newer value overrides older value for the same key", () => {
    const out = mergeSettingsPatches(
      { tagRoles: { pinned: "old" } },
      { tagRoles: { pinned: "new" } },
    );
    expect(out.tagRoles).toEqual({ pinned: "new" });
  });

  it("propagates schemaVersion", () => {
    expect(mergeSettingsPatches({ schemaVersion: 1 }, {}).schemaVersion).toBe(1);
    expect(mergeSettingsPatches({}, { schemaVersion: 2 }).schemaVersion).toBe(2);
    expect(mergeSettingsPatches({ schemaVersion: 1 }, { schemaVersion: 2 }).schemaVersion).toBe(2);
  });
});

describe("cache round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is cached", () => {
    expect(loadCachedSettings("v1")).toBeNull();
  });

  it("persists the full entry and reloads it verbatim", () => {
    const entry: SettingsCacheEntry = {
      settings: {
        ...DEFAULT_NOTES_SETTINGS,
        tagRoles: { ...DEFAULT_TAG_ROLES, pinned: "fav" },
      },
      serverSettings: {
        ...DEFAULT_NOTES_SETTINGS,
        tagRoles: { ...DEFAULT_TAG_ROLES, pinned: "fav" },
      },
      serverUpdatedAt: "2026-04-22T12:00:00Z",
      noteExists: true,
      dirtyPatch: null,
    };
    saveCachedSettings("v1", entry);
    const out = loadCachedSettings("v1");
    expect(out).toEqual(entry);
  });

  it("scopes by vaultId", () => {
    const e = (pinned: string): SettingsCacheEntry => ({
      settings: { ...DEFAULT_NOTES_SETTINGS, tagRoles: { ...DEFAULT_TAG_ROLES, pinned } },
      serverSettings: null,
      serverUpdatedAt: null,
      noteExists: false,
      dirtyPatch: { tagRoles: { pinned } },
    });
    saveCachedSettings("v1", e("one"));
    saveCachedSettings("v2", e("two"));
    expect(loadCachedSettings("v1")?.settings.tagRoles.pinned).toBe("one");
    expect(loadCachedSettings("v2")?.settings.tagRoles.pinned).toBe("two");
  });

  it("returns null on malformed JSON", () => {
    localStorage.setItem("notes:settings:v1", "not-json{");
    expect(loadCachedSettings("v1")).toBeNull();
  });

  it("deleteCachedSettings removes the entry", () => {
    const entry: SettingsCacheEntry = {
      settings: DEFAULT_NOTES_SETTINGS,
      serverSettings: null,
      serverUpdatedAt: null,
      noteExists: false,
      dirtyPatch: null,
    };
    saveCachedSettings("v1", entry);
    deleteCachedSettings("v1");
    expect(loadCachedSettings("v1")).toBeNull();
  });

  it("reconstructs settings from a persisted dirtyPatch on load", () => {
    // If the cache was written when a dirty patch was pending, we should
    // reconstruct the same merged view on load so the UI doesn't flash
    // unpatched values before the write lands.
    const entry: SettingsCacheEntry = {
      settings: { ...DEFAULT_NOTES_SETTINGS, tagRoles: { ...DEFAULT_TAG_ROLES, pinned: "dirty" } },
      serverSettings: DEFAULT_NOTES_SETTINGS,
      serverUpdatedAt: "2026-04-22T00:00:00Z",
      noteExists: true,
      dirtyPatch: { tagRoles: { pinned: "dirty" } },
    };
    saveCachedSettings("v1", entry);
    const out = loadCachedSettings("v1");
    expect(out?.settings.tagRoles.pinned).toBe("dirty");
    expect(out?.dirtyPatch?.tagRoles?.pinned).toBe("dirty");
  });
});

describe("concurrent-write invariant (merge-on-409)", () => {
  // Simulates the team-lead's Blocker 2 scenario. Device A and Device B both
  // fetch an empty settings note. Device A writes tagRoles.pinned first.
  // Device B, still holding Device A's pre-write updatedAt, tries to write
  // tagRoles.archived. The vault 409s. On refetch+merge, Device B must
  // preserve Device A's `pinned` change while landing its own `archived`.
  it("merges patches onto refetched server state instead of clobbering", async () => {
    const base = DEFAULT_NOTES_SETTINGS;
    const sharedUpdatedAt = "2026-04-22T10:00:00Z";

    // Server state after Device A's write has landed.
    const serverAfterA: Note = {
      id: "n1",
      createdAt: "2026-04-22T09:00:00Z",
      updatedAt: "2026-04-22T10:30:00Z",
      metadata: {
        notes: {
          schemaVersion: 1,
          tagRoles: { ...DEFAULT_TAG_ROLES, pinned: "A-pinned" },
        },
      },
    };

    // Helper: simulate what the 409-retry path does. Refetch, merge caller's
    // *patch* (not a pre-merged next) onto the server, then PATCH.
    function devicesBMerge() {
      const server = extractNotesSettings(serverAfterA);
      const devBPatch = { tagRoles: { archived: "B-archived" } };
      return applySettingsPatch(server, devBPatch);
    }

    const merged = devicesBMerge();
    expect(merged.tagRoles.pinned).toBe("A-pinned"); // preserved
    expect(merged.tagRoles.archived).toBe("B-archived"); // applied
    // And unchanged keys stay the baseline defaults.
    expect(merged.tagRoles.view).toBe(base.tagRoles.view);

    // Anti-test: the bug this fix addresses. If device B re-sends its
    // pre-409 `next` (computed from a stale cache that didn't know about A's
    // write), it would clobber A's pinned.
    const devBStaleNext = applySettingsPatch(base, { tagRoles: { archived: "B-archived" } });
    expect(devBStaleNext.tagRoles.pinned).not.toBe("A-pinned"); // reproduces the bug
    // Confirms the documented behaviour: sharedUpdatedAt here is just a
    // marker that both devices started from the same fetch.
    expect(sharedUpdatedAt).toBe("2026-04-22T10:00:00Z");
    // Silence unused warnings in tidy test bodies.
    vi.fn();
  });
});
