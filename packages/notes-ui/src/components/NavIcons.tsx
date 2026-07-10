// Shared inline nav glyphs for the desktop Rail and the mobile BottomTabBar.
// lucide-react isn't a dependency and keeps the bundle tight — these are the
// same 24-grid, 1.75-stroke line icons used across the chrome. Rendered at
// 20px; size via a wrapping element if a surface needs a different scale.

import type { SVGProps } from "react";

const BASE: SVGProps<SVGSVGElement> = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function IconHome(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} aria-hidden="true" {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </svg>
  );
}

export function IconNotes(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} aria-hidden="true" {...props}>
      <path d="M5 3.5h11l3 3V20.5H5z" />
      <path d="M15.5 3.5V7h3.5" />
      <path d="M8 11h8M8 14.5h8M8 17.5h5" />
    </svg>
  );
}

export function IconTag(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} aria-hidden="true" {...props}>
      <path d="M20.5 12.5 12.5 20.5a2 2 0 0 1-2.83 0L3 13.83V3h10.83L20.5 9.67a2 2 0 0 1 0 2.83Z" />
      <circle cx="7.5" cy="7.5" r="1.25" fill="currentColor" />
    </svg>
  );
}

export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} aria-hidden="true" {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} aria-hidden="true" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconCog(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9 1.7 1.7 0 0 0 4.26 7.13L4.2 7.07A2 2 0 1 1 7.03 4.24l.06.06A1.7 1.7 0 0 0 9 4.64 1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1h.04a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}

// A one-hub / three-satellite relational glyph — the Map mark.
export function IconMap(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...BASE} strokeWidth={1.6} aria-hidden="true" {...props}>
      <line x1="12" y1="12" x2="5" y2="5.5" />
      <line x1="12" y1="12" x2="19" y2="6.5" />
      <line x1="12" y1="12" x2="17" y2="18.5" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19.5" cy="6" r="2" />
      <circle cx="17.5" cy="19" r="2" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
