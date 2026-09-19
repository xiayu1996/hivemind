import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/test_*.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
