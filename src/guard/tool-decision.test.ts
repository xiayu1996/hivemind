import { describe, expect, it } from "vitest";
import { DEFAULT_FENCED_PATTERNS } from "./danger-rules.js";
import { compileBannedBashPatterns, compileFencedPatterns, type GuardPolicy, READ_ONLY_BASH_PATTERNS } from "./policy.js";
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
  e2eHostAllowlist: [],
  toolOutputLimits: { maxBytes: 51200, maxLines: 2000 },
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
    bannedBash: [...READ_ONLY_BASH_PATTERNS],
  };
  const patterns = compileBannedBashPatterns(readOnlyPolicy.bannedBash);

  for (const command of [
    "printf x > src/a.ts",
    "printf x 2>src/a.log",
    "sed -i 's/a/b/' src/a.ts",
    "printf x | tee src/a.ts",
    "git commit -am green",
  ]) {
    it(`blocks ${command}`, () => {
      const decision = decideToolCall(call("bash", { command }), readOnlyPolicy, fenced, patterns);
      expect(decision).toMatchObject({ block: true, reason: "shell write is forbidden in VERIFY" });
    });
  }

  it("lets a verifier log a service it starts into the evidence directory, and nowhere else", () => {
    for (const command of [
      "nohup node server.js > /ev/card-12/service.log 2>&1 &",
      "node server.js >/ev/card-12/service.log 2>/dev/null &",
      "nohup node server.js > \"$HIVEMIND_EVIDENCE_DIR/service.log\" 2>&1 &",
      "nohup node server.js > ${HIVEMIND_EVIDENCE_DIR}/service.log 2>&1 &",
    ]) {
      expect(decideToolCall(call("bash", { command }), readOnlyPolicy, fenced, patterns).block).toBe(false);
    }
    for (const command of [
      "nohup node server.js > /tmp/service.log 2>&1 &",
      "node server.js > service.log",
    ]) {
      expect(decideToolCall(call("bash", { command }), readOnlyPolicy, fenced, patterns))
        .toMatchObject({ block: true, reason: "shell write is forbidden in VERIFY" });
    }
  });

  it("refuses to let a verifier answer the page's requests itself", () => {
    const browsing = { ...readOnlyPolicy, e2eHostAllowlist: ["localhost"] };
    for (const command of [
      "playwright-cli -s=S-1 route '**/api/status' --status 200 --body '{}'",
      "playwright-cli -s=S-1 unroute '**/api/status' && playwright-cli -s=S-1 reload",
    ]) {
      expect(decideToolCall(call("bash", { command }), browsing, fenced, patterns))
        .toMatchObject({ block: true, reason: expect.stringContaining("request interception") });
    }
    expect(decideToolCall(call("bash", { command: "playwright-cli -s=S-1 open http://localhost:3000/ && playwright-cli -s=S-1 screenshot" }), browsing, fenced, patterns).block).toBe(false);
  });

  it("still permits verification commands", () => {
    for (const command of [
      "npm test",
      "git diff --check",
      "printf x 2>&1",
      // Inline scripts are how a verifier starts the service it looks at.
      "npx tsx -e 'const app = await create(async () => []); setInterval(() => {}, 1000);'",
      "grep -- '->' src/a.ts",
      "printf 'EVIDENCE=%s\\n' \"${HIVEMIND_EVIDENCE_DIR:-<unset>}\"; npm test -- --reporter=verbose",
    ]) {
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

describe("browser navigation", () => {
  const browsing: GuardPolicy = {
    ...policy,
    phase: "E2E",
    e2eHostAllowlist: ["localhost", "127.0.0.1", ".staging.example"],
  };

  it("lets an allowlisted host through, whatever the MCP server named the tool", () => {
    const decision = decideToolCall(
      call("mcp__playwright__browser_navigate", { url: "http://localhost:5173/board" }),
      browsing,
      fenced,
    );
    expect(decision).toEqual({ block: false, target: "http://localhost:5173/board" });
  });

  it("blocks a page loaded off the disk, which is how a browser run fakes a pass", () => {
    const decision = decideToolCall(
      call("mcp__playwright__browser_navigate", { url: "file:///wt/task-1/dist/index.html" }),
      browsing,
      fenced,
    );
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("file://");
  });

  it("blocks a host nobody put on the list", () => {
    const decision = decideToolCall(
      call("mcp__playwright__browser_navigate", { url: "https://example.com/" }),
      browsing,
      fenced,
    );
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("example.com");
  });

  it("matches a leading-dot entry as a suffix and nothing else", () => {
    expect(decideToolCall(call("browser", { url: "https://app.staging.example/" }), browsing, fenced).block)
      .toBe(false);
    expect(decideToolCall(call("browser", { url: "https://staging.example.evil/" }), browsing, fenced).block)
      .toBe(true);
  });

  it("refuses navigation from a phase that has no business driving a browser", () => {
    const decision = decideToolCall(call("browser", { url: "http://localhost:5173/" }), policy, fenced);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("CODE");
  });

  it("refuses a navigation target that is not a URL at all", () => {
    expect(decideToolCall(call("browser", { url: "board" }), browsing, fenced).block).toBe(true);
  });
});

describe("browser driven from the shell", () => {
  const browsing: GuardPolicy = {
    ...policy,
    phase: "E2E",
    e2eHostAllowlist: ["localhost", "127.0.0.1"],
  };

  it("lets a run against an allowlisted host through", () => {
    expect(decideToolCall(
      call("bash", { command: "npx playwright-cli goto http://localhost:5173/board" }),
      browsing,
      fenced,
    ).block).toBe(false);
    expect(decideToolCall(
      call("bash", { command: "npx playwright test --reporter=line" }),
      browsing,
      fenced,
    ).block).toBe(false);
  });

  it("blocks a page opened off the disk even when the shell hides it", () => {
    const decision = decideToolCall(
      call("bash", { command: "playwright-cli open file:///wt/task-1/dist/index.html" }),
      browsing,
      fenced,
    );
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("file://");
  });

  it("blocks a host nobody put on the list, with or without a scheme", () => {
    expect(decideToolCall(
      call("bash", { command: "playwright-cli goto https://example.com/" }),
      browsing,
      fenced,
    ).block).toBe(true);
    expect(decideToolCall(
      call("bash", { command: "playwright-cli open example.com" }),
      browsing,
      fenced,
    ).block).toBe(true);
  });

  it("leaves shell commands that are not driving a browser alone", () => {
    expect(decideToolCall(
      call("bash", { command: "git remote get-url origin" }),
      browsing,
      fenced,
    ).block).toBe(false);
    expect(decideToolCall(
      call("bash", { command: "curl -s https://registry.npmjs.org/playwright" }),
      browsing,
      fenced,
    ).block).toBe(false);
  });

  it("does not mistake a screenshot filename for a navigation", () => {
    expect(decideToolCall(
      call("bash", { command: "playwright-cli screenshot --filename evidence/home.png" }),
      browsing,
      fenced,
    ).block).toBe(false);
  });

  it("refuses a browser run from a phase that has no business driving one", () => {
    const decision = decideToolCall(
      call("bash", { command: "playwright-cli goto http://localhost:5173/" }),
      policy,
      fenced,
    );
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("CODE");
  });
});
