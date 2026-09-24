import { describe, expect, it } from "vitest";
import {
  BANNED_BASH,
  DEFAULT_FENCED_PATTERNS,
  checkBash,
  checkFilePath,
  isWithinRoot,
  joinLineContinuations,
  toPosixPath,
} from "./danger-rules.ts";

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

  it("catches a recursive or forced flag wherever it sits in the rm invocation", () => {
    // GNU rm accepts options after the operand, and a harmless first flag used
    // to hide the dangerous one behind it.
    for (const command of ["rm -v -rf build", "rm build -rf", "rm -i -r x", "sudo rm -v --force x"]) {
      expect(checkBash(command).deny).toBe(true);
    }
    expect(checkBash("rm build/a.txt && ls -R build").deny).toBe(false);
    expect(checkBash("rm -i build/a.txt").deny).toBe(false);
  });

  it("denies a force push to a branch that is not main", () => {
    // A story branch is not protected, but a bare force push still destroys
    // history another worker may be standing on.
    expect(checkBash("git push -f origin story/epic-3-12").deny).toBe(true);
    expect(checkBash("git push --force origin epic/3").deny).toBe(true);
  });

  it("denies a force push spelled as a combined flag or a + refspec", () => {
    for (const command of ["git push -fu origin story/x", "git push -uf origin story/x", "git push origin +HEAD:story/x"]) {
      expect(checkBash(command).deny).toBe(true);
    }
    expect(checkBash("git push -u origin story/x").deny).toBe(false);
    expect(checkBash("git push --follow-tags origin story/x").deny).toBe(false);
  });

  it("matches the protected branch as a whole ref token", () => {
    expect(checkBash("git push origin HEAD:main").deny).toBe(true);
    expect(checkBash("git push --set-upstream origin master").deny).toBe(true);
    // A branch that merely contains the word is not the protected branch.
    expect(checkBash("git push origin story/main-refactor").deny).toBe(false);
    expect(checkBash("git push origin epic/domain-model").deny).toBe(false);
    expect(checkBash("git push origin mainline").deny).toBe(false);
  });

  it("still names the protected branch when it is quoted, fully spelled or followed by a separator", () => {
    for (const command of [
      "git push origin main; echo pushed",
      'git push origin "main"',
      "git push origin HEAD:refs/heads/main",
      "git -C /wt/task-1 push origin main",
      "git -C /wt/task-1 push --force origin story/x",
    ]) {
      expect(checkBash(command).deny).toBe(true);
    }
  });

  it("does not read a later command in the same line as part of the push", () => {
    expect(checkBash("git push origin story/x && git checkout main").deny).toBe(false);
  });

  it("allows --force-with-lease, which aborts when the remote moved", () => {
    expect(checkBash("git push --force-with-lease origin story/epic-3-12").deny).toBe(false);
  });

  it("judges a command split across lines as bash joins it", () => {
    expect(joinLineContinuations("git push \\\n  --force origin x")).toBe("git push   --force origin x");
    expect(checkBash("git push \\\n  --force origin story/x").deny).toBe(true);
    expect(checkBash("rm \\\n  -rf build").deny).toBe(true);
    // A plain newline separates two commands; neither is a push to main.
    expect(checkBash("git push origin story/x\necho main").deny).toBe(false);
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
    "rmdir build",
  ]) {
    it(`allows ${command}`, () => {
      expect(checkBash(command).deny).toBe(false);
    });
  }
});

describe("workspace containment", () => {
  it("denies a write that escapes the workspace", () => {
    expect(checkFilePath("/etc/passwd", "/wt/task-1").deny).toBe(true);
  });

  it("allows a write inside the workspace", () => {
    expect(checkFilePath("src/Main.java", "/wt/task-1").deny).toBe(false);
  });

  it("denies a sibling directory that shares the prefix string", () => {
    expect(checkFilePath("/wt/task-10/x.ts", "/wt/task-1").deny).toBe(true);
  });

  it("denies ../ traversal out of the workspace, and says what to do instead", () => {
    expect(checkFilePath("src/../../outside.ts", "/wt/task-1")).toEqual({
      deny: true,
      reason: expect.stringContaining("relative to the workspace root"),
    });
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
    it(`denies ${path} even inside the workspace`, () => {
      expect(checkFilePath(path, "/wt/task-1").deny).toBe(true);
    });
  }

  it("tells the model to leave a fenced file alone", () => {
    expect(checkFilePath("CLAUDE.md", "/wt/task-1").reason).toContain("leave it unchanged");
  });

  it("allows a file whose name merely resembles a fenced one", () => {
    expect(checkFilePath("docs/CLAUDE-notes.md", "/wt/task-1").deny).toBe(false);
    expect(checkFilePath("src/github/workflows.ts", "/wt/task-1").deny).toBe(false);
  });

  it("denies a spelling that resolves onto a fenced file without naming one", () => {
    for (const path of [
      ".claude//rules/core.md",
      "CLAUDE.md/.",
      ".github/x/../workflows/ci.yml",
      "/wt/task-1/./AGENTS.md",
    ]) {
      expect(checkFilePath(path, "/wt/task-1").deny).toBe(true);
    }
  });

  it("accepts a caller-supplied pattern set so a policy can extend it", () => {
    const extra = [...DEFAULT_FENCED_PATTERNS, /(^|\/)secrets\//];
    expect(checkFilePath("secrets/key.pem", "/wt/task-1", extra).deny).toBe(true);
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

  it("keeps every pattern stateless, so one test cannot change the next", () => {
    // A global or sticky regex carries lastIndex between calls to test().
    for (const pattern of [...BANNED_BASH.map(([rule]) => rule), ...DEFAULT_FENCED_PATTERNS]) {
      expect(pattern.global || pattern.sticky).toBe(false);
    }
  });
});
