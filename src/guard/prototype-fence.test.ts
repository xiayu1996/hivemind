import { describe, expect, it } from "vitest";
import { checkFilePath } from "./danger-rules.js";
import { prototypeFencePatterns } from "./prototype-fence.js";

const WORKTREE = "/work/trees/R-1";

function allowed(path: string, root = "docs/prototype"): boolean {
  const patterns = prototypeFencePatterns(root).map((source) => new RegExp(source));
  return !checkFilePath(path, WORKTREE, [], patterns).deny;
}

describe("prototypeFencePatterns", () => {
  it("lets the drawing write the contract, by relative and absolute path alike", () => {
    expect(allowed("docs/prototype/tokens.json")).toBe(true);
    expect(allowed("docs/prototype/pages/board.html")).toBe(true);
    expect(allowed(`${WORKTREE}/docs/prototype/design.md`)).toBe(true);
  });

  it("refuses the product itself, which is not this phase's to start", () => {
    expect(allowed("src/app.ts")).toBe(false);
    expect(allowed("package.json")).toBe(false);
    expect(allowed(`${WORKTREE}/src/app.ts`)).toBe(false);
  });

  it("refuses a path that walks back out of the contract", () => {
    expect(allowed("docs/prototype/../../src/app.ts")).toBe(false);
    expect(allowed("docs/prototype/..")).toBe(false);
  });

  it("refuses a directory whose name merely starts the same way", () => {
    expect(allowed("docs/prototype-notes/plan.md")).toBe(false);
  });

  it("fences against the configured root, not a hard-coded one", () => {
    expect(allowed("design/contract/tokens.json", "design/contract")).toBe(true);
    expect(allowed("docs/prototype/tokens.json", "design/contract")).toBe(false);
  });
});
