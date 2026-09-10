import { describe, expect, it } from "vitest";
import {
  collectCodeExitFacts,
  evaluateCodeExit,
  isTestPath,
  renderCodeExitFindings,
  scenarioMarkers,
  type CodeExitFacts,
} from "./code-exit-gate.js";

const SCENARIOS = ["S-DEMO-01-listing", "S-DEMO-01-failure"];

function facts(overrides: Partial<CodeExitFacts> = {}): CodeExitFacts {
  return {
    uncommittedPaths: [],
    commitCount: 4,
    whitespaceErrors: [],
    redScenarioIds: SCENARIOS,
    greenScenarioIds: SCENARIOS,
    markedScenarioIds: SCENARIOS,
    dodScenarioIds: SCENARIOS,
    projectChecks: [{ name: "npm test", passed: true, detail: "" }],
    ...overrides,
  };
}

describe("evaluateCodeExit", () => {
  it("refuses an artifact that leaves a round task unaccounted for, and names the tag", () => {
    const verdict = evaluateCodeExit(facts({
      roundTags: ["[answer:c-1]", "[scenario:S-DEMO-01-listing]"],
      artifactText: "Done.\naddressed [scenario:S-DEMO-01-listing]: the list now sorts by the latest event",
    }));
    expect(verdict.passed).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toContain("[answer:c-1]");
    expect(verdict.findings[0]).not.toContain("[scenario:S-DEMO-01-listing]");
  });

  it("passes when every tag has its addressed line, whatever the case", () => {
    const verdict = evaluateCodeExit(facts({
      roundTags: ["[answer:c-1]"],
      artifactText: "Addressed [Answer:c-1]: used the latest event as the person asked",
    }));
    expect(verdict.passed).toBe(true);
  });

  it("passes a phase that committed everything with red/green evidence per scenario", () => {
    expect(evaluateCodeExit(facts())).toEqual({ passed: true, findings: [] });
  });

  it("names the uncommitted files rather than saying the tree is dirty", () => {
    const verdict = evaluateCodeExit(facts({ uncommittedPaths: ["src/console/data.ts"] }));
    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("src/console/data.ts");
  });

  it("rejects a phase that committed nothing to the Story branch", () => {
    const verdict = evaluateCodeExit(facts({ commitCount: 0 }));
    expect(verdict.findings.some((finding) => finding.includes("no commit of its own"))).toBe(true);
  });

  it("reports what git diff --check rejected, which is where a read-only MERGE used to stop", () => {
    const verdict = evaluateCodeExit(facts({
      whitespaceErrors: ["src/console/libsql-data-source.ts:122: trailing whitespace."],
    }));
    expect(verdict.findings[0]).toContain("libsql-data-source.ts:122");
  });

  it("lists the scenarios with no failing-test evidence", () => {
    const verdict = evaluateCodeExit(facts({ redScenarioIds: ["S-DEMO-01-listing"] }));
    expect(verdict.findings[0]).toContain("S-DEMO-01-failure");
    expect(verdict.findings[0]).toContain("failed before the implementation");
  });

  it("lists the scenarios with no passing-test evidence", () => {
    const verdict = evaluateCodeExit(facts({ greenScenarioIds: [] }));
    expect(verdict.findings[0]).toContain("No passing-test evidence");
  });

  it("lists the scenarios no changed test file names", () => {
    const verdict = evaluateCodeExit(facts({ markedScenarioIds: ["S-DEMO-01-listing"] }));
    expect(verdict.findings[0]).toContain("S-DEMO-01-failure");
    expect(verdict.findings[0]).toContain("scenario id");
  });

  it("reports each failed repository check by name", () => {
    const verdict = evaluateCodeExit(facts({
      projectChecks: [
        { name: "npm run lint", passed: false, detail: "2 problems" },
        { name: "npm test", passed: true, detail: "" },
      ],
    }));
    expect(verdict.findings).toEqual(["npm run lint failed: 2 problems"]);
  });

  it("renders the findings as the list the CODE session is handed back", () => {
    const rendered = renderCodeExitFindings(evaluateCodeExit(facts({ commitCount: 0, greenScenarioIds: [] })));
    expect(rendered).toContain("1. ");
    expect(rendered).toContain("2. ");
  });
});

