import {
  type PermissionError,
  type RecorderController,
  createRecorder,
  pickMimeType,
  requestMic,
} from "@/lib/capture/recorder";
import { useCallback, useEffect, useRef, useState } from "react";

// Voice-capture state machine extracted from the (now removed) Capture route
// so the unified Create screen can host an inline "Record" affordance without
// re-rolling MediaRecorder lifecycle. Caller decides UX (a tap-toggle Record/
// Stop button, where the preview lives, when to discard); this hook owns the
// audio bytes, the elapsed timer, and the URL-object lifetime.
//
// Replaces parts of Capture.tsx's recording phase machine. The Phase shape
// is preserved so existing tests that mocked `createRecorder`/`requestMic`/
// `pickMimeType` from `@/lib/capture/recorder` keep working without touching
// the recorder module itself.

export type VoicePhase =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "denied"; message: string }
  | { kind: "recording"; startedAt: number }
  | {
      kind: "have-audio";
      data: ArrayBuffer;
      mimeType: string;
      url: string;
      durationMs: number;
    };

export interface UseVoiceCaptureResult {
  phase: VoicePhase;
  elapsedMs: number;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  discardAudio(): void;
  reset(): void;
}

export function useVoiceCapture(): UseVoiceCaptureResult {
  const [phase, setPhase] = useState<VoicePhase>({ kind: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<RecorderController | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  // Tick the elapsed display while recording.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const id = setInterval(() => setElapsedMs(Date.now() - phase.startedAt), 250);
    return () => clearInterval(id);
  }, [phase]);

  // Revoke any preview URL on unmount so we don't leak blob: handles.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (phase.kind === "recording" || phase.kind === "requesting") return;
    setPhase({ kind: "requesting" });
    try {
      const mimeType = pickMimeType();
      if (!mimeType) {
        setPhase({
          kind: "denied",
          message: "This browser can't record audio in a format we can save.",
        });
        return;
      }
      const stream = await requestMic();
      const rec = createRecorder({ stream, mimeType });
      recorderRef.current = rec;
      rec.start();
      setElapsedMs(0);
      setPhase({ kind: "recording", startedAt: Date.now() });
    } catch (e) {
      const perm = e as PermissionError;
      const message =
        perm.kind === "permission-denied"
          ? "Microphone access was denied. Update your browser's site settings to record."
          : perm.kind === "no-device"
            ? "No microphone was found on this device."
            : perm instanceof Error
              ? perm.message
              : "Microphone is not available in this browser.";
      setPhase({ kind: "denied", message });
    }
  }, [phase]);

  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || phase.kind !== "recording") return;
    try {
      const result = await rec.stop();
      recorderRef.current = null;
      const blob = new Blob([result.data], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPhase({
        kind: "have-audio",
        data: result.data,
        mimeType: result.mimeType,
        url,
        durationMs: result.durationMs,
      });
    } catch (e) {
      // Caller surfaces the toast — this hook is presentation-agnostic.
      console.warn(e instanceof Error ? `Recording failed: ${e.message}` : "Recording failed.");
      setPhase({ kind: "idle" });
    }
  }, [phase]);

  const discardAudio = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPhase({ kind: "idle" });
    setElapsedMs(0);
  }, []);

  // Same as discardAudio but exported under a distinct name to match the
  // capture-component reset semantics — after a successful save, the
  // caller clears its own state AND tells the hook to clear audio.
  const reset = useCallback(() => {
    discardAudio();
  }, [discardAudio]);

  // NOTE: recording is a TAP-TOGGLE (tap Record to start, tap Stop to end) —
  // NOT press-and-hold. The old global `pointerup`→stop listener was removed
  // 2026-07-07: it stopped on the tap's own release, giving 0-second clips
  // (a quick tap is pointerdown+pointerup). Recording now persists until the
  // user explicitly taps Stop. (A proper press-and-hold mode, gated on a hold
  // threshold, can be re-added later if wanted.)

  return { phase, elapsedMs, startRecording, stopRecording, discardAudio, reset };
}
