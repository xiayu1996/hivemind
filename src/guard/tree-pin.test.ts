import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureTreePin, evaluateTreePin } from "./tree-pin.js";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "hivemind-tree-pin-"));
  tempDirs.push(cwd);
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "tree-pin@example.invalid");
  git(cwd, "config", "user.name", "Tree Pin Test");
  writeFileSync(join(cwd, ".gitignore"), "dist/\n", "utf8");
  writeFileSync(join(cwd, "tracked.txt"), "before\n", "utf8");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "base");
  return cwd;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("captureTreePin", () => {
  it("changes when a tracked file changes even if its status path was already present", () => {
    const cwd = repository();
    writeFileSync(join(cwd, "tracked.txt"), "code output\n", "utf8");
    const before = captureTreePin(cwd);
    writeFileSync(join(cwd, "tracked.txt"), "verify tampering\n", "utf8");
    const after = captureTreePin(cwd);
    expect(after.digest).not.toBe(before.digest);
  });

  it("includes untracked source content but ignores build output ignored by git", () => {
    const cwd = repository();
    const clean = captureTreePin(cwd);
    writeFileSync(join(cwd, "new-source.ts"), "export {};\n", "utf8");
    expect(captureTreePin(cwd).digest).not.toBe(clean.digest);

    const withSource = captureTreePin(cwd);
    mkdirSync(join(cwd, "dist"));
    writeFileSync(join(cwd, "dist", "generated.js"), "generated\n", "utf8");
    expect(captureTreePin(cwd)).toEqual(withSource);
  });
});

describe("evaluateTreePin", () => {
  it("invalidates the verdict and requires quarantine on a mismatch", () => {
    const result = evaluateTreePin(
      { head: "a", digest: "before" },
      { head: "a", digest: "after" },
    );
    expect(result).toEqual({ matches: false, verdictValid: false, quarantineRequired: true });
  });

  it("preserves the verdict when the tree is byte-identical", () => {
    const pin = { head: "a", digest: "same" };
    expect(evaluateTreePin(pin, pin)).toEqual({
      matches: true,
      verdictValid: true,
      quarantineRequired: false,
    });
  });
});
