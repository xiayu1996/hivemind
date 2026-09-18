import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*_test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
