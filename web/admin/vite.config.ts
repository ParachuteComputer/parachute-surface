import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for parachute-app's admin SPA.
 *
 * Mount: `/surface/admin/` — owned by parachute-app's HTTP server. Asset URLs
 * resolve under `/surface/admin/assets/...` in production; standalone dev (no
 * daemon) override via `VITE_BASE_PATH=/`.
 *
 * Build target: `../../packages/surface-host/dist/admin/` — sits inside the
 * `@openparachute/surface` package's root `dist/` so `package.json#files`
 * picks it up as `dist/admin/**`. The daemon's `defaultAdminDir()`
 * resolves to `<app-host-package-root>/dist/admin/`. (Pre-monorepo
 * this lived at `../../dist/admin/`; the path moved with the host code
 * into `packages/surface-host/` during Phase 2.0.)
 */
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/surface/admin/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  build: {
    outDir: "../../packages/surface-host/dist/admin",
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    proxy: {
      // Dev server runs under /surface/admin/; the daemon's admin endpoints
      // live under /surface/* without the /admin/ segment. Proxy non-SPA paths
      // back to the running daemon (assumes 127.0.0.1:1946 by default).
      "/surface/list": {
        target: process.env.APP_ORIGIN ?? "http://127.0.0.1:1946",
        changeOrigin: true,
      },
      "/surface/add": {
        target: process.env.APP_ORIGIN ?? "http://127.0.0.1:1946",
        changeOrigin: true,
      },
      "/.parachute": {
        target: process.env.APP_ORIGIN ?? "http://127.0.0.1:1946",
        changeOrigin: true,
      },
    },
  },
});
