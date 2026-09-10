import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateVerdict, type VerdictInput } from "./verdict.js";

const tempDirs: string[] = [];

function fixture(): { root: string; screenshot: string; input: VerdictInput } {
  const root = mkdtempSync(join(tmpdir(), "hivemind-verdict-"));
  tempDirs.push(root);
  const evidence = join(root, "evidence");
  mkdirSync(evidence);
  const screenshot = join(evidence, "checkout.png");
  writeFileSync(screenshot, Buffer.from([1, 2, 3]));
  const now = Date.now();
  return {
    root,
    screenshot,
    input: {
      verdict: {
        scenarios: [{ id: "S-EPIC12-03-a", status: "passed", url: "https://app.example.test/checkout", screenshots: [screenshot] }],
      },
      declaredScenarioIds: ["S-EPIC12-03-a"],
      trajectory: [{ type: "test_result", scenarioId: "S-EPIC12-03-a", status: "passed" }],
      commitMessages: [],
      evidenceRoot: evidence,
      allowedHosts: ["app.example.test"],
      roundStartedAt: now - 1_000,
      roundEndedAt: now + 1_000,
    },
  };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("validateVerdict", () => {
  it("rejects a self-reported pass with no trajectory evidence", async () => {
    const { input } = fixture();
    input.trajectory = [{ type: "assistant_claim", scenarioId: "S-EPIC12-03-a", status: "passed" }];
    const result = await validateVerdict(input);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("S-EPIC12-03-a: no passing test result exists in the trajectory");
  });

  it("rejects a non-whitelisted URL and a stale screenshot", async () => {
    const { input, screenshot } = fixture();
    input.verdict.scenarios[0]!.url = "file:///tmp/fake.html";
    utimesSync(screenshot, new Date(0), new Date(0));
    const result = await validateVerdict(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("URL host"))).toBe(true);
    expect(result.errors.some((error) => error.includes("mtime"))).toBe(true);
  });

  it("refuses a screen scenario judged without a page or a screenshot of its own", async () => {
    const { input, screenshot } = fixture();
    input.screenScenarioIds = ["S-EPIC12-03-a", "S-EPIC12-03-b"];
    input.declaredScenarioIds = ["S-EPIC12-03-a", "S-EPIC12-03-b"];
    input.trajectory.push({ type: "test_result", scenarioId: "S-EPIC12-03-b", status: "passed" });
    // The same file under both scenarios is one look, not two.
    input.verdict.scenarios.push({ id: "S-EPIC12-03-b", status: "passed", screenshots: [screenshot] });
    const result = await validateVerdict(input);
    expect(result.unproven).toEqual(["S-EPIC12-03-a", "S-EPIC12-03-b"]);
    expect(result.errors).toContain(
      "S-EPIC12-03-b: no screen evidence of its own was left for this scenario (no page was reported; no screenshot belongs to it alone)",
    );
  });

  it("leaves a screen scenario alone when it has its own page and screenshot, or was inconclusive", async () => {
    const { input } = fixture();
    input.screenScenarioIds = ["S-EPIC12-03-a", "S-EPIC12-03-b"];
    input.declaredScenarioIds = ["S-EPIC12-03-a", "S-EPIC12-03-b"];
    input.verdict.scenarios.push({ id: "S-EPIC12-03-b", status: "inconclusive", reason: "the page never loaded" });
    const result = await validateVerdict(input);
    expect(result.unproven).toEqual([]);
  });

  it("accepts real evidence but escalates when no red baseline can be mined", async () => {
    const { input } = fixture();
    const result = await validateVerdict(input);
    expect(result.valid).toBe(true);
    expect(result.requiresBlindReview).toBe(true);
    expect(result.greenEvidence).toEqual(["S-EPIC12-03-a"]);
    expect(result.redEvidence).toEqual([]);
  });

  it("finds red and green evidence across trajectory and git history", async () => {
    const { input } = fixture();
    input.trajectory.unshift({ type: "test_result", scenarioId: "S-EPIC12-03-a", status: "failed" });
    input.commitMessages = ["feat(S-EPIC12-03-a): green"];
    const result = await validateVerdict(input);
    expect(result).toMatchObject({ valid: true, requiresBlindReview: false });
    expect(result.redEvidence).toEqual(["S-EPIC12-03-a"]);
    expect(result.greenEvidence).toEqual(["S-EPIC12-03-a"]);
  });
});
