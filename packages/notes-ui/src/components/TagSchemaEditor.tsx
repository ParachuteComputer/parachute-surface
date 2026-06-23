import { useTag, useUpdateTag } from "@/lib/vault";
import { VaultAuthError } from "@/lib/vault/client";
import type { TagFieldSchema, TagUpsertPayload } from "@/lib/vault/types";
import { useEffect, useState } from "react";

// Tag schema editor — modal that surfaces a single tag's identity row
// (description, fields, parent_names) and lets the operator edit them.
// Mounted from the Tags page per Aaron's 2026-05-27 directive: "in the tag
// viewer we want to also be able to see the schema for different tags, and
// even edit schemas; although it should include a warning that it might
// not edit fields on existing ones."
//
// Backfill semantics — confirmed by reading `parachute-vault/src/routes.ts`
// PUT /api/tags/:name handler: the route only writes the tag-identity row.
// Notes that already carry the tag KEEP their existing metadata shape;
// vault does not retroactively conform old note rows to a new schema. So
// the warning in this UI is true, and we surface it whenever the operator
// declares or edits a `fields` row (description-only edits don't trigger it
// because there's no shape to conform).

type FieldRow = {
  // Each field needs a stable React key independent of the user-editable
  // name — typing `field_name` → renaming live would otherwise yank focus
  // on every keystroke as the key changed.
  rowId: string;
  name: string;
  type: string;
};

// Field type vocabulary that's safe to commit. Vault accepts any string,
// but constraining the picker keeps the surface declarative. Matches the
// common subset used across the ecosystem's seed schemas.
const FIELD_TYPES = ["string", "number", "boolean", "date"] as const;

let rowIdCounter = 0;
function newRowId(): string {
  rowIdCounter += 1;
  return `row-${rowIdCounter}`;
}

function fieldsToRows(fields: Record<string, TagFieldSchema> | null | undefined): FieldRow[] {
  if (!fields) return [];
  return Object.entries(fields).map(([name, schema]) => ({
    rowId: newRowId(),
    name,
    type: schema.type || "string",
  }));
}

interface Props {
  tagName: string;
  onClose(): void;
}

