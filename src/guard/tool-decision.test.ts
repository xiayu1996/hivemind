import { describe, expect, it } from "vitest";
import { DEFAULT_FENCED_PATTERNS } from "./danger-rules.js";
import { compileBannedBashPatterns, compileFencedPatterns, type GuardPolicy } from "./policy.js";
import { decideToolCall, type ToolCallEvent } from "./tool-decision.js";

const policy: GuardPolicy = {
  phase: "CODE",
  cardId: "S-12",
  runId: "run-1",
  worktreePath: "/wt/task-1",
  extraWriteRoots: ["/ev/card-12"],
  disallowedTools: [],
  fencedPatterns: [],
  bannedBash: [],
  auditPath: "/audit/tool-audit.jsonl",
};

const fenced = DEFAULT_FENCED_PATTERNS;

function call(toolName: string, input: unknown): ToolCallEvent {
  return { toolName, toolCallId: "tc-1", input };
}

describe("disallowed tools", () => {
  it("blocks a tool the phase may not call, naming the phase", () => {
    const verifyPolicy = { ...policy, phase: "VERIFY", disallowedTools: ["write", "edit"] };
    const decision = decideToolCall(call("write", { path: "a.ts" }), verifyPolicy, fenced);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("VERIFY");
  });

  it("leaves other tools alone", () => {
    const verifyPolicy = { ...policy, phase: "VERIFY", disallowedTools: ["write", "edit"] };
    expect(decideToolCall(call("read", { path: "a.ts" }), verifyPolicy, fenced).block).toBe(false);
  });
});

describe("bash", () => {
  it("blocks a red line and carries the reason", () => {
    const decision = decideToolCall(call("bash", { command: "rm -rf /" }), policy, fenced);
    expect(decision.block).toBe(true);
    expect(decision.reason).toBe("recursive rm is forbidden");
    expect(decision.target).toBe("rm -rf /");
  });

  it("allows an ordinary command", () => {
    expect(decideToolCall(call("bash", { command: "npm test" }), policy, fenced).block).toBe(false);
  });

  it("blocks a bash call with no command string instead of assuming it is safe", () => {
    expect(decideToolCall(call("bash", {}), policy, fenced).block).toBe(true);
    expect(decideToolCall(call("bash", null), policy, fenced).block).toBe(true);
  });
});

describe("read-only bash", () => {
  const readOnlyPolicy = {
    ...policy,
    phase: "VERIFY",
    bannedBash: [
      "(?:^|[^>])(?:>>|>)(?![>&])\\s*\\S+",
      "\\bsed\\s+[^\\n]*?-i(?:[^\\s]*)?(?:\\s|$)",
      "(?:^|[|;]\\s*)tee(?:\\s|$)",
      "\\bgit\\s+commit\\b",
    ],
  };
  const patterns = compileBannedBashPatterns(readOnlyPolicy.bannedBash);

  for (const command of [
    "printf x > src/a.ts",
    "sed -i 's/a/b/' src/a.ts",
    "printf x | tee src/a.ts",
    "git commit -am green",
  ]) {
    it(`blocks ${command}`, () => {
      const decision = decideToolCall(call("bash", { command }), readOnlyPolicy, fenced, patterns);
      expect(decision).toMatchObject({ block: true, reason: "shell write is forbidden in VERIFY" });
    });
  }

  it("still permits verification commands", () => {
    for (const command of ["npm test", "git diff --check", "printf x 2>&1"]) {
      expect(decideToolCall(call("bash", { command }), readOnlyPolicy, fenced, patterns).block).toBe(false);
    }
  });
});

describe("writes", () => {
  it("allows a write inside the worktree", () => {
    expect(decideToolCall(call("write", { path: "src/a.ts" }), policy, fenced).block).toBe(false);
  });

  it("blocks a write that escapes the worktree", () => {
    const decision = decideToolCall(call("write", { path: "/etc/passwd" }), policy, fenced);
    expect(decision).toMatchObject({ block: true, reason: "path escapes worktree" });
  });

  it("blocks a write to a fenced file", () => {
    const decision = decideToolCall(call("edit", { path: ".github/workflows/ci.yml" }), policy, fenced);
    expect(decision).toMatchObject({ block: true, reason: "fenced file" });
  });

  it("allows a write into a whitelisted evidence root", () => {
    const decision = decideToolCall(call("write", { path: "/ev/card-12/s1.png" }), policy, fenced);
    expect(decision.block).toBe(false);
  });

  it("honours extra fenced patterns from the policy", () => {
    const withExtra = { ...policy, fencedPatterns: ["(^|/)secrets/"] };
    const patterns = [...DEFAULT_FENCED_PATTERNS, ...compileFencedPatterns(withExtra.fencedPatterns)];
    expect(decideToolCall(call("write", { path: "secrets/k.pem" }), withExtra, patterns).block).toBe(true);
    expect(decideToolCall(call("write", { path: "secrets/k.pem" }), policy, fenced).block).toBe(false);
  });

  it("reads the path from any of the accepted argument names", () => {
    for (const key of ["path", "file_path", "filePath"]) {
      const decision = decideToolCall(call("write", { [key]: "/etc/passwd" }), policy, fenced);
      expect(decision.block).toBe(true);
    }
  });
});

describe("reads", () => {
  it("does not bound reads to the worktree", () => {
    // An agent legitimately reads toolchain and convention files above the
    // worktree; fencing protects writes, not understanding.
    expect(decideToolCall(call("read", { path: "/etc/hosts" }), policy, fenced).block).toBe(false);
  });

  it("allows reading a fenced file", () => {
    expect(decideToolCall(call("read", { path: ".github/workflows/ci.yml" }), policy, fenced).block).toBe(false);
  });

  it("still records what was read", () => {
    expect(decideToolCall(call("grep", { pattern: "x", path: "src" }), policy, fenced).target).toBe("src");
  });
});

describe("unknown tools", () => {
  it("applies the write rules when an unknown tool names a path", () => {
    // Fail closed: an unrecognised tool holding a path is treated as a writer.
    const decision = decideToolCall(call("mcp__fs__put", { path: "/etc/passwd" }), policy, fenced);
    expect(decision.block).toBe(true);
  });

  it("allows a tool whose target it cannot see, leaving disallowedTools as the lever", () => {
    const decision = decideToolCall(call("mcp__web__search", { query: "x" }), policy, fenced);
    expect(decision.block).toBe(false);
  });
});
