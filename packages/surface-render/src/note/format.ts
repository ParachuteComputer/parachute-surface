// Format dispatch for the NoteRenderer. Purely extension-driven — content
// sniffing could be added later but is out of scope. `.mdx` maps to
// `markdown` (rendered safe-as-markdown by default; see the MDX layer).

export type NoteFormat = "markdown" | "csv" | "json" | "yaml" | "code" | "plain";

/** Known code-file extensions → highlight.js language id. */
export const CODE_EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
};

export function formatForPath(path: string | undefined): NoteFormat {
  if (!path) return "markdown";
  // Trim a fragment or query defensively; vault paths shouldn't contain
  // either but the dispatcher should be robust.
  const cleaned = path.split(/[?#]/)[0] ?? path;
  const ext = cleaned.toLowerCase().split(".").pop();
  // No dot, or a path that ends with a dot — treat as markdown (the default).
  if (!ext || ext === cleaned.toLowerCase()) return "markdown";

  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "json") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext in CODE_EXTENSIONS) return "code";
  return "plain";
}

/** Lowercase extension (no dot) from a path; empty string for no-extension. */
export function extensionOf(path: string | undefined): string {
  if (!path) return "";
  const cleaned = path.split(/[?#]/)[0] ?? path;
  const lower = cleaned.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return "";
  // If the last "." is in a directory portion, there's no extension.
  if (lower.lastIndexOf("/") > dot) return "";
  return lower.slice(dot + 1);
}
