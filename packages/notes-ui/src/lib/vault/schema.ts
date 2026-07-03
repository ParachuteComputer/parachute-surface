// Required tag schema Notes ensures exists on the active vault. First instance
// of patterns#57 (surface-declares-required-schema). Aaron's framing: every
// note in a vault IS a note, so `#note` is tautological. `#capture`
// distinguishes notes-the-user-captured from imported / generated / derived
// ones — that's a real semantic axis.
//
// One tag, deliberately. The earlier hierarchy (`capture/text`,
// `capture/voice` under `capture`) moved the HOW into tag identity; that
// axis now rides note metadata instead (`source: "text" | "voice"`), so the
// schema Notes asks a vault to carry is exactly one tag. Matches the vault's
// seeded starter pack (parachute-vault, 2026-07 simplification) — a fresh
// vault and a Notes-ensured vault agree on the same single row.
//
// Notes "ensures" this schema lazily on first capture — creating the tag
// only when the vault doesn't have it (see schema-ensure.ts). It never
// force-migrates a vault's existing rows or the user's stored Tag Role
// *values*: if a user has `captureText = "quick"` from rc.6, that stays.

export interface RequiredTagDecl {
  name: string;
  description: string;
  parent_names?: string[];
}

export interface RequiredSchema {
  tags: readonly RequiredTagDecl[];
}

export const NOTES_REQUIRED_SCHEMA: RequiredSchema = {
  tags: [
    {
      name: "capture",
      description: "Notes captured directly by the user (text or voice).",
    },
  ],
};
