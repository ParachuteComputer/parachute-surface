# Notes UI — design system

`src/styles/index.css` is the canonical stylesheet for a Parachute notes surface.
It codifies the **warm-paper / forest-green / serif** identity into a token +
component-class system so a generic surface stays Linear/Things-tier consistent
without re-deriving the look per file. Other surface authors copy this file as a
starting point.

The look is **not** opinionated about notes: no tag schema, no note-type
assumptions live here. It's a generic, themeable chrome.

## Token contract

Use the **semantic** tokens, never raw palette hexes or Tailwind color literals
(`red-500`, `text-white`, `amber-300`, …). All tokens live in the `@theme` block
(light values) with a single dark-override (see "Theming" below).

| Token | Use |
|---|---|
| `--color-bg` / `-soft` | page background / recessed surfaces |
| `--color-fg` / `-muted` / `-dim` | primary / secondary / tertiary text |
| `--color-accent` / `-hover` | forest-green brand action color |
| **`--color-on-accent`** | text that sits ON an accent surface — **white in light, dark ink in dark** (the WCAG-AA fix). Never `text-white` on accent. |
| `--color-danger` / `-hover` / `-soft` / `-border` | destructive / error |
| `--color-warning` / `-soft` | caution |
| `--color-positive` / `-soft` | success (== accent) |
| `--color-border` / `-light` | hairlines |
| `--color-card` / `-hover` | raised surface |
| `--text-2xs … --text-3xl` | ONE type ramp shared by chrome + prose |
| `--radius-xs … --radius-full` | radii |
| `--shadow-sm` / `-md` / `-lg` | warm-tinted elevation |
| `--w-prose` / `-page` / `-narrow` | container widths (42 / 72 / 32 rem) |

The Tailwind v4 `@theme` block means every `--color-*`, `--text-*`, `--radius-*`
token is also a utility (`bg-accent`, `text-fg-muted`, `text-2xs`,
`max-w-[--w-page]`). For the semantic state tokens, use the arbitrary-value form:
`text-[--color-danger]`, `bg-[--color-danger-soft]`,
`border-[--color-danger-border]`.

## Component classes (`@layer components`)

Build surfaces from these instead of re-hand-rolling strings:

- **Buttons** — `.btn` base + `.btn-primary` / `.btn-secondary` / `.btn-ghost` /
  `.btn-accent-soft` (accent-tinted in-context action) / `.btn-danger` (soft) /
  `.btn-danger-solid` (filled). Sizes: `.btn-sm`, `.btn-lg`, `.btn-touch`
  (min-h-11 mobile target).
- **Form controls** — `.input` / `.textarea` / `.select` (+ `.input-on-bg` when
  the field sits on a recessed/dialog surface).
- **Surfaces** — `.card`.
- **Chips** — `.chip` + `.chip-tag` / `.chip-tag-active`.
- **Dialogs** — `.dialog-overlay` + `.dialog-panel`.
- **Type helpers** — `.page-title` (the serif page headline — a fluid `clamp`
  that scales with the text-size knob at its rem lower bound; use it for every
  route's `<h1>`), `.eyebrow` (uppercase micro-label; pair with a hairline
  `<span className="h-px flex-1 bg-border" />` for a section-label rule),
  `.note-id` (mono path — the dim metadata line under a human title, never the
  headline).
- **Canvas** — `.app-canvas` on the app shell: `--color-bg` plus a whisper of
  warm sage radially washed in from the top. Text still resolves against the
  solid `--color-bg` beneath it, so AA contrast is unchanged.
- **Page wrappers** — `.page` (centered, `--w-page`, canonical gutters) /
  `.page-prose` (reading width — the calm single-column flows like the Today
  timeline live here). `.prose-note` caps its measure at `--w-prose` so
  long-form reading stays comfortable in a wide column.
- **Skeleton** — `.skeleton` (honors `prefers-reduced-motion`).
- **Focus** — `.focus-ring`: one accessible `focus-visible` ring that works on
  bordered and unbordered elements. Apply to any interactive element lacking a
  focus style.

Shared React state primitives wrap the patterns: `<Skeleton>`, `<EmptyState>`,
`<ErrorState>` in `src/components/ui/`.

## Theming

Light tokens live in `@theme`. The **dark** theme is a single source: the dark
hex values are defined once as private `--_d-*` vars on `:root`, and both dark
gates (the `@media (prefers-color-scheme: dark)` system case and the explicit
`:root[data-theme="dark"]` case) point the public tokens at those privates. Edit
a dark value in exactly one place.

## WCAG-AA note (the dark-accent fix)

The dark-mode accent is a **light** green (`#7ab087`). White text on it is
~2.5:1 — **fails** AA. `--color-on-accent` flips to a dark ink (`#15211a`) in
dark mode → ~6.6:1, passes. Every accent-surfaced label uses `.btn-primary` or
`text-[--color-on-accent]`; there are **no** `text-white`-on-accent uses left.

| Surface | Ink | Ratio | AA (4.5:1) |
|---|---|---|---|
| accent (light) `#4a7c59` | `#fff` | 4.86:1 | pass |
| accent (dark) `#7ab087` | `#fff` (old) | 2.50:1 | **fail** |
| accent (dark) `#7ab087` | `#15211a` (new) | 6.63:1 | pass |
