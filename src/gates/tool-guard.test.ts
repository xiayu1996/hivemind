import { relative } from "node:path";
import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isWithinRoot, toPosixPath } from "./danger-rules.ts";
import { decideToolCall, type ToolDecision, type ToolPolicy } from "./tool-guard.ts";

const ROOT = "/wt/task-1";
const TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "submit_result", "browser_navigate"];

/** A session that builds: may write the whole tree apart from the fences. */
const builder: ToolPolicy = { allowedTools: TOOLS, root: ROOT, writable: ["**"], fenced: [] };
/** A session that judges: may not write files at all. */
const evaluator: ToolPolicy = { ...builder, writable: [] };

function decide(policy: ToolPolicy, name: string, args: Record<string, unknown>): ToolDecision {
  return decideToolCall(policy, { name, args });
}

function allowed(policy: ToolPolicy, name: string, args: Record<string, unknown>): boolean {
  return decide(policy, name, args).allow;
}

function reasonFor(policy: ToolPolicy, name: string, args: Record<string, unknown>): string {
  const decision = decide(policy, name, args);
  if (decision.allow) throw new Error(`${name} ${JSON.stringify(args)} was allowed`);
  return decision.reason;
}

describe("the tools a session was given", () => {
  it("refuses a tool the session was not given, and names the ones it has", () => {
    const reading: ToolPolicy = { ...evaluator, allowedTools: ["read", "bash"] };
    expect(reasonFor(reading, "write", { path: "a.ts" })).toContain("use one of: read, bash");
    expect(allowed(reading, "read", { path: "a.ts" })).toBe(true);
  });

  it("refuses an unknown tool even when all it carries is a path", () => {
    expect(allowed(builder, "mcp__fs__put", { path: "/etc/passwd" })).toBe(false);
    expect(allowed(builder, "mcp__web__search", { query: "x" })).toBe(false);
  });

  it("leaves the tools this system defines to their own rules", () => {
    expect(allowed(evaluator, "submit_result", { summary: "all scenarios pass" })).toBe(true);
    // The browser tools judge their own navigation targets.
    expect(allowed(evaluator, "browser_navigate", { url: "http://localhost:5173/board" })).toBe(true);
  });
});

describe("tools that only look", () => {
  const drawing: ToolPolicy = { ...builder, writable: ["docs/prototype/**"] };

  it("lets every one of them read what the fence keeps the session from writing", () => {
    // Judging an observing tool against the write fence left the first drawing
    // session unable to list anything: `ls` and `find` were refused on `docs`
    // and on its own contract root, and it answered with six pages it had never
    // written.
    for (const tool of ["read", "grep", "find", "ls"]) {
      expect(allowed(drawing, tool, { path: "src/app.ts" })).toBe(true);
      expect(allowed(drawing, tool, { path: "docs/prototype" })).toBe(true);
    }
  });

  it("still refuses to write outside the writable set, which is what it is for", () => {
    expect(allowed(drawing, "write", { path: "src/app.ts" })).toBe(false);
    expect(allowed(drawing, "write", { path: "docs/prototype/tokens.json" })).toBe(true);
    expect(allowed(drawing, "write", { path: "docs/prototype/../../src/app.ts" })).toBe(false);
  });
});

describe("reads", () => {
  it("does not bound reads to the workspace", () => {
    // An agent legitimately reads toolchain and convention files above the
    // workspace; fencing protects writes, not understanding.
    expect(allowed(builder, "read", { path: "/etc/hosts" })).toBe(true);
  });

  it("allows reading a fenced file", () => {
    const fenced: ToolPolicy = { ...builder, fenced: [".hivemind/**"] };
    expect(allowed(fenced, "read", { path: ".github/workflows/ci.yml" })).toBe(true);
    expect(allowed(fenced, "grep", { pattern: "x", path: ".hivemind" })).toBe(true);
  });
});

