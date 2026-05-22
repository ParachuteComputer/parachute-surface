/**
 * `SchemaRequirements` — renders an app's `required_schema` declaration.
 *
 * Phase 2.0 surface (patterns#57): expand-on-click section listing the
 * tag-role declarations + per-field schema the app expects vault to
 * have. Display-only. Phase 2.1+ will add a "Provision" CTA that
 * upserts the declarations into vault via VaultClient.updateTag.
 *
 * Rendered both in the modules table (compact, summary count + expand)
 * and the UI info page (always-expanded detail).
 */
import { useState } from "react";

import type { RequiredSchemaDeclaration } from "../lib/api.ts";

export interface SchemaRequirementsProps {
  schema: RequiredSchemaDeclaration | undefined;
  /** When true, render expanded by default (e.g. on the detail page). */
  defaultExpanded?: boolean;
  /**
   * Compact mode hides the descriptions + leaves only tag-names +
   * field-types visible. Used inside the modules table where vertical
   * space is at a premium.
   */
  compact?: boolean;
}

export function SchemaRequirements({
  schema,
  defaultExpanded = false,
  compact = false,
}: SchemaRequirementsProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!schema) {
    return null;
  }

  const tags = schema.tags ?? [];
  const empty = tags.length === 0;
  const fieldCount = tags.reduce(
    (sum, t) => sum + Object.keys(t.fields ?? {}).length,
    0,
  );

  // Always render the summary line so operators can tell at-a-glance
  // that the app declared `required_schema: {}` (deliberate empty)
  // versus didn't declare anything (no summary line at all).
  const summary = empty
    ? "Schema requirements: none declared (empty)"
    : `Schema requirements: ${tags.length} tag${tags.length === 1 ? "" : "s"}${
        fieldCount > 0 ? `, ${fieldCount} field${fieldCount === 1 ? "" : "s"}` : ""
      }`;

  return (
    <details
      open={expanded}
      onToggle={(e) => setExpanded((e.target as HTMLDetailsElement).open)}
      className={`schema-requirements${compact ? " schema-requirements--compact" : ""}`}
    >
      <summary aria-label="Schema requirements">{summary}</summary>
      {!empty && (
        <ul className="schema-requirements__tags">
          {tags.map((tag) => (
            <li key={tag.name} className="schema-requirements__tag">
              <code className="schema-requirements__tag-name">{tag.name}</code>
              {tag.description && !compact && (
                <span className="schema-requirements__tag-desc"> — {tag.description}</span>
              )}
              {tag.fields && Object.keys(tag.fields).length > 0 && (
                <table className="schema-requirements__fields">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Required</th>
                      {!compact && <th>Description</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(tag.fields).map(([fieldName, decl]) => (
                      <tr key={fieldName}>
                        <td>
                          <code>{fieldName}</code>
                        </td>
                        <td>
                          <code>{decl.type}</code>
                        </td>
                        <td>{decl.required ? "yes" : "no"}</td>
                        {!compact && <td>{decl.description ?? ""}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="schema-requirements__note">
        Phase 2.0: display-only. Auto-provisioning lands in Phase 2.1+.
      </p>
    </details>
  );
}
