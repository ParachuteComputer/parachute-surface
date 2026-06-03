import { useLinkAttachment, useUploadStorageFile } from "@/lib/vault";
import { fileExt, markdownForUpload, validateFile } from "@/lib/vault/attachment-upload";
import type { StorageUploadResult } from "@/lib/vault/client";
import { useCallback, useRef, useState } from "react";

// Re-exported from the shared `attachment-upload` module so existing
// import sites (`@/components/useAttachmentUploader`) keep working. The
// upload+link+served-markdown logic is shared with the Obsidian importer
// there — single source of truth, no copy-paste.
export { fileExt, markdownForUpload, validateFile };

export type UploadStatus = "uploading" | "linking" | "done" | "error" | "cancelled";

export interface UploadEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  error?: string;
  result?: StorageUploadResult;
  abort: () => void;
}

interface UploaderArgs {
  noteId: string | null;
  onInsert: (markdown: string) => void;
  onStaged?: (staged: { path: string; mimeType: string; filename: string }) => void;
  onLinked?: () => void;
  onError?: (message: string) => void;
}

export function useAttachmentUploader({
  noteId,
  onInsert,
  onStaged,
  onLinked,
  onError,
}: UploaderArgs) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  const upload = useUploadStorageFile();
  const link = useLinkAttachment();

  const update = useCallback((id: string, patch: Partial<UploadEntry>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  const start = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const validation = validateFile(file);
        if (validation) {
          onError?.(validation);
          continue;
        }
        const controller = new AbortController();
        const entry: UploadEntry = {
          id,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          loaded: 0,
          status: "uploading",
          abort: () => controller.abort(),
        };
        setUploads((prev) => [...prev, entry]);

        upload
          .mutateAsync({
            file,
            signal: controller.signal,
            onProgress: ({ loaded }) => update(id, { loaded }),
          })
          .then(async (result) => {
            update(id, { result, loaded: result.size, mimeType: result.mimeType });
            onInsert(markdownForUpload(result, file.name));

            if (noteId) {
              update(id, { status: "linking" });
              try {
                await link.mutateAsync({
                  noteId,
                  path: result.path,
                  mimeType: result.mimeType,
                });
                update(id, { status: "done" });
                onLinked?.();
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Link failed";
                update(id, { status: "error", error: msg });
                onError?.(msg);
              }
            } else {
              update(id, { status: "done" });
              onStaged?.({ path: result.path, mimeType: result.mimeType, filename: file.name });
            }
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              update(id, { status: "cancelled" });
              return;
            }
            const msg = err instanceof Error ? err.message : "Upload failed";
            update(id, { status: "error", error: msg });
            onError?.(msg);
          });
      }
    },
    [noteId, onInsert, onStaged, onLinked, onError, upload, link, update],
  );

  const cancel = useCallback((id: string) => {
    const entry = uploadsRef.current.find((u) => u.id === id);
    entry?.abort();
  }, []);

  const dismiss = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  return { uploads, start, cancel, dismiss };
}