describe("bash", () => {
  it("refuses a red line and carries the rule's reason", () => {
    expect(reasonFor(builder, "bash", { command: "rm -rf /" })).toContain("recursive rm is forbidden");
  });

  it("allows an ordinary command", () => {
    expect(allowed(builder, "bash", { command: "npm test" })).toBe(true);
  });

  it("refuses a bash call with no command string instead of assuming it is safe", () => {
    expect(reasonFor(builder, "bash", {})).toContain('"command"');
    expect(decideToolCall(builder, { name: "bash", args: null as unknown as Record<string, unknown> }).allow).toBe(false);
  });
});

describe("a session that may not write files", () => {
  for (const command of [
    "printf x > src/a.ts",
    "printf x 2>src/a.log",
    "sed -i 's/a/b/' src/a.ts",
    "printf x | tee src/a.ts",
    "git commit -am green",
  ]) {
    it(`refuses ${command}`, () => {
      expect(reasonFor(evaluator, "bash", { command })).toContain("may not write files");
    });
  }

  it("lets output be discarded, and written nowhere else", () => {
    for (const command of [
      "nohup node server.js > /dev/null 2>&1 &",
      "node server.js >/dev/null 2>/dev/null &",
      'node server.js > "/dev/null" 2>&1',
      "echo warn >&2",
      "echo warn > /dev/stderr",
    ]) {
      expect(allowed(evaluator, "bash", { command })).toBe(true);
    }
    for (const command of ["nohup node server.js > /tmp/service.log 2>&1 &", "node server.js > service.log"]) {
      expect(reasonFor(evaluator, "bash", { command })).toContain("may not write files");
    }
  });

  it("refuses to let it answer the page's requests itself", () => {
    for (const command of [
      "playwright-cli -s=S-1 route '**/api/status' --status 200 --body '{}'",
      "playwright-cli -s=S-1 unroute '**/api/status' && playwright-cli -s=S-1 reload",
    ]) {
      expect(reasonFor(evaluator, "bash", { command })).toContain("request interception");
    }
    expect(allowed(evaluator, "bash", {
      command: "playwright-cli -s=S-1 open http://localhost:3000/ && playwright-cli -s=S-1 screenshot",
    })).toBe(true);
  });

  it("still permits verification commands", () => {
    for (const command of [
      "npm test",
      "git diff --check",
      "printf x 2>&1",
      // Inline scripts are how a session starts the service it looks at.
      "npx tsx -e 'const app = await create(async () => []); setInterval(() => {}, 1000);'",
      "grep -- '->' src/a.ts",
      "printf 'EVIDENCE=%s\\n' \"${EVIDENCE_DIR:-<unset>}\"; npm test -- --reporter=verbose",
    ]) {
      expect(allowed(evaluator, "bash", { command })).toBe(true);
    }
  });

  it("judges a write split across lines as bash joins it", () => {
    expect(allowed(evaluator, "bash", { command: "sed \\\n  -i 's/a/b/' src/a.ts" })).toBe(false);
  });

  it("leaves the shell of a session that builds to the red lines alone", () => {
    for (const command of [
      "printf x > src/a.ts",
      "git commit -am wip",
      "playwright-cli -s=S-1 route '**/api' --status 200",
    ]) {
      expect(allowed(builder, "bash", { command })).toBe(true);
    }
  });
});

describe("writes", () => {
  it("allows a write inside the workspace", () => {
    expect(allowed(builder, "write", { path: "src/a.ts" })).toBe(true);
    expect(allowed(builder, "edit", { path: "/wt/task-1/src/a.ts" })).toBe(true);
  });

  it("refuses a write that escapes the workspace, and says where to write instead", () => {
    expect(reasonFor(builder, "write", { path: "/etc/passwd" })).toContain("relative to the workspace root");
    expect(allowed(builder, "write", { path: "src/../../outside.ts" })).toBe(false);
    expect(allowed(builder, "write", { path: "/wt/task-10/x.ts" })).toBe(false);
  });

  it("refuses a default fenced file in every session, even one that may write everything", () => {
    expect(reasonFor(builder, "edit", { path: ".github/workflows/ci.yml" })).toContain("leave it unchanged");
    expect(allowed(builder, "write", { path: "CLAUDE.md" })).toBe(false);
    expect(allowed(builder, "write", { path: "sub/AGENTS.md" })).toBe(false);
  });

  it("refuses a write that names no file", () => {
    for (const args of [{}, { path: "" }, { path: 42 }, { file_path: "src/a.ts" }]) {
      expect(reasonFor(builder, "write", args)).toContain('"path"');
    }
    expect(reasonFor(builder, "write", { path: "." })).toContain("workspace root itself");
  });

  it("refuses the spellings pi resolves somewhere other than the path as written", () => {
    expect(reasonFor(builder, "write", { path: "~/.bashrc" })).toContain("home directory");
    expect(reasonFor(builder, "write", { path: "file:///wt/task-1/src/a.ts" })).toContain("file:// URL");
    expect(allowed(builder, "write", { path: "@CLAUDE.md" })).toBe(false);
  });
});

