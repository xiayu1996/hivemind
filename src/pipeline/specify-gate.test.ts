import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { specifyGatePorts } from "./specify-gate.js";

const tempDirs: string[] = [];
const TEST_PATHS = ["**/*.test.*", "test/**", "tests/**"];

function run(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "hivemind-specify-gate-"));
  tempDirs.push(cwd);
  run(cwd, ["init", "--quiet", "-b", "main"]);
  run(cwd, ["config", "user.email", "specify-gate@example.invalid"]);
  run(cwd, ["config", "user.name", "Specify Gate Test"]);
  mkdirSync(join(cwd, "test"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "price.ts"), "export const price = 100;\n", "utf8");
  writeFileSync(join(cwd, "test", "orders.test.ts"), "// @scenario S-EPIC1-01-b\n", "utf8");
  run(cwd, ["add", "--all"]);
  run(cwd, ["commit", "--quiet", "-m", "base"]);
  return cwd;
}

function gate(cwd: string, stdout = "") {
  return specifyGatePorts({
    worktreePath: cwd,
    git: async (args) => run(cwd, args),
    command: { run: async () => ({ stdout, stderr: "", ok: false }) },
    testCommand: stdout === "" ? [] : ["npm", "test"],
    testPathPatterns: TEST_PATHS,
  });
}

function head(cwd: string): string {
  return run(cwd, ["rev-parse", "HEAD"]).trim();
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("the repository side of the SPECIFY exit", () => {
  it("reports committed, staged and untracked changes alike, and says which existed before", async () => {
    const cwd = repository();
    const base = head(cwd);
    writeFileSync(join(cwd, "src", "price.ts"), "export const price = 90;\n", "utf8");
    run(cwd, ["commit", "--quiet", "--all", "-m", "trespass"]);
    writeFileSync(join(cwd, "test", "price.test.ts"), "// @scenario S-EPIC1-01-a\n", "utf8");

    await expect(gate(cwd).changedPaths(base)).resolves.toEqual([
      { path: "src/price.ts", existedBefore: true },
      { path: "test/price.test.ts", existedBefore: false },
    ]);
  });

  it("puts a trespassed file back and deletes one the baseline never had", async () => {
    const cwd = repository();
    const base = head(cwd);
    writeFileSync(join(cwd, "src", "price.ts"), "export const price = 90;\n", "utf8");
    writeFileSync(join(cwd, "src", "coupon.ts"), "export const coupon = 10;\n", "utf8");

    await gate(cwd).revert(base, ["src/price.ts", "src/coupon.ts"]);

    expect(readFileSync(join(cwd, "src", "price.ts"), "utf8")).toBe("export const price = 100;\n");
    expect(existsSync(join(cwd, "src", "coupon.ts"))).toBe(false);
  });

  it("reads only the test paths, so a marker in source proves nothing", async () => {
    const cwd = repository();
    writeFileSync(join(cwd, "src", "price.ts"), "// @scenario S-EPIC1-01-a\n", "utf8");
    writeFileSync(join(cwd, "test", "price.test.ts"), "// @scenario S-EPIC1-01-a\n", "utf8");
    run(cwd, ["add", "--all"]);

    const sources = await gate(cwd).readTestSources();

    expect(sources.map((source) => source.path)).toEqual(["test/orders.test.ts", "test/price.test.ts"]);
  });

  it("refuses to prove a red in a repository that declares no test command", async () => {
    const cwd = repository();
    await expect(gate(cwd).runTests()).rejects.toThrow(/declares no specifyExit.testCommand/);
  });

  it("reads the red out of the runner's report rather than out of its exit code", async () => {
    const cwd = repository();
    const output = `Running tests...\n${JSON.stringify({
      testResults: [{
        name: join(cwd, "test", "price.test.ts"),
        assertionResults: [
          { fullName: "prices an order with no coupon", status: "passed" },
          {
            fullName: "@scenario S-EPIC1-01-a deducts the coupon once",
            status: "failed",
            failureMessages: [`AssertionError: expected 100 to be 90\n    at ${join(cwd, "test", "price.test.ts")}:12:9`],
          },
        ],
      }],
    })}`;

    const report = await gate(cwd, output).runTests();

    expect(report.passed).toContain("prices an order with no coupon");
    // Repository-relative, because that is what the contract names.
    expect(report.failures[0]).toMatchObject({
      file: "test/price.test.ts:12",
      kind: "assertion",
      scenarioIds: ["S-EPIC1-01-a"],
    });
  });

  it("commits everything and answers with the tree it froze", async () => {
    const cwd = repository();
    writeFileSync(join(cwd, "test", "price.test.ts"), "// @scenario S-EPIC1-01-a\n", "utf8");
    const ports = gate(cwd);

    const proof = await ports.currentTreeSha();
    const frozen = await ports.commit("test(S-EPIC1-01): red");

    // The same tree: nothing may move between proving red and freezing it.
    expect(frozen.treeSha).toBe(proof);
    expect(frozen.commit).toBe(head(cwd));
    await expect(ports.isClean()).resolves.toBe(true);
  });

  it("sees the tree move when a file changes after the red was proved", async () => {
    const cwd = repository();
    const ports = gate(cwd);
    const proof = await ports.currentTreeSha();
    writeFileSync(join(cwd, "test", "price.test.ts"), "// @scenario S-EPIC1-01-a\n", "utf8");

    expect((await ports.commit("test(S-EPIC1-01): red")).treeSha).not.toBe(proof);
  });
});
