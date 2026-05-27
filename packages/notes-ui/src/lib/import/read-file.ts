/**
 * Read a `Blob`/`File` as UTF-8 text in any environment we care about.
 *
 * Two paths because two environments:
 *   - Real browsers: `blob.text()` (Blob method, baseline since 2020) —
 *     one Promise, no event-listener dance.
 *   - jsdom (vitest): doesn't ship `Blob.prototype.text`, but its
 *     `FileReader.readAsText` works. Fall back to that.
 *
 * The fallback is feature-detected, not user-agent-sniffed, so this
 * survives any future jsdom version that gains `Blob.text`.
 */
export function readBlobAsText(blob: Blob): Promise<string> {
  if (typeof (blob as Blob & { text?: () => Promise<string> }).text === "function") {
    return (blob as Blob & { text: () => Promise<string> }).text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsText(blob);
  });
}