describe("fenced and writable together", () => {
  it("checks the fence before the writable set", () => {
    const policy: ToolPolicy = { ...builder, fenced: [".hivemind/**"] };
    const reason = reasonFor(policy, "write", { path: ".hivemind/plan.yaml" });
    expect(reason).toContain(".hivemind/**");
    expect(reason).toContain("leave it unchanged");
    expect(allowed(policy, "write", { path: "src/a.ts" })).toBe(true);
  });

  it("fences a file that the writable set would otherwise cover", () => {
    const policy: ToolPolicy = { ...builder, writable: ["src/**"], fenced: ["**/*.test.ts"] };
    expect(allowed(policy, "edit", { path: "src/a.test.ts" })).toBe(false);
    expect(allowed(policy, "edit", { path: "src/a.ts" })).toBe(true);
    // A test at the root is under the same fence.
    expect(allowed({ ...policy, writable: ["**"] }, "write", { path: "a.test.ts" })).toBe(false);
  });

  it("refuses what the writable set does not cover, and names what it does", () => {
    const author: ToolPolicy = { ...builder, writable: [".hivemind/**"] };
    expect(reasonFor(author, "write", { path: "src/app.ts" })).toContain("only write paths matching .hivemind/**");
    expect(allowed(author, "write", { path: ".hivemind/plan.yaml" })).toBe(true);
  });

  it("refuses every write when the writable set is empty, whatever the fences say", () => {
    expect(reasonFor(evaluator, "write", { path: "src/a.ts" })).toContain("may not write files");
    expect(allowed({ ...evaluator, fenced: ["docs/**"] }, "edit", { path: "src/a.ts" })).toBe(false);
  });

  it("judges the resolved path, so .. neither leaves a writable directory nor enters a fenced one", () => {
    const author: ToolPolicy = { ...builder, writable: [".hivemind/**"] };
    expect(allowed(author, "write", { path: ".hivemind/../src/app.ts" })).toBe(false);
    const fenced: ToolPolicy = { ...builder, fenced: [".hivemind/**"] };
    expect(allowed(fenced, "write", { path: "src/../.hivemind/plan.yaml" })).toBe(false);
    const sources: ToolPolicy = { ...builder, writable: ["src/**"] };
    expect(allowed(sources, "write", { path: "src/../src/a.ts" })).toBe(true);
    expect(allowed(sources, "write", { path: "/wt/task-1/src/a.ts" })).toBe(true);
  });

  it("matches fences case-insensitively and the writable set case-sensitively", () => {
    expect(allowed({ ...builder, fenced: [".hivemind/**"] }, "write", { path: ".HIVEMIND/plan.yaml" })).toBe(false);
    const author: ToolPolicy = { ...builder, writable: [".hivemind/**"] };
    expect(allowed(author, "write", { path: ".Hivemind/plan.yaml" })).toBe(false);
    expect(allowed(author, "write", { path: ".hivemind/plan.yaml" })).toBe(true);
  });
});

