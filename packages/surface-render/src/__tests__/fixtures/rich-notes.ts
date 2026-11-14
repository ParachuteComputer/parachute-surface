/**
 * Made-up notes for the rich-view tests and screenshots. No real people,
 * recipes, clients or decisions.
 */
import type { NoteLike } from "../../note/NoteRenderer.js";

export const recipe: NoteLike = {
  id: "n-recipe",
  path: "Recipes/Lentil soup.md",
  updatedAt: "2026-11-12T18:00:00.000Z",
  tags: ["recipe", "soup"],
  metadata: { servings: 4, time: "50 min", source: "made up for this test" },
  content: `# Red lentil soup

A weeknight soup. Rinse the lentils well.

## Ingredients
- 1 cup red lentils
- 2 tbsp olive oil
- 1 onion, diced
- 4 cups vegetable stock
- 1 tsp cumin
- 1 lemon (for 2 tbsp juice)

## Steps
**Soften.** Warm the oil and cook the onion for 8 minutes.

**Simmer.** Add the lentils, stock and cumin; simmer 20 to 25 minutes.

**Finish.** Blend half, stir in the lemon juice, and season.

## Made
- 2026-11-02: first try; a little thin, used 3 1/2 cups stock next time.
`,
};

export const minutes: NoteLike = {
  id: "n-minutes",
  path: "Meetings/Garden club November.md",
  tags: ["minutes"],
  metadata: { date: "2026-11-10", body: "Garden club", quorum: 3 },
  content: `# Garden club: November

## Attendance
- Present: Ana Ruiz, Ben Cole, Cy Park, Dee Shah
- Regrets: Eli Moss

## Motions
1. Buy a second compost bin.
   Moved: Ana Ruiz. Seconded: Ben Cole.
   Vote: 3 for, 0 against, 1 abstain. Carried.

## Actions
- [ ] Order the bin @Ben due 2026-11-20
- [x] Send the minutes @Dee
`,
};

export const project: NoteLike = {
  id: "n-project",
  path: "Projects/Shed roof.md",
  updatedAt: "2026-11-12T10:00:00.000Z",
  content: `# Shed roof

> [!WARNING]
> Don't go up on the roof alone.

## Tasks
- [ ] Measure the roof @Sam due 2026-11-15
- [x] Buy felt @Jo

## Log
- 2026-11-03: found the leak above the door.
- 2026-11-08: bought felt and nails.

## Costs
| Month | Spent |
|---|---|
| Sep | 40 |
| Oct | 65 |
| Nov | 120 |

<details>
<summary>Old notes</summary>

The first roof went on in 2019.

</details>

See [[Tools list]].
`,
};

export const chant: NoteLike = {
  id: "n-chant",
  path: "Songs/Morning round.md",
  tags: ["chant"],
  content: `# Morning round

A made-up round for this test.

## Chart
\`\`\`chordpro
{key: C}
[C]Wake up [F]slow and [C]easy
[Am]Let the [G]day come [C]in
\`\`\`
`,
};

/** A note with no rich pattern: it must draw exactly as MarkdownView. */
export const plain: NoteLike = {
  id: "n-plain",
  path: "Ideas/Plain.md",
  tags: ["idea"],
  metadata: { status: "draft" },
  content: `# A plain note

Some **bold** text and a [link](https://example.org).

## Section

- one
- two
`,
};

/** Hostile lines, in a note that also uses rich patterns. */
export const hostile: NoteLike = {
  id: "n-hostile",
  path: "Inbox/Hostile.md",
  content: `# Hostile

- [ ] a task so the rich view draws this

![tracker](https://tracker.example/open.png)
![proto](//cdn.example/y.png)
![lookalike](https://evil.example/api/storage/pixel.png)
![data](data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/svg.png"/></svg>)

<img src="https://tracker.example/raw.png">
<iframe src="https://tracker.example/frame"></iframe>
<link rel="stylesheet" href="https://tracker.example/s.css">
<style>body{background:url(https://tracker.example/bg.png)}</style>
<audio src="https://tracker.example/a.mp3" autoplay></audio>
<video poster="https://tracker.example/p.png"></video>
<script>fetch("https://tracker.example/x")</script>
<a href="javascript:alert(1)">js</a>
[js link](javascript:alert(1))

> [!NOTE]
> <img src=x onerror="fetch('https://tracker.example/onerror')">
`,
};

export const RICH = { recipe, minutes, project, chant, hostile };
