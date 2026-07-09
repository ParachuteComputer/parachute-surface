import type { ManifestOptions } from "vite-plugin-pwa";

// Build the PWA manifest at config-load time. `id`/`start_url`/`scope` must
// reflect the deployed base path; otherwise an installed PWA would launch at
// `/` and 404 when Notes is mounted under e.g. `/notes/`.
export function buildPwaManifest(base = "/"): Partial<ManifestOptions> {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return {
    id: normalized,
    name: "Parachute Notes",
    short_name: "Notes",
    description:
      "The default frontend for Parachute. Browse, edit, and capture in any Parachute Vault.",
    // New-brand pass (0.1.21): coral accent + warm paper, mirroring the CSS
    // token values (--color-accent / --color-bg light theme).
    theme_color: "#bf4a2a",
    background_color: "#fdfaf4",
    display: "standalone",
    orientation: "any",
    start_url: normalized,
    scope: normalized,
    // Icon `src` values are intentionally bare (no leading `/`). They resolve
    // relative to the manifest URL, which itself sits under the deployed base
    // path (e.g. `/notes/manifest.webmanifest`). That keeps the icons portable
    // across mounts without rewriting each path — don't add a leading slash.
    icons: [
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "maskable-icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

// Default-base export retained as a convenience and for tests that exercise
// the manifest shape without needing a base path argument.
export const PWA_MANIFEST: Partial<ManifestOptions> = buildPwaManifest("/");
