import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    css: false,
    // `.claude/` may host an untracked agent worktree (duplicate source copies);
    // exclude so vitest doesn't run those duplicates as tests.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
