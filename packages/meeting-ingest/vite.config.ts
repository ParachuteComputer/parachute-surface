import { defineConfig } from "vite";

/**
 * Vite config for the Meeting Ingest surface's small operator config page.
 *
 * Mount: `/surface/meeting-ingest/` (meta.json `path`) — assets resolve
 * under `/surface/meeting-ingest/assets/...` behind the host. Standalone dev
 * override via `VITE_BASE_PATH=/`. Build target: the package's own `dist/`
 * (what the host serves statically; `package.json#files` ships it).
 *
 * The page is a static setup/status doc — no framework, just `web/index.html`
 * plus a stylesheet. The webhook itself is backend-only (`server/`).
 */
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/surface/meeting-ingest/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
