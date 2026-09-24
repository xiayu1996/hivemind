import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All three shapes a Story has named a test file in. Widening this here
    // once is what keeps a card from having to widen it itself: two Epics
    // that chose differently conflict on this file, and the losing side's
    // tests then stop being collected without a failure to show for it.
    include: ["src/**/*.test.ts", "src/**/test_*.ts", "src/**/*_test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
