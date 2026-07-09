/**
 * Debounced local-draft autosave for an editor.
 *
 * Mirrors the editor `body` to localStorage (per vault + scope) a short beat
 * after typing stops, so an accidental navigation, tab close, or crash before
 * an explicit save doesn't lose the text. It is deliberately debounced-only
 * (no server write): the caller clears the draft on a successful save or an
 * explicit discard.
 *
 *   - `enabled` false → the draft is cleared (nothing worth keeping).
 *   - page hide / tab background → flush immediately, because a backgrounded
 *     PWA or a killed tab never runs React unmount — the exact crash case this
 *     guards against.
 */

import { useEffect, useMemo, useRef } from "react";
import { type DraftBody, clearDraft, saveDraft } from "./store";

export function useDraftAutosave(
  vaultId: string | null,
  scope: string | null,
  body: DraftBody,
  enabled: boolean,
  delayMs = 600,
): void {
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Depend on the VALUE signature, not the (per-render-fresh) body identity, so
  // the debounce timer only re-arms when the content actually changes.
  const sig = useMemo(() => JSON.stringify(body), [body]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `sig` is the value-stable proxy for `body` (read via bodyRef); depending on `body` would re-arm every render.
  useEffect(() => {
    if (!vaultId || !scope) return;
    if (!enabled) {
      clearDraft(vaultId, scope);
      return;
    }
    const timer = window.setTimeout(() => saveDraft(vaultId, scope, bodyRef.current), delayMs);
    return () => window.clearTimeout(timer);
  }, [sig, enabled, vaultId, scope, delayMs]);

  useEffect(() => {
    if (!vaultId || !scope) return;
    const flush = () => {
      if (enabledRef.current) saveDraft(vaultId, scope, bodyRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [vaultId, scope]);
}
