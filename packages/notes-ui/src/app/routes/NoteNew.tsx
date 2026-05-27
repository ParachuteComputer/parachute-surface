import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import { AttachmentPicker } from "@/components/AttachmentPicker";
import { AttachmentUploadList } from "@/components/AttachmentUploadList";
import type { CodeMirrorEditorHandle } from "@/components/CodeMirrorEditor";
import { CodeMirrorEditor } from "@/components/CodeMirrorEditor";
import { buildWikilinkResolver } from "@/components/MarkdownView";
import { NoteRenderer } from "@/components/NoteRenderer";
import { TagEditor, normalizeTag } from "@/components/TagEditor";
import { useAttachmentUploader } from "@/components/useAttachmentUploader";
import { extractHashtags } from "@/lib/capture/hashtags";
import { memoFilename, quickPath } from "@/lib/capture/recorder";
import { useVoiceCapture } from "@/lib/capture/use-voice-capture";
import { blobRef, enqueue, newBlobId, newLocalId } from "@/lib/sync";
import { useToastStore } from "@/lib/toast/store";
import { useCreateNote, useLinkAttachment, useTagRoles, useVaultStore } from "@/lib/vault";
import { type CreateNotePayload, VaultAuthError } from "@/lib/vault/client";
import { useActiveVaultClient } from "@/lib/vault/queries";
import { ensureNotesSchema } from "@/lib/vault/schema-ensure";
import type { Note } from "@/lib/vault/types";
import { useSync } from "@/providers/SyncProvider";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

// Unified note-creation screen — replaces the prior split between `/new`
// (form-shaped text-only) and `/capture` (voice + transcript landing).
// Aaron's 2026-05-27 framing: "having New Note and Capture as two
// different surfaces is confusing — unify into one simplified interface
// that allows for folks to be specific but still keeps it simple."
//
// One screen:
//   - Title input at the top (visible — not behind a "More fields" toggle)
//   - Content area (CodeMirror)
//   - Tags row (chips + add)
//   - "Record" mic affordance — opens an inline recorder; on stop, audio
//     stages alongside any text the operator wrote. Saving with audio
//     present goes through the same sync-queue path as the old Capture
//     route (create-note + upload-attachment + link-attachment{transcribe})
//     so the scribe pipeline appends the transcript to the note body.
//
// Notably dropped:
//   - The standalone "Summary" field. Operators were ignoring it; the
//     metadata.summary key still exists at the vault level and can be set
//     via MCP / direct API — just not here. Saves one field of friction.
//   - Capture's background draft-save loop. `useCreateNote()` already
//     queues offline; manual save is the only commit path now.
//   - The "More fields" disclosure — Title is up front, Summary is gone,
//     no need to hide anything.

interface StagedUpload {
  path: string;
  mimeType: string;
  filename: string;
}

interface DraftState {
  content: string;
  path: string;
  tags: string[];
}

const EMPTY_DRAFT: DraftState = { content: "", path: "", tags: [] };