describe("a command riding along with another tool", () => {
  it("is judged by the same red lines a bash call gets", () => {
    expect(reasonFor(builder, "edit", { path: "src/a.ts", command: "rm -rf /" })).toContain("recursive rm");
  });

  it("cannot smuggle a shell write past a session that may not write", () => {
    const withRunner: ToolPolicy = { ...evaluator, allowedTools: [...TOOLS, "browser_run"] };
    expect(reasonFor(withRunner, "browser_run", { command: "echo x > src/a.ts" })).toContain("may not write files");
  });

  it("does not stop the fence from judging the file the call names", () => {
    const frozen: ToolPolicy = { ...builder, fenced: ["src/a.test.ts"] };
    expect(allowed(frozen, "edit", { path: "src/a.test.ts", command: "npm test" })).toBe(false);
  });

  it("lets an ordinary edit plus verification through", () => {
    expect(allowed(builder, "edit", { path: "src/a.ts", command: "npm test" })).toBe(true);
  });

  it("refuses a command that is present but not a string, rather than ignoring it", () => {
    for (const command of [{ timeout: 30 }, null, 42]) {
      expect(reasonFor(builder, "edit", { path: "src/a.ts", command })).toContain('"command" must be a string');
    }
  });

  it("covers a tool the fence would otherwise wave through", () => {
    expect(allowed(builder, "read", { path: "src/a.ts", command: "rm -rf /" })).toBe(false);
    expect(allowed(builder, "submit_result", { command: "git push --force origin story/x" })).toBe(false);
  });
});

/** The absolute path pi's own tool touches for `path`, recorded instead of written. */
async function pathPiTouches(tool: "write" | "edit", path: string): Promise<string> {
  let touched: string | undefined;
  const record = async (absolutePath: string): Promise<void> => {
    touched = absolutePath;
  };
  if (tool === "write") {
    const write = createWriteTool(ROOT, { operations: { mkdir: async () => {}, writeFile: record } });
    await write.execute("probe", { path, content: "" });
  } else {
    const edit = createEditTool(ROOT, {
      operations: { access: async () => {}, readFile: async () => Buffer.from("before"), writeFile: record },
    });
    await edit.execute("probe", { path, edits: [{ oldText: "before", newText: "after" }] });
  }
  if (touched === undefined) throw new Error(`pi's ${tool} tool touched nothing for ${path}`);
  return touched;
}

describe("the file pi's own tools touch", () => {
  it("names the tools and their arguments the way this guard reads them", () => {
    expect(createWriteTool(ROOT).name).toBe("write");
    expect(createEditTool(ROOT).name).toBe("edit");
    expect(createBashTool(ROOT).name).toBe("bash");
    expect(Object.keys(createWriteTool(ROOT).parameters.properties)).toContain("path");
    expect(Object.keys(createEditTool(ROOT).parameters.properties)).toContain("path");
    expect(Object.keys(createBashTool(ROOT).parameters.properties)).toContain("command");
  });

  // If pi changes how it normalises a path, these fail before a spelling the
  // guard no longer understands can walk past it.
  for (const tool of ["write", "edit"] as const) {
    it(`allows exactly the file ${tool} touches, however the path is spelled`, async () => {
      for (const path of [
        "src/a.ts",
        "@src/a.ts",
        "./src/a.ts",
        "src/../src/a.ts",
        "/wt/task-1/src/a.ts",
        "src//a.ts",
        "src/a\u00A0b.ts",
        "@src/a\u2003b.ts",
        "CLAUDE-notes.md/.",
      ]) {
        const touched = await pathPiTouches(tool, path);
        expect(isWithinRoot(touched, ROOT)).toBe(true);
        const target = toPosixPath(relative(ROOT, touched));
        expect(allowed({ ...builder, writable: [target] }, tool, { path })).toBe(true);
        expect(allowed({ ...builder, fenced: [target] }, tool, { path })).toBe(false);
      }
    });

    it(`refuses every spelling ${tool} resolves outside the workspace`, async () => {
      for (const path of ["~/x.ts", "~", "@~/x.ts", "file:///etc/passwd", "../outside.ts", "/etc/passwd"]) {
        expect(isWithinRoot(await pathPiTouches(tool, path), ROOT)).toBe(false);
        expect(allowed(builder, tool, { path })).toBe(false);
      }
    });
  }
});
