/**
 * Local draft persistence for the note editors.
 *
 * Crash / navigation protection — NOT server autosave. A note being composed or
 * edited is mirrored to localStorage (debounced) so an accidental navigation,
 * tab close, or crash before an explicit save doesn't lose the text. It is
 * NEVER written to the vault on its own: the ⌘S checkpoint stays the only
 * server-commit path, so we can't manufacture a surprise version or fight the
 * conflict machinery.
 *
 * Keyed per vault AND per scope:
 *   - a NEW note keys on the fixed `new` scope (one compose session per vault),
 *   - an existing note keys on its note id,
 * so two vaults, or two different notes, never share a draft.
 */

// The persisted editor body — the same `{ content, path, tags }` shape both
// NoteNew and NoteEditor edit. Blobs (staged audio/attachments) are NOT part of
// a draft: they can't round-trip through localStorage, and this is text-safety.
export interface DraftBody {
  content: string;
  path: string;
  tags: string[];
}

export interface StoredDraft {
  body: DraftBody;
  /** ISO timestamp of the last persist — powers the "draft from <when>" copy. */
  savedAt: string;
}

/** Fixed scope for the new-note compose session (there's one per vault). */
export const NEW_NOTE_SCOPE = "new";

const KEY_PREFIX = "notes:draft:";

export function draftKey(vaultId: string, scope: string): string {
  return `${KEY_PREFIX}${vaultId}:${scope}`;
}

function isDraftBody(v: unknown): v is DraftBody {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.content === "string" &&
    typeof b.path === "string" &&
    Array.isArray(b.tags) &&
    b.tags.every((t) => typeof t === "string")
  );
}

export function loadDraft(vaultId: string, scope: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(vaultId, scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (!parsed || !isDraftBody(parsed.body)) return null;
    return {
      body: { content: parsed.body.content, path: parsed.body.path, tags: [...parsed.body.tags] },
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveDraft(vaultId: string, scope: string, body: DraftBody): void {
  try {
    const payload: StoredDraft = { body, savedAt: new Date().toISOString() };
    localStorage.setItem(draftKey(vaultId, scope), JSON.stringify(payload));
  } catch {
    // storage unavailable / quota — best-effort only.
  }
}

export function clearDraft(vaultId: string, scope: string): void {
  try {
    localStorage.removeItem(draftKey(vaultId, scope));
  } catch {
    // best-effort only.
  }
}

/** Value equality on the editable fields — used to decide whether a stored
 * draft actually differs from a baseline (server note, or a new-note's empty
 * default), so we don't offer to "restore" something identical. */
export function bodyEquals(a: DraftBody, b: DraftBody): boolean {
  if (a.content !== b.content || a.path !== b.path) return false;
  if (a.tags.length !== b.tags.length) return false;
  const set = new Set(a.tags);
  return b.tags.every((t) => set.has(t));
}
