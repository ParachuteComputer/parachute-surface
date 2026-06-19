import { defineConfig } from "vite";

/**
 * Vite config for the Meeting MCP surface's small landing page.
 *
 * Mount: `/surface/meeting-mcp/` (meta.json `path`) — assets resolve under
 * `/surface/meeting-mcp/assets/...` behind the host. Standalone dev override
 * via `VITE_BASE_PATH=/`. Build target: the package's own `dist/` (what the
 * host serves statically; `package.json#files` ships it).
 *
 * The page is a static doc that points an MCP/REST client at the surface's
 * endpoint — no framework, just `web/index.html` plus a stylesheet. The
 * projections themselves are backend-only (`server/`).
 */
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/surface/meeting-mcp/");

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
