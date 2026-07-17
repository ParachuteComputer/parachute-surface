import type { ReactNode } from "react";
import { CodeRenderer } from "../formats/CodeRenderer.js";
import { CsvRenderer } from "../formats/CsvRenderer.js";
import { JsonRenderer } from "../formats/JsonRenderer.js";
import { PlainRenderer } from "../formats/PlainRenderer.js";
import { YamlRenderer } from "../formats/YamlRenderer.js";
import type { HighlightFn } from "../formats/highlight.js";
import { MarkdownView, type MarkdownViewProps } from "../markdown/MarkdownView.js";
import { CODE_EXTENSIONS, type NoteFormat, extensionOf, formatForPath } from "./format.js";

/** A note shape this dispatcher needs — just a path (for format detection)
 *  and content. Structurally satisfied by surface-client's `Note`. */
export interface NoteLike {
  path?: string;
  content?: string;
}

/** Props the markdown override receives — surface-render's {@link MarkdownViewProps}.
 *  Aliased so a consumer can annotate its override fn without a deep import or
 *  an `as` cast (issue #74 item 5). */
export type MarkdownOverrideProps = MarkdownViewProps;
/** Props a `csv` / `plain` override receives. */
export interface BasicFormatOverrideProps {
  content: string;
  className?: string;
}
/** Props a `json` / `yaml` override receives (adds the `highlight` hook). */
export interface HighlightableOverrideProps extends BasicFormatOverrideProps {
  highlight?: HighlightFn;
}
/** Props a `code` override receives (adds the resolved `language`). */
export interface CodeOverrideProps extends HighlightableOverrideProps {
  language: string;
}

/** A markdown-branch override fn (the most-overridden branch — a surface
 *  routes markdown through its own glue: router link, auth'd image fetch). */
export type MarkdownOverride = (props: MarkdownOverrideProps) => ReactNode;

/**
 * Per-format renderer overrides. A surface that wants different csv/json/yaml
 * behavior (e.g. a JSON tree view) passes a replacement here; otherwise the
 * good defaults are used. Each receives `content` plus the dispatcher's
 * `className`/`highlight`.
 *
 * The override prop types are exported as named aliases
 * ({@link MarkdownOverrideProps}, {@link CodeOverrideProps}, …) so a consumer
 * can annotate its override functions without `as`-casts or deep imports.
 */
export interface NoteRendererOverrides {
  markdown?: MarkdownOverride;
  csv?: (props: BasicFormatOverrideProps) => ReactNode;
  json?: (props: HighlightableOverrideProps) => ReactNode;
  yaml?: (props: HighlightableOverrideProps) => ReactNode;
  code?: (props: CodeOverrideProps) => ReactNode;
  plain?: (props: BasicFormatOverrideProps) => ReactNode;
}

export interface NoteRendererProps
  extends Pick<
    MarkdownViewProps,
    | "resolve"
    | "linkComponent"
    | "fetchBlob"
    | "components"
    | "breaks"
    | "remarkPlugins"
    | "rehypePlugins"
  > {
  note: NoteLike;
  /** Container class passed to each format renderer (default `prose-note`). */
  className?: string;
  /** Syntax highlighter for code/json/yaml (default escape-only). */
  highlight?: HighlightFn;
  /** Per-format renderer overrides (good defaults otherwise). */
  overrides?: NoteRendererOverrides;
  /** Force a format instead of deriving from `note.path`. */
  format?: NoteFormat;
}

/**
 * Format dispatcher: picks the right renderer from the note's path extension
 * (or an explicit `format`). Markdown is the default (no extension / `.md` /
 * `.mdx` / `.markdown`); everything else routes to the multi-format
 * primitives. All markdown hooks (`resolve`, `linkComponent`, `fetchBlob`, …)
 * flow through to `<MarkdownView>`.
 */
export function NoteRenderer({
  note,
  className,
  highlight,
  overrides,
  format,
  ...markdownProps
}: NoteRendererProps) {
  const content = note.content ?? "";
  const fmt = format ?? formatForPath(note.path);

  switch (fmt) {
    case "markdown": {
      // Thread `highlight` into the markdown branch too, so the SAME hook
      // colors fenced code blocks inside `.md` notes and whole code notes
      // alike (issue #74 item 3). A surface that highlights markdown fences a
      // different way (e.g. `rehypePlugins={[rehypeHighlight]}`) just omits
      // `highlight` and passes `rehypePlugins` — the markdown `code` override
      // only activates when `highlight` is set, so the two paths never collide.
      const props: MarkdownViewProps = { content, className, highlight, ...markdownProps };
      return overrides?.markdown ? <>{overrides.markdown(props)}</> : <MarkdownView {...props} />;
    }
    case "csv":
      return overrides?.csv ? (
        <>{overrides.csv({ content, className })}</>
      ) : (
        <CsvRenderer content={content} className={className} />
      );
    case "json":
      return overrides?.json ? (
        <>{overrides.json({ content, className, highlight })}</>
      ) : (
        <JsonRenderer content={content} className={className} highlight={highlight} />
      );
    case "yaml":
      return overrides?.yaml ? (
        <>{overrides.yaml({ content, className, highlight })}</>
      ) : (
        <YamlRenderer content={content} className={className} highlight={highlight} />
      );
    case "code": {
      const language = CODE_EXTENSIONS[extensionOf(note.path)] ?? "plaintext";
      return overrides?.code ? (
        <>{overrides.code({ content, language, className, highlight })}</>
      ) : (
        <CodeRenderer
          content={content}
          language={language}
          className={className}
          highlight={highlight}
        />
      );
    }
    default:
      return overrides?.plain ? (
        <>{overrides.plain({ content, className })}</>
      ) : (
        <PlainRenderer content={content} className={className} />
      );
  }
}