describe("scenario markers", () => {
  it("recognises test paths across the layouts a repository may use", () => {
    expect(isTestPath("src/console/data.test.ts")).toBe(true);
    expect(isTestPath("tests/console/listing.py")).toBe(true);
    expect(isTestPath("spec/models/user_spec.rb")).toBe(true);
    expect(isTestPath("src/console/data.ts")).toBe(false);
  });

  it("reads an annotation and a test name as the same marker", () => {
    expect(scenarioMarkers("// @scenario S-DEMO-01-listing")).toEqual(["S-DEMO-01-listing"]);
    expect(scenarioMarkers('it("S-DEMO-01-failure rejects a bad row", …)')).toEqual(["S-DEMO-01-failure"]);
  });
});

const responses = (whitespace?: string) => async (args: readonly string[]): Promise<string> => {
  const command = args.join(" ");
  if (command === "status --porcelain") return " M src/console/data.ts\n";
  if (command.startsWith("merge-base")) return "abc123\n";
  if (command.startsWith("log")) {
    return "test(S-DEMO-01-listing): red\nfeat(S-DEMO-01-listing): green\n";
  }
  if (command.startsWith("diff --name-only")) return "src/console/data.ts\nsrc/console/data.test.ts\n";
  if (command.startsWith("diff --check")) {
    if (!whitespace) return "";
    throw Object.assign(new Error("exit 1"), { stdout: whitespace });
  }
  throw new Error(`unexpected git command: ${command}`);
};

describe("collectCodeExitFacts", () => {
  it("measures the worktree instead of reading the session's account of it", async () => {
    const collected = await collectCodeExitFacts({
      git: { run: responses() },
      readWorktreeFile: async () => 'it("S-DEMO-01-listing works", …)',
      runCheck: async (check) => ({ passed: check.name === "npm test", detail: "lint output" }),
      baseRef: "main",
      dodScenarioIds: SCENARIOS,
      projectChecks: [{ name: "npm test", command: ["npm", "test"] }, { name: "npm run lint", command: ["npm", "run", "lint"] }],
    });

    expect(collected).toMatchObject({
      uncommittedPaths: ["src/console/data.ts"],
      commitCount: 2,
      redScenarioIds: ["S-DEMO-01-listing"],
      greenScenarioIds: ["S-DEMO-01-listing"],
      markedScenarioIds: ["S-DEMO-01-listing"],
      whitespaceErrors: [],
    });
    expect(collected.projectChecks).toEqual([
      { name: "npm test", passed: true, detail: "lint output" },
      { name: "npm run lint", passed: false, detail: "lint output" },
    ]);
  });

  it("keeps the lines git diff --check printed on its way out", async () => {
    const collected = await collectCodeExitFacts({
      git: { run: responses("src/a.ts:12: trailing whitespace.\n") },
      readWorktreeFile: async () => "",
      runCheck: async () => ({ passed: true, detail: "" }),
      baseRef: "main",
      dodScenarioIds: [],
      projectChecks: [],
    });
    expect(collected.whitespaceErrors).toEqual(["src/a.ts:12: trailing whitespace."]);
  });

  it("takes a test file it can no longer read as carrying no marker", async () => {
    const collected = await collectCodeExitFacts({
      git: { run: responses() },
      readWorktreeFile: async () => { throw new Error("ENOENT"); },
      runCheck: async () => ({ passed: true, detail: "" }),
      baseRef: "main",
      dodScenarioIds: SCENARIOS,
      projectChecks: [],
    });
    expect(collected.markedScenarioIds).toEqual([]);
  });
});
