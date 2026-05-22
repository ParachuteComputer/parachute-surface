import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for parachute-app's admin SPA.
 *
 * Mount: `/app/admin/` — owned by parachute-app's HTTP server. Asset URLs
 * resolve under `/app/admin/assets/...` in production; standalone dev (no
 * daemon) override via `VITE_BASE_PATH=/`.
 *
 * Build target: `../../packages/app-host/dist/admin/` — sits inside the
 * `@openparachute/app` package's root `dist/` so `package.json#files`
 * picks it up as `dist/admin/**`. The daemon's `defaultAdminDir()`
 * resolves to `<app-host-package-root>/dist/admin/`. (Pre-monorepo
 * this lived at `../../dist/admin/`; the path moved with the host code
 * into `packages/app-host/` during Phase 2.0.)
 */
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/app/admin/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  build: {
    outDir: "../../packages/app-host/dist/admin",
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    proxy: {
      // Dev server runs under /app/admin/; the daemon's admin endpoints
      // live under /app/* without the /admin/ segment. Proxy non-SPA paths
      // back to the running daemon (assumes 127.0.0.1:1946 by default).
      "/app/list": {
        target: process.env.APP_ORIGIN ?? "http://127.0.0.1:1946",
        changeOrigin: true,
      },
      "/app/add": {
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