export function NoteNew() {
  const activeVault = useVaultStore((s) => s.getActiveVault());
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const mutation = useCreateNote();
  const linkAttachment = useLinkAttachment();
  const { db, blobStore, engine } = useSync();
  const { roles } = useTagRoles(activeVault?.id ?? null);
  const client = useActiveVaultClient();

  // Default the path to a `quickPath()` so the operator sees a real value
  // up front but can override (or clear) before save. Matches Capture's
  // path-gen behaviour (see notes#126) — we never silently fall back to
  // vault-auto-assign.
  const defaultPathRef = useRef(quickPath());
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...EMPTY_DRAFT,
    path: defaultPathRef.current,
  }));
  const [tagInput, setTagInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedUpload[]>([]);
  const [isSavingAudio, setIsSavingAudio] = useState(false);
  const editorRef = useRef<CodeMirrorEditorHandle>(null);
  const voice = useVoiceCapture();

  const uploader = useAttachmentUploader({
    noteId: null,
    onInsert: (md) => {
      if (editorRef.current) {
        editorRef.current.insertAtCursor(md);
      } else {
        setDraft((d) => ({ ...d, content: `${d.content}${md}` }));
      }
    },
    onStaged: (s) => setStaged((prev) => [...prev, s]),
    onError: (msg) => pushToast(msg, "error"),
  });

  if (!activeVault) return <Navigate to="/" replace />;

  const hasAudio = voice.phase.kind === "have-audio";
  const hasText = draft.content.trim().length > 0;

  const isDirty =
    draft.content.length > 0 ||
    draft.path !== defaultPathRef.current ||
    draft.tags.length > 0 ||
    hasAudio;

  // Text-only mode requires path + content. Audio satisfies the "body" half
  // because the transcript will land there; path still required so the
  // operator always sees what they're writing.
  const isValid = draft.path.trim().length > 0 && (hasText || hasAudio);
  const pending = mutation.isPending || isSavingAudio;

  // ---- text-only save ------------------------------------------------------
  const saveTextOnly = useCallback(() => {
    if (!isValid || pending) return;
    const explicit = draft.tags;
    const extracted = extractHashtags(draft.content);
    const allTags = Array.from(new Set([...explicit, ...extracted].filter((t) => t.length > 0)));
    const payload: CreateNotePayload = {
      content: draft.content,
      path: draft.path.trim(),
    };
    if (allTags.length) payload.tags = allTags;

    setSaveError(null);
    mutation.mutate(payload, {
      onSuccess: async (created: Note) => {
        for (const s of staged) {
          try {
            await linkAttachment.mutateAsync({
              noteId: created.id,
              path: s.path,
              mimeType: s.mimeType,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Link failed";
            pushToast(`Failed to attach ${s.filename}: ${msg}`, "error");
          }
        }
        pushToast(`Created ${created.path ?? created.id}`, "success");
        navigate(`/n/${encodeURIComponent(created.id)}`);
      },
      onError: (err) => {
        if (err instanceof VaultAuthError) {
          setSaveError("Session expired. Reconnect to save.");
        } else {
          // Vault returns 500 with "Internal server error" on duplicate paths;
          // surface whatever message we got so the user can adjust the path.
          setSaveError(
            err instanceof Error
              ? `${err.message} — if the path is taken, try a different one.`
              : "Create failed",
          );
        }
      },
    });
  }, [draft, isValid, linkAttachment, mutation, navigate, pending, pushToast, staged]);

  // ---- audio save ----------------------------------------------------------
  // Mirrors Capture's audio path: enqueue create-note + upload-attachment +
  // link-attachment{transcribe:true} so the scribe pipeline appends the
  // transcript to the body once it's processed. Goes through the sync queue
  // (not useCreateNote) because audio blobs are big enough that the
  // blob-store is the right place for them, and the queue handles retry on
  // its own.
  const saveWithAudio = useCallback(async () => {
    if (!isValid || pending) return;
    if (voice.phase.kind !== "have-audio") return;
    if (!db || !blobStore) {
      pushToast("Sync queue not ready — try again in a moment.", "error");
      return;
    }
    setSaveError(null);
    setIsSavingAudio(true);
    const audio = voice.phase;
    const path = draft.path.trim();
    const explicit = draft.tags;
    const extracted = extractHashtags(draft.content);
    const finalTags = Array.from(
      new Set([roles.captureVoice, ...explicit, ...extracted].filter((t) => t.length > 0)),
    );
    if (hasText) finalTags.push(roles.captureText);
    // de-dupe again after the conditional push so the role tag isn't duplicated.
    const tags = Array.from(new Set(finalTags));

    const recordedAt = new Date();
    const filename = memoFilename(audio.mimeType, recordedAt);
    const blobId = newBlobId();
    const localId = newLocalId();
    const body = hasText
      ? `${draft.content.trim()}\n\n_Transcript pending._\n\n![[${filename}]]\n`
      : `_Transcript pending._\n\n![[${filename}]]\n`;

    // Fire-and-forget schema ensure — mirrors Capture's behavior. Vault
    // accepts notes with unwritten tag-identity rows, so we don't await.
    if (client) {
      void ensureNotesSchema(activeVault.id, client);
    }

    try {
      await blobStore.put(blobId, audio.data, audio.mimeType, activeVault.id);
      await enqueue(
        db,
        {
          kind: "create-note",
          localId,
          payload: {
            content: body,
            path,
            ...(tags.length ? { tags } : {}),
          },
        },
        { vaultId: activeVault.id },
      );
      await enqueue(
        db,
        {
          kind: "upload-attachment",
          blobId,
          filename,
          mimeType: audio.mimeType,
        },
        { vaultId: activeVault.id },
      );
      await enqueue(
        db,
        {
          kind: "link-attachment",
          noteId: localId,
          pathRef: blobRef(blobId),
          mimeType: audio.mimeType,
          transcribe: true,
        },
        { vaultId: activeVault.id },
      );
      void engine?.runOnce();
      pushToast("Captured — syncing audio.", "success");
      voice.discardAudio();
      navigate(`/n/${encodeURIComponent(localId)}`);
    } catch (e) {
      pushToast(e instanceof Error ? `Capture failed: ${e.message}` : "Capture failed.", "error");
      setSaveError(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setIsSavingAudio(false);
    }
  }, [
    activeVault,
    blobStore,
    client,
    db,
    draft,
    engine,
    hasText,
    isValid,
    navigate,
    pending,
    pushToast,
    roles.captureText,
    roles.captureVoice,
    voice,
  ]);

  const handleSave = useCallback(() => {
    if (hasAudio) void saveWithAudio();
    else saveTextOnly();
  }, [hasAudio, saveTextOnly, saveWithAudio]);

  const handleCancel = useCallback(() => {
    if (isDirty && !confirm("Discard this draft?")) return;
    voice.discardAudio();
    navigate("/");
  }, [isDirty, navigate, voice]);

  // Page-leave guard. Don't pop on save-success (when we navigate
  // programmatically, isDirty drops because state was just cleared).
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const addTag = (raw: string) => {
    const t = normalizeTag(raw);
    if (!t || draft.tags.includes(t)) return;
    setDraft((d) => ({ ...d, tags: [...d.tags, t] }));
    setTagInput("");
  };
  const removeTag = (name: string) => {
    setDraft((d) => ({ ...d, tags: d.tags.filter((x) => x !== name) }));
  };

  const resolver = buildWikilinkResolver({
    id: "__new__",
    createdAt: new Date().toISOString(),
  } as Note);

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 md:px-6 md:py-8">
      <nav className="mb-4 text-sm text-fg-dim">
        <Link to="/" className="hover:text-accent">
          ← All notes
        </Link>
      </nav>

      <article>
        <header className="mb-4 border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-xs uppercase tracking-wider text-fg-dim">New note</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCancel}
                className="min-h-11 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg-muted hover:text-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!isValid || pending}
                className="min-h-11 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                title="Create (⌘S)"
              >
                {pending ? "Creating…" : "Create"}
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <label className="flex items-baseline gap-3 text-sm">
              <span className="shrink-0 text-xs uppercase tracking-wider text-fg-dim">Title</span>
              <input
                type="text"
                value={draft.path}
                onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))}
                className="flex-1 rounded-md border border-border bg-card px-2.5 py-1 font-mono text-sm text-fg focus:border-accent focus:outline-none"
                aria-label="Note path"
                placeholder="e.g. Projects/README"
              />
            </label>
            <TagEditor
              tags={draft.tags}
              input={tagInput}
              onInputChange={setTagInput}
              onAdd={addTag}
              onRemove={removeTag}
            />
          </div>
        </header>

        {saveError ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400"
          >
            {saveError}
          </div>
        ) : null}

        <VoicePanel voice={voice} />

        <div className="grid min-h-[60vh] gap-4 lg:grid-cols-2">
          <AttachmentDropZone
            onDropFiles={uploader.start}
            className="min-w-0 rounded-md border border-border bg-card"
            hint="Images, audio, webm video"
          >
            <CodeMirrorEditor
              ref={editorRef}
              value={draft.content}
              onChange={(content) => setDraft((d) => ({ ...d, content }))}
              onSave={handleSave}
              onCancel={handleCancel}
              onPasteFile={(files) => {
                uploader.start(files);
                return true;
              }}
            />
          </AttachmentDropZone>
          <div className="min-w-0 overflow-auto rounded-md border border-border bg-card p-4">
            {draft.content.trim() ? (
              <NoteRenderer
                note={{ path: draft.path, content: draft.content }}
                resolve={resolver}
              />
            ) : (
              <p className="text-sm text-fg-dim">Preview appears here as you type.</p>
            )}
          </div>
        </div>

        <section className="mt-6 border-t border-border pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-serif text-lg">Attachments</h2>
            <AttachmentPicker onPickFiles={uploader.start} />
          </div>
          <p className="mb-3 text-xs text-fg-dim">
            Drop or paste files into the editor. Attachments link to the note when you save. Max 100
            MB each. Images, audio, webm video.{" "}
            <a
              href="https://github.com/ParachuteComputer/parachute-vault/issues/127"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              PDF + mp4 coming
            </a>
            .
          </p>
          <AttachmentUploadList
            uploads={uploader.uploads}
            onCancel={uploader.cancel}
            onDismiss={uploader.dismiss}
          />
          {staged.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm">
              {staged.map((s) => (
                <li
                  key={s.path}
                  className="flex items-center justify-between gap-2 rounded border border-border bg-card/50 px-3 py-1.5 font-mono text-xs text-fg-muted"
                >
                  <span className="truncate">{s.filename}</span>
                  <span className="shrink-0 text-fg-dim">staged</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </article>
    </div>
  );
}

// Inline voice affordance. Sits above the editor so the operator sees it
// at a glance — Aaron's "voice-capture affordance at the top of the content
// area." Idle: a single "Record" button. Recording: live elapsed + stop
// button (also stops on global pointerup if the user is hold-pressing).
// Have-audio: preview + discard. Denied: error message inline.
function VoicePanel({ voice }: { voice: ReturnType<typeof useVoiceCapture> }) {
  const { phase, elapsedMs, startRecording, stopRecording, discardAudio } = voice;
  const isRecording = phase.kind === "recording";
  const isRequesting = phase.kind === "requesting";

  if (phase.kind === "have-audio") {
    return (
      <div className="mb-4 flex flex-col gap-2 rounded-md border border-accent/30 bg-accent/5 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg-muted">
            🎙 Recorded {formatElapsed(phase.durationMs)}
          </span>
          <button
            type="button"
            onClick={discardAudio}
            className="text-xs text-fg-dim hover:text-red-400"
          >
            Discard
          </button>
        </div>
        <audio controls src={phase.url} className="w-full">
          <track kind="captions" />
        </audio>
        <p className="text-xs text-fg-dim">
          Transcript will be appended once your vault processes it. Save to commit.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card/60 p-3">
      <div className="text-xs text-fg-dim">
        {isRecording
          ? "Recording — release or click Stop to finish."
          : isRequesting
            ? "Requesting microphone…"
            : "Add a voice memo to this note. Audio gets transcribed and appended."}
      </div>
      {isRecording ? (
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            void stopRecording();
          }}
          // No onClick — onPointerDown already fires on tap + click; adding
          // onClick caused a triple-fire (pointer + click + global pointerup
          // listener in use-voice-capture). All three were no-ops after the
          // first thanks to phase-guards but noisy. Reviewer-flagged on #53.
          aria-label={`Recording — ${formatElapsed(elapsedMs)} — stop`}
          aria-pressed="true"
          className="flex min-h-11 items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400"
        >
          <span aria-hidden="true" className="animate-pulse">
            🎙
          </span>
          <span>Stop {formatElapsed(elapsedMs)}</span>
        </button>
      ) : (
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            void startRecording();
          }}
          aria-label="Record voice memo"
          disabled={isRequesting}
          className="flex min-h-11 items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/15 disabled:opacity-40"
        >
          <span aria-hidden="true">🎙</span>
          <span>{isRequesting ? "Requesting…" : "Record"}</span>
        </button>
      )}
      {phase.kind === "denied" ? (
        <p className="basis-full rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
