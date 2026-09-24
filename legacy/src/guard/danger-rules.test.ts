import { describe, expect, it } from "vitest";
import {
  BANNED_BASH,
  DEFAULT_FENCED_PATTERNS,
  checkBash,
  checkFilePath,
  isWithinRoot,
  toPosixPath,
} from "./danger-rules.js";

describe("red lines", () => {
  const banned = [
    "rm -rf /",
    "rm  -rf node_modules",
    "git push origin master",
    "git push origin main --force",
    "gh pr merge 12",
    "gh workflow run deploy.yml",
    "glab mr merge !5",
    "glab ci play 123",
  ];

  for (const command of banned) {
    it(`denies ${command}`, () => {
      expect(checkBash(command).deny).toBe(true);
    });
  }

  it("gives every denial a reason so the model can pick another approach", () => {
    for (const command of banned) {
      expect(checkBash(command).reason).toBeTruthy();
    }
  });

  it("catches rm variants the single -[rf] form missed", () => {
    // -Rf, long flags and split flags are the same irreversible operation.
    for (const command of ["rm -Rf build", "rm --recursive dist", "rm --force x", "rm -r -f y"]) {
      expect(checkBash(command).deny).toBe(true);
    }
  });

  it("denies a force push to a branch that is not main", () => {
    // A story branch is not protected, but a bare force push still destroys
    // history another worker may be standing on.
    expect(checkBash("git push -f origin story/epic-3-12").deny).toBe(true);
    expect(checkBash("git push --force origin epic/3").deny).toBe(true);
  });

  it("matches the protected branch as a whole ref token", () => {
    expect(checkBash("git push origin HEAD:main").deny).toBe(true);
    expect(checkBash("git push --set-upstream origin master").deny).toBe(true);
    // A branch that merely contains the word is not the protected branch.
    expect(checkBash("git push origin story/main-refactor").deny).toBe(false);
    expect(checkBash("git push origin epic/domain-model").deny).toBe(false);
  });

  it("allows --force-with-lease, which aborts when the remote moved", () => {
    expect(checkBash("git push --force-with-lease origin story/epic-3-12").deny).toBe(false);
  });
});

describe("everything else runs", () => {
  for (const command of [
    "ls -la",
    "git log --oneline -5",
    "git status --porcelain",
    "git diff HEAD",
    "grep -r foo src",
    "npm ci",
    "npm run test",
    "npx tsc --noEmit",
    "gh pr create --fill",
    "gh pr view 12",
    "glab mr create",
    "curl -s http://localhost:8080/health",
    "python script.py",
  ]) {
    it(`allows ${command}`, () => {
      expect(checkBash(command).deny).toBe(false);
    });
  }
});

describe("worktree containment", () => {
  it("denies a write that escapes the worktree", () => {
    expect(checkFilePath("/etc/passwd", "/wt/task-1").deny).toBe(true);
  });

  it("allows a write inside the worktree", () => {
    expect(checkFilePath("src/Main.java", "/wt/task-1").deny).toBe(false);
  });

  it("denies a sibling directory that shares the prefix string", () => {
    expect(checkFilePath("/wt/task-10/x.ts", "/wt/task-1").deny).toBe(true);
  });

  it("denies ../ traversal out of the worktree", () => {
    const verdict = checkFilePath("src/../../outside.ts", "/wt/task-1");
    expect(verdict).toEqual({ deny: true, reason: "path escapes worktree" });
  });
});

describe("extra write roots", () => {
  const roots = ["/ev/card-42"];

  it("allows writes into a whitelisted evidence directory", () => {
    expect(checkFilePath("/ev/card-42/screenshots/S1.png", "/wt/task-1", roots).deny).toBe(false);
  });

  it("still denies other escaping paths", () => {
    expect(checkFilePath("/etc/passwd", "/wt/task-1", roots).deny).toBe(true);
    expect(checkFilePath("/ev/card-1/x.png", "/wt/task-1", roots).deny).toBe(true);
    expect(checkFilePath("/ev/card-420/x.png", "/wt/task-1", roots).deny).toBe(true);
  });

  it("denies ../ traversal out of a whitelisted root", () => {
    const verdict = checkFilePath("/ev/card-42/../card-1/evil.png", "/wt/task-1", roots);
    expect(verdict).toEqual({ deny: true, reason: "path escapes worktree" });
  });

  it("keeps the fenced check ahead of the whitelist", () => {
    const verdict = checkFilePath("/ev/card-42/.claude/rules/core.md", "/wt/task-1", roots);
    expect(verdict).toEqual({ deny: true, reason: "fenced file" });
  });
});

describe("fenced files", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    "deploy/k8s/production/app.yml",
    ".claude/rules/core.md",
    ".agents/notes/x.md",
    "CLAUDE.md",
    "AGENTS.md",
  ]) {
    it(`denies ${path} even inside the worktree`, () => {
      expect(checkFilePath(path, "/wt/task-1").deny).toBe(true);
    });
  }

  it("allows a file whose name merely resembles a fenced one", () => {
    expect(checkFilePath("docs/CLAUDE-notes.md", "/wt/task-1").deny).toBe(false);
    expect(checkFilePath("src/github/workflows.ts", "/wt/task-1").deny).toBe(false);
  });

  it("accepts a caller-supplied pattern set so per-phase policy can extend it", () => {
    const extra = [...DEFAULT_FENCED_PATTERNS, /(^|\/)secrets\//];
    expect(checkFilePath("secrets/key.pem", "/wt/task-1", [], extra).deny).toBe(true);
    expect(checkFilePath("secrets/key.pem", "/wt/task-1").deny).toBe(false);
  });
});

describe("windows paths", () => {
  it("normalises backslashes so one rule set matches on every platform", () => {
    expect(toPosixPath("a\\b\\c.md")).toBe("a/b/c.md");
  });

  it("denies a fenced file written with backslash separators", () => {
    // The original rules were written with `/` only, so a Windows agent walked
    // straight through them.
    for (const path of [
      ".claude\\rules\\core.md",
      ".github\\workflows\\ci.yml",
      "deploy\\k8s\\production\\app.yml",
      "sub\\dir\\CLAUDE.md",
    ]) {
      expect(checkFilePath(path, "C:\\wt\\task-1").deny).toBe(true);
    }
  });

  it("denies fenced files regardless of case", () => {
    // macOS and Windows resolve these to the same file as the lowercase form.
    expect(checkFilePath(".GitHub/Workflows/ci.yml", "/wt/task-1").deny).toBe(true);
    expect(checkFilePath("claude.md", "/wt/task-1").deny).toBe(true);
  });

  it("treats a drive-letter casing difference as the same root", () => {
    expect(isWithinRoot("C:/wt/task-1/src/a.ts", "c:/WT/task-1", true)).toBe(true);
    expect(isWithinRoot("C:/wt/task-1/src/a.ts", "c:/WT/task-1", false)).toBe(false);
  });

  it("does not let case-insensitive comparison widen the root", () => {
    expect(isWithinRoot("C:/wt/task-10/a.ts", "c:/wt/task-1", true)).toBe(false);
  });
});

describe("rule table", () => {
  it("pairs every pattern with a reason", () => {
    for (const [pattern, reason] of BANNED_BASH) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
