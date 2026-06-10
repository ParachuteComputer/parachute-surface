import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the Docs surface frontend.
 *
 * Mount: `/surface/docs/` (meta.json `path`) — assets resolve under
 * `/surface/docs/assets/...` behind the host. Standalone dev override via
 * `VITE_BASE_PATH=/`. Build target: the package's own `dist/` (what the
 * host serves; `package.json#files` ships it).
 */
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/surface/docs/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
