/**
 * Record words: the same calls in the words core 0.9's record door and
 * Parachute's applets use (`body` for a note's content, `fields` for its
 * metadata). A web app and an applet written against them read alike, so
 * code moves between the two unchanged (parachute's applet kit gives an
 * applet `vault.queryRecords` / `getRecord` / `createRecord` /
 * `updateRecord` with exactly these shapes).
 *
 * They ride the notes routes (`/api/notes`), so they work on a hub before
 * the record door (0.8) and with it (0.9): only the words are renamed, in
 * and out. Pure.
 */
import { type MetadataFilter, type NotesQuery, buildNotesQuery } from "./notes-query.js";
import type {
  CreateNotePayload,
  Note,
  NoteLink,
  NoteSummary,
  UpdateNotePayload,
} from "./vault-types.js";

/** One end of a link, in record words. */
export type RecordSummary = Omit<NoteSummary, "metadata"> & { fields?: Record<string, unknown> };
/** A link in record words: its own data as `fields`, and both ends. */
export type RecordLink = Omit<NoteLink, "sourceNote" | "targetNote"> & {
  fields?: Record<string, unknown>;
  sourceNote?: RecordSummary;
  targetNote?: RecordSummary;
};
/** A note in record words: `body` (content) and `fields` (metadata). */
export type VaultRecord = Omit<Note, "content" | "metadata" | "links"> & {
  body?: string;
  fields?: Record<string, unknown>;
  links?: RecordLink[];
};
/**
 * A records query: {@link NotesQuery} in record words (`includeBody`,
 * `includeFields`, and `fields` to filter by a field), plus `search`
 * (full-text; the hub ranks it).
 */
export type RecordsQuery = Omit<NotesQuery, "includeContent" | "includeMetadata" | "metadata"> & {
  includeBody?: boolean;
  includeFields?: boolean | string[];
  fields?: Record<string, MetadataFilter>;
  search?: string;
};
export type CreateRecordPayload = Omit<CreateNotePayload, "content" | "metadata"> & {
  body: string;
  fields?: Record<string, unknown>;
};
export type UpdateRecordPayload = Omit<UpdateNotePayload, "content" | "metadata"> & {
  body?: string;
  fields?: Record<string, unknown>;
};

const summary = (s: NoteSummary): RecordSummary => {
  const { metadata, ...rest } = s;
  return metadata === undefined ? rest : { ...rest, fields: metadata };
};

/** A note as a record: content → body, metadata → fields, link ends too. */
export function toRecord(n: Note): VaultRecord {
  const { content, metadata, links, ...rest } = n;
  const r: VaultRecord = { ...rest };
  if (content !== undefined) r.body = content;
  if (metadata !== undefined) r.fields = metadata;
  if (links !== undefined) {
    r.links = links.map((l) => {
      // a link's own data (`metadata` on the hub's link rows) is renamed as a record's is
      const { sourceNote, targetNote, metadata, ...lr } = l as NoteLink & {
        metadata?: Record<string, unknown>;
      };
      return {
        ...lr,
        ...(metadata !== undefined ? { fields: metadata } : {}),
        ...(sourceNote ? { sourceNote: summary(sourceNote) } : {}),
        ...(targetNote ? { targetNote: summary(targetNote) } : {}),
      };
    });
  }
  return r;
}

/** A records query as the notes route's wire params. */
export function recordsQueryParams(q: RecordsQuery): URLSearchParams {
  const { includeBody, includeFields, fields, search, ...rest } = q;
  const nq: NotesQuery = { ...rest };
  if (includeBody !== undefined) nq.includeContent = includeBody;
  if (includeFields !== undefined) nq.includeMetadata = includeFields;
  if (fields !== undefined) nq.metadata = fields;
  const params = buildNotesQuery(nq);
  if (search !== undefined) params.set("search", search);
  return params;
}

export function toCreateNote(p: CreateRecordPayload): CreateNotePayload {
  const { body, fields, ...rest } = p;
  return { ...rest, content: body, ...(fields !== undefined ? { metadata: fields } : {}) };
}

export function toUpdateNote(p: UpdateRecordPayload): UpdateNotePayload {
  const { body, fields, ...rest } = p;
  return {
    ...rest,
    ...(body !== undefined ? { content: body } : {}),
    ...(fields !== undefined ? { metadata: fields } : {}),
  };
}
