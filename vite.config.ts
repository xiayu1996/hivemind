import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * The console SPA builds into `console-ui/dist`, which the orchestrator serves
 * from the same process that holds the central store. `root` is the console's
 * own directory so the shell and its sources stay together.
 */
export default defineConfig({
  root: "console-ui",
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:3212" },
  },
});
