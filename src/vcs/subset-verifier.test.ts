import { describe, expect, it, vi } from "vitest";
import { testSubsetVerifier } from "./subset-verifier.js";

const CHECKS = [
  { name: "npm test", command: ["npm", "test"] },
  { name: "npm run e2e", command: ["npx", "tsx", "scripts/smoke-browser-e2e.ts"] },
];

describe("testSubsetVerifier", () => {
  it("runs every declared check on the integration branch and passes the subset", async () => {
    const port = { run: vi.fn(async () => ({ passed: true, detail: "" })) };

    await expect(testSubsetVerifier(port, CHECKS)(["S-M2-01-a", "S-M2-02-a"]))
      .resolves.toEqual({ passed: true, scenarioIds: ["S-M2-01-a", "S-M2-02-a"] });
    expect(port.run).toHaveBeenCalledTimes(2);
  });

  it("fails the whole subset with the failing check's output as the reason", async () => {
    const port = {
      run: vi.fn(async (check: { name: string }) => check.name === "npm test"
        ? { passed: false, detail: "2 failed" }
        : { passed: true, detail: "" }),
    };

    await expect(testSubsetVerifier(port, CHECKS)(["S-M2-01-a"])).resolves.toEqual({
      passed: false,
      scenarioIds: ["S-M2-01-a"],
      reasons: ["npm test failed on the integration branch: 2 failed"],
    });
  });

  it("refuses to call an unchecked merge verified", async () => {
    const port = { run: vi.fn(async () => ({ passed: true, detail: "" })) };

    const result = await testSubsetVerifier(port, [])(["S-M2-01-a"]);
    expect(result.passed).toBe(false);
    expect(result.reasons?.[0]).toContain("declares no check");
    expect(port.run).not.toHaveBeenCalled();
  });
});
