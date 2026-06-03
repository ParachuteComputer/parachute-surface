import { useMemo } from "react";
import { PlainRenderer } from "./PlainRenderer.js";
import { parseCsv } from "./csv.js";

export interface CsvRendererProps {
  content: string;
  className?: string;
}

/**
 * Render CSV content as an HTML table — first row treated as the header.
 * On a fatally malformed CSV (unterminated quote at EOF) we surface what we
 * parsed plus an inline warning. With no rows at all we fall back to the
 * plain-text renderer.
 */
export function CsvRenderer({ content, className = "prose-note" }: CsvRendererProps) {
  const parsed = useMemo(() => parseCsv(content), [content]);

  if (parsed.rows.length === 0) {
    return <PlainRenderer content={content} className={className} />;
  }

  const [header, ...body] = parsed.rows;
  const hasBody = body.length > 0;
  const columnCount = Math.max(header?.length ?? 0, ...body.map((r) => r.length));

  return (
    <div className={className}>
      {parsed.truncated ? (
        <p className="csv-warning">
          This CSV looks malformed (unterminated quoted cell). Showing the rows we could parse.
        </p>
      ) : null}
      {/* Column/row positions are the only stable identity for CSV cells, so
          all loops use array index as key. */}
      <div className="csv-scroll">
        <table>
          <thead>
            <tr>
              {Array.from({ length: columnCount }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                <th key={i} scope="col">
                  {header?.[i] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          {hasBody ? (
            <tbody>
              {body.map((rowCells, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                <tr key={ri}>
                  {Array.from({ length: columnCount }).map((_, ci) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional
                    <td key={ci}>{rowCells[ci] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
      </div>
    </div>
  );
}