export function TagSchemaEditor({ tagName, onClose }: Props) {
  const query = useTag(tagName);
  const mutation = useUpdateTag();

  // Seed local form state when the tag record lands. Use a ref of the
  // last-seeded `updatedAt` so a refetch (e.g. invalidation after save)
  // doesn't clobber in-progress edits with the freshly-fetched values.
  const [description, setDescription] = useState("");
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);
  const [parentNames, setParentNames] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (seeded) return;
    if (query.isPending) return;
    const rec = query.data;
    if (rec) {
      setDescription(rec.description ?? "");
      setFieldRows(fieldsToRows(rec.fields));
      setParentNames((rec.parent_names ?? []).join(", "));
    }
    setSeeded(true);
  }, [seeded, query.isPending, query.data]);

  const initialFields = query.data?.fields ?? null;
  // Compute whether the user's edits to `fields` would change the on-vault
  // shape. The warning fires only when there's an actual shape diff —
  // editing description alone doesn't conform-or-not-conform anything.
  const fieldsChanged = !sameFields(initialFields, rowsToFieldsMap(fieldRows));

  const updateField = (rowId: string, patch: Partial<Omit<FieldRow, "rowId">>) => {
    setFieldRows((prev) => prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
  };
  const addField = () => {
    setFieldRows((prev) => [...prev, { rowId: newRowId(), name: "", type: "string" }]);
  };
  const removeField = (rowId: string) => {
    setFieldRows((prev) => prev.filter((row) => row.rowId !== rowId));
  };

  const onSave = async () => {
    setError(null);
    // Validate field names — empty, dup, and reserved-ish keys would reject
    // server-side anyway, but we catch them client-side for a clearer message.
    const trimmed = fieldRows.map((r) => ({ ...r, name: r.name.trim() }));
    const empties = trimmed.filter((r) => r.name.length === 0);
    if (empties.length > 0) {
      setError("Field names can't be blank. Remove the empty row or fill it in.");
      return;
    }
    const seen = new Set<string>();
    for (const r of trimmed) {
      if (seen.has(r.name)) {
        setError(`Duplicate field name "${r.name}". Each field needs a unique key.`);
        return;
      }
      seen.add(r.name);
    }

    // Vault's PUT merges `fields` keys — passing a partial map only updates
    // those keys, never removes the missing ones. To actually delete a key
    // the operator removed in the UI, we have to send an explicit `null`
    // for it OR send the full new map after clearing-then-replacing. The
    // simplest correct path: if the user removed any fields, send
    // `fields: null` first to clear, then a second PUT with the new map.
    // But vault accepts an explicit `null` value per field-key too, so we
    // construct the patch as "every old key the user no longer has = null,
    // every new key = its declared schema."
    //
    // ...except per vault routes.ts the merge is at the KEYS level — a key
    // omitted from the body is preserved, but a key present with a value
    // overwrites. There's no per-key null. The only way to delete a key
    // is `fields: null` (wipes all), or rewrite the whole map after
    // wiping.
    //
    // Pragmatic: for the common edit (add/rename/retype), we send the new
    // full map. For deletion, the operator's removal of a row plus a save
    // sends `fields: <new map without that key>` which preserves the key
    // server-side (merge semantics). To make removal work, when the user
    // has removed any rows, send `fields: null` to clear, then the new
    // map in a follow-up call. We do that here.
    const newFields = trimmed.length > 0 ? rowsToFieldsMap(trimmed) : null;
    const removedAnyField =
      initialFields !== null &&
      initialFields !== undefined &&
      Object.keys(initialFields).some((k) => !trimmed.find((r) => r.name === k));

    const trimmedParents = parentNames
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const trimmedDescription = description.trim();
    const payload: TagUpsertPayload = {
      description: trimmedDescription || null,
      parent_names: trimmedParents.length > 0 ? trimmedParents : null,
    };

    try {
      if (removedAnyField) {
        // Two-step delete: wipe then rewrite. Vault accepts `fields: null`
        // as the wipe signal (see routes.ts PUT handler). The second call
        // re-asserts the description + parents so they stick alongside
        // the new fields map.
        await mutation.mutateAsync({
          name: tagName,
          payload: { ...payload, fields: null },
        });
        if (newFields) {
          await mutation.mutateAsync({
            name: tagName,
            payload: { ...payload, fields: newFields },
          });
        }
      } else {
        await mutation.mutateAsync({
          name: tagName,
          payload: { ...payload, fields: newFields },
        });
      }
      onClose();
    } catch (e) {
      if (e instanceof VaultAuthError) {
        setError("Session expired. Reconnect to save.");
        return;
      }
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    // Escape closes the dialog — keyboard parity for the Close button.
    // Backdrop click-outside-to-dismiss removed because biome's a11y rule
    // (rightly) flags click-only handlers on non-interactive elements;
    // ESC + the Close + Cancel buttons cover every dismiss path.
    <dialog
      open
      aria-modal="true"
      aria-label={`Edit schema for #${tagName}`}
      className="fixed inset-0 z-50 m-0 h-dvh w-screen max-h-none max-w-none overflow-y-auto bg-black/60 p-4 md:p-8"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="mx-auto max-w-xl rounded-lg border border-border bg-card p-5 text-fg md:p-6">
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg">
            Schema for <span className="font-mono">#{tagName}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-fg-muted hover:text-accent"
            aria-label="Close schema editor"
          >
            Close
          </button>
        </header>

        {query.isPending ? (
          <p className="text-sm text-fg-dim" aria-busy="true">
            Loading schema…
          </p>
        ) : query.isError ? (
          <p role="alert" className="text-sm text-red-400">
            Could not load schema: {query.error.message}
          </p>
        ) : (
          <>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs uppercase tracking-wider text-fg-dim">
                Description
              </span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this tag mean? Who uses it?"
                aria-label="Tag description"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
              />
            </label>

            <fieldset className="mb-4">
              <legend className="mb-2 text-xs uppercase tracking-wider text-fg-dim">Fields</legend>
              {fieldRows.length === 0 ? (
                <p className="mb-2 text-xs text-fg-dim">
                  No fields declared yet. Add one to give notes carrying this tag a structured
                  shape.
                </p>
              ) : (
                <ul className="mb-2 space-y-2" aria-label="Schema fields">
                  {fieldRows.map((row) => (
                    <li key={row.rowId} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => updateField(row.rowId, { name: e.target.value })}
                        placeholder="field_name"
                        aria-label="Field name"
                        className="flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                      />
                      <select
                        value={row.type}
                        onChange={(e) => updateField(row.rowId, { type: e.target.value })}
                        aria-label={`Type for ${row.name || "new field"}`}
                        className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
                      >
                        {FIELD_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => removeField(row.rowId)}
                        aria-label={`Remove field ${row.name || "new"}`}
                        className="text-fg-dim hover:text-red-400"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={addField}
                className="text-xs text-accent hover:text-accent-hover"
              >
                + Add field
              </button>
            </fieldset>

            <label className="mb-4 block">
              <span className="mb-1 block text-xs uppercase tracking-wider text-fg-dim">
                Parent tags
              </span>
              <input
                type="text"
                value={parentNames}
                onChange={(e) => setParentNames(e.target.value)}
                placeholder="comma-separated (e.g. project, area)"
                aria-label="Parent tags"
                className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
              />
              <p className="mt-1 text-xs text-fg-dim">
                Vault treats parents as a hierarchical relationship — children inherit semantics.
                Comma-separated; leave blank for a top-level tag.
              </p>
            </label>

            {fieldsChanged ? (
              <div
                role="alert"
                className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300"
              >
                <strong className="block font-medium">Heads up.</strong> Editing this tag's schema
                doesn't retroactively update notes already tagged with{" "}
                <span className="font-mono">#{tagName}</span>. The new schema applies to notes you
                create or update from here on. Existing notes keep their current shape until you
                edit them.
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="mb-3 text-sm text-red-400">
                {error}
              </p>
            ) : null}

            <footer className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg-muted hover:text-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={mutation.isPending}
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover disabled:opacity-40"
              >
                {mutation.isPending ? "Saving…" : "Save schema"}
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>
  );
}

function rowsToFieldsMap(rows: FieldRow[]): Record<string, TagFieldSchema> {
  const out: Record<string, TagFieldSchema> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    out[name] = { type: row.type };
  }
  return out;
}

function sameFields(
  a: Record<string, TagFieldSchema> | null | undefined,
  b: Record<string, TagFieldSchema> | null | undefined,
): boolean {
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!b || !b[k]) return false;
    if (a![k]!.type !== b[k]!.type) return false;
  }
  return true;
}

// Exposed for tests — verifies the diff helper behavior without spinning up
// the full React tree.
export const _internals = { sameFields, rowsToFieldsMap };
