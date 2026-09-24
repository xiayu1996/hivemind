import { describe, expect, it, vi } from "vitest";
import { testSubsetVerifier } from "./subset-verifier.js";

const CHECKS = [
  { name: "npm test", command: ["npm", "test"] },
  { name: "npm run e2e", command: ["npx", "tsx", "scripts/smoke-browser-e2e.ts"], when: ["src/web/**"] },
];

const REQUEST = {
  scenarioIds: ["S-M2-01-a", "S-M2-02-a"],
  candidate: { cwd: "/work/story", revision: "cafe1" },
  base: { cwd: "/work/epic", revision: "beef2" },
  changedPaths: ["src/api/coupon.ts", "src/web/page.tsx"],
};

describe("testSubsetVerifier", () => {
  it("runs the relevant checks on the tree that would be merged", async () => {
    const port = { run: vi.fn(async (_check: { name: string }, _cwd: string) => ({ passed: true, detail: "" })) };

    await expect(testSubsetVerifier(port, CHECKS)(REQUEST)).resolves.toEqual({
      passed: true,
      scenarioIds: ["S-M2-01-a", "S-M2-02-a"],
      ranChecks: ["npm test", "npm run e2e"],
    });
    expect(port.run.mock.calls.map(([, cwd]) => cwd)).toEqual(["/work/story", "/work/story"]);
  });

  it("skips a check the Story's changes cannot have affected", async () => {
    const port = { run: vi.fn(async () => ({ passed: true, detail: "" })) };

    const result = await testSubsetVerifier(port, CHECKS)({ ...REQUEST, changedPaths: ["docs/readme.md"] });
    expect(result).toMatchObject({ passed: true, ranChecks: ["npm test"] });
    expect(port.run).toHaveBeenCalledTimes(1);
  });

  it("calls a failure the Story's own when the Epic head is green", async () => {
    const port = {
      run: vi.fn(async (check: { name: string }, cwd: string) =>
        check.name === "npm test" && cwd === "/work/story"
          ? { passed: false, detail: " FAIL  src/coupon.test.ts > applies the discount\n" }
          : { passed: true, detail: "" }),
    };

    const result = await testSubsetVerifier(port, CHECKS)(REQUEST);
    expect(result).toMatchObject({
      passed: false,
      attribution: "story_regression",
      failures: ["src/coupon.test.ts > applies the discount"],
      failedChecks: ["npm test"],
    });
  });

  it("calls a failure the Epic head's own when the same test already fails there", async () => {
    const detail = " FAIL  src/runner/catalog-snapshot.test.ts > deepseek\n";
    const port = {
      run: vi.fn(async (check: { name: string }) =>
        check.name === "npm test" ? { passed: false, detail } : { passed: true, detail: "" }),
    };

    const result = await testSubsetVerifier(port, CHECKS)(REQUEST);
    expect(result).toMatchObject({
      passed: false,
      attribution: "baseline_failing",
      failures: ["src/runner/catalog-snapshot.test.ts > deepseek"],
    });
    expect(result.reasons?.[0]).toContain("without this Story");
  });

  it("runs the baseline only for a check that failed", async () => {
    const port = {
      run: vi.fn(async (check: { name: string }, cwd: string) =>
        check.name === "npm test" && cwd === "/work/story"
          ? { passed: false, detail: "not ok 1 - adds" }
          : { passed: true, detail: "" }),
    };

    await testSubsetVerifier(port, CHECKS)(REQUEST);
    expect(port.run.mock.calls.map(([check, cwd]) => `${check.name}@${cwd}`)).toEqual([
      "npm test@/work/story", "npm test@/work/epic", "npm run e2e@/work/story",
    ]);
  });

  it("charges nothing to the Story for a check that never ran", async () => {
    const port = {
      run: vi.fn(async (check: { name: string }) => check.name === "npm test"
        ? { passed: false, spawnError: true, detail: "spawn npm ENOENT" }
        : { passed: true, detail: "" }),
    };

    const result = await testSubsetVerifier(port, CHECKS)(REQUEST);
    expect(result).toMatchObject({ passed: false, attribution: "environment" });
    expect(port.run).toHaveBeenCalledTimes(2);
  });

  it("charges a regression it introduced over a head that was already red", async () => {
    const port = {
      run: vi.fn(async (check: { name: string }, cwd: string) => {
        if (check.name === "npm test") return { passed: false, detail: " FAIL  src/old.test.ts > stale\n" };
        return cwd === "/work/story"
          ? { passed: false, detail: " FAIL  src/new.test.ts > fresh\n" }
          : { passed: true, detail: "" };
      }),
    };

    await expect(testSubsetVerifier(port, CHECKS)(REQUEST)).resolves.toMatchObject({
      attribution: "story_regression",
      failedChecks: ["npm test", "npm run e2e"],
    });
  });

  it("refuses to call an unchecked merge verified", async () => {
    const port = { run: vi.fn(async () => ({ passed: true, detail: "" })) };

    const result = await testSubsetVerifier(port, [])(REQUEST);
    expect(result.passed).toBe(false);
    expect(result.reasons?.[0]).toContain("declares no check");
    expect(port.run).not.toHaveBeenCalled();
  });
});
