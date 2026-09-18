// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseGuardPolicy, POLICY_ENV_VAR } from "../guard/policy.js";
import { checkFilePath } from "../guard/danger-rules.js";
import { testAgentSpec } from "../runner/agent-spec.testing.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import type { PrototypeInspectorPort } from "../verify/prototype-inspector.js";
import { PiPrototypePort, PrototypeExitNotMetError, type PiPrototypePortOptions } from "./pi-prototype-port.js";
import type { PrototypeRequest } from "./prototype-runner.js";

/** A visual direction that satisfies the contract, so a test only has to
 * break the one thing it is about. */
const DIRECTION = { summary: "深色底、字大、一屏一件事，给值班的人走着看。", alternatives: [{ option: "浅色密集表格", reason: "值班的人不会坐下来逐行读。" }] };

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const SPEC = await testAgentSpec({ purpose: "decompose" });
const CONTRACT_ROOT = "docs/prototype";

const request: PrototypeRequest = {
  requirementId: "R-1",
  title: "任务看板",
  repository: "acme/widget",
  businessGoal: "让人看见今天要做什么",
  scenarios: [{ id: "R-1-01", given: "有任务", when: "打开首页", then: "看得见任务列表" }],
  interface: { kind: "web", direction: DIRECTION, pages: [{ name: "任务看板", purpose: "看今天要做什么" }] },
  approach: "沿用现有栈",
  direction: DIRECTION,
  contractRoot: CONTRACT_ROOT,
  revisionFeedback: [],
};

function runner(replies: string[]): PiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  const result: PromptResult = { settled: true, failure: null, usage, events: [] };
  let index = -1;
  return {
    prompts,
    alive: true,
    start: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    prompt: vi.fn(async (message: string) => { prompts.push(message); index += 1; return result; }),
    getMessages: vi.fn(async () => [{
      role: "assistant",
      content: [{ type: "text", text: replies[Math.min(index, replies.length - 1)] ?? "" }],
    }]),
    getState: vi.fn(async () => ({ sessionId: "prototype-session" })),
    stop: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    waitingOnUser: [],
    kill: vi.fn(async () => undefined),
  };
}

/** A contract on disk that the checks are happy with, so a test only has to
 * break the one thing it is about. */
async function contract(pages: Record<string, string> = {}): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), "hivemind-prototype-"));
  const root = join(worktree, CONTRACT_ROOT);
  await mkdir(join(root, "pages"), { recursive: true });
  await writeFile(join(root, "tokens.json"), JSON.stringify({
    color: { surface: { $type: "color", $value: "#111827" } },
  }));
  await writeFile(join(root, "components.md"), "# 组件\n\n- 按钮：触发一个动作。\n");
  await writeFile(join(root, "design.md"), "# 为什么长这样\n\n值班的人站着看，所以底色用 `color.surface`。\n");
  const all = { "pages/board.html": "<title>任务看板</title>", ...pages };
  for (const [file, html] of Object.entries(all)) {
    await writeFile(
      join(root, file),
      `<html><head>${html}<meta name="description" content="看今天要做什么"></head><body></body></html>`,
    );
  }
  return worktree;
}

/** The browser, answering with whatever the test says each URL shows. */
function inspector(snapshot: (url: string) => string) {
  const closed = { count: 0 };
  const port: PrototypeInspectorPort & { close(): Promise<void> } = {
    inspect: async (url) => ({ snapshot: snapshot(url), styles: { rootFontSizePx: 16, usages: [] } }),
    close: async () => { closed.count += 1; },
  };
  return { port, closed };
}

const GOOD = JSON.stringify({
  pages: [{ file: "pages/board.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "新建任务" }] }],
  concerns: [],
});

function stateAware(url: string): string {
  const state = new URL(url).searchParams.get("state");
  return `- button "新建任务"${state === null ? "" : `\n- note: ${state}`}`;
}

function drawingPort(options: {
  worktree: string;
  replies: string[];
  snapshot?: (url: string) => string;
  maxRounds?: number;
  seen?: Array<Record<string, unknown>>;
  designLint?: PiPrototypePortOptions["designLint"];
  recordFriction?: PiPrototypePortOptions["recordFriction"];
}) {
  const instance = runner(options.replies);
  const browser = inspector(options.snapshot ?? stateAware);
  return {
    instance,
    browser,
    port: new PiPrototypePort({
      binary: "pi",
      spec: SPEC,
      promptRoot: resolve("prompts"),
      worktreePath: options.worktree,
      contractRoot: CONTRACT_ROOT,
      auditPath: join(options.worktree, "audit.jsonl"),
      maxRounds: options.maxRounds ?? 2,
      inspector: async () => browser.port,
      ...(options.designLint ? { designLint: options.designLint } : {}),
      ...(options.recordFriction ? { recordFriction: options.recordFriction } : {}),
      createRunner: (config) => {
        options.seen?.push(config as unknown as Record<string, unknown>);
        return instance;
      },
    }),
  };
}

describe("PiPrototypePort", () => {
  it("returns the contract when every page draws what it claims", async () => {
    const worktree = await contract();
    const drawing = drawingPort({ worktree, replies: [GOOD] });

    await expect(drawing.port.run(request)).resolves.toEqual({
      pages: [{ file: "pages/board.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "新建任务" }] }],
      concerns: [],
    });
    expect(drawing.instance.prompts).toHaveLength(1);
    expect(drawing.browser.closed.count).toBe(1);
  });

  it("files every design finding as friction, and lets the contract through anyway", async () => {
    const worktree = await contract();
    const friction: Array<{ kind: string; detail: string }> = [];
    const drawing = drawingPort({
      worktree,
      replies: [GOOD],
      designLint: {
        binary: "impeccable",
        run: async () => ({
          code: 2,
          stdout: JSON.stringify([
            { antipattern: "ai-color-palette", file: "pages/board.html", line: 0, name: "AI palette", snippet: "Purple" },
          ]),
          stderr: "",
        }),
      },
      recordFriction: async (row) => { friction.push({ kind: row.kind, detail: row.detail }); },
    });

    await expect(drawing.port.run(request)).resolves.toMatchObject({ concerns: [] });
    expect(friction).toEqual([
      { kind: "design_lint_finding", detail: "ai-color-palette pages/board.html AI palette: Purple" },
    ]);
  });

  it("says the detector was unavailable rather than filing a page as clean", async () => {
    const worktree = await contract();
    const friction: Array<{ kind: string; detail: string }> = [];
    const drawing = drawingPort({
      worktree,
      replies: [GOOD],
      designLint: { binary: "impeccable", run: async () => { throw new Error("spawn impeccable ENOENT"); } },
      recordFriction: async (row) => { friction.push({ kind: row.kind, detail: row.detail }); },
    });

    await expect(drawing.port.run(request)).resolves.toMatchObject({ concerns: [] });
    expect(friction).toEqual([{ kind: "design_lint_unavailable", detail: "spawn impeccable ENOENT" }]);
  });

  it("hands the drawing the direction a person approved, and the ones they did not", async () => {
    const worktree = await contract();
    const drawing = drawingPort({ worktree, replies: [GOOD] });

    await drawing.port.run(request);

    expect(drawing.instance.prompts[0]).toContain(DIRECTION.summary);
    expect(drawing.instance.prompts[0]).toContain(DIRECTION.alternatives[0]!.option);
  });

  it("hands the findings back to the same session instead of starting another", async () => {
    const worktree = await contract();
    const missing = JSON.stringify({
      pages: [{ file: "pages/board.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "导出" }] }],
    });
    const drawing = drawingPort({ worktree, replies: [missing, GOOD], maxRounds: 3 });

    await expect(drawing.port.run(request)).resolves.toMatchObject({ concerns: [] });
    expect(drawing.instance.prompts).toHaveLength(2);
    expect(drawing.instance.prompts[1]).toContain("导出");
    expect(drawing.instance.start).toHaveBeenCalledTimes(1);
  });

  it("refuses once the rounds are used up, naming what is still wrong", async () => {
    const worktree = await contract();
    const missing = JSON.stringify({
      pages: [{ file: "pages/board.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "导出" }] }],
    });
    const drawing = drawingPort({ worktree, replies: [missing], maxRounds: 2 });

    await expect(drawing.port.run(request)).rejects.toBeInstanceOf(PrototypeExitNotMetError);
    expect(drawing.instance.prompts).toHaveLength(2);
  });

  it("refuses a page whose four states are the same page", async () => {
    const worktree = await contract();
    const drawing = drawingPort({
      worktree,
      replies: [GOOD],
      snapshot: () => '- button "新建任务"',
      maxRounds: 1,
    });

    await expect(drawing.port.run(request)).rejects.toThrow(/四态没有真的分开/);
  });

  it("hands back a reply that is not the agreed JSON rather than giving up on the session", async () => {
    const worktree = await contract();
    const drawing = drawingPort({ worktree, replies: ["画好了，你看看。", GOOD], maxRounds: 3 });

    await expect(drawing.port.run(request)).resolves.toMatchObject({ concerns: [] });
    expect(drawing.instance.prompts[1]).toContain("JSON");
  });

  it("fences the session's writes to the contract directory", async () => {
    const worktree = await contract();
    const seen: Array<Record<string, unknown>> = [];
    await drawingPort({ worktree, replies: [GOOD], seen }).port.run(request);

    const env = seen[0]!.env as Record<string, string>;
    const policy = parseGuardPolicy(env[POLICY_ENV_VAR]!);
    const patterns = policy.fencedPatterns.map((source) => new RegExp(source));
    expect(checkFilePath("docs/prototype/pages/board.html", worktree, [], patterns).deny).toBe(false);
    expect(checkFilePath("src/app.ts", worktree, [], patterns).deny).toBe(true);
  });

  it("says the contract is not there when nothing was written", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "hivemind-prototype-"));
    const drawing = drawingPort({ worktree, replies: [GOOD], maxRounds: 1 });

    await expect(drawing.port.run(request)).rejects.toThrow(/docs\/prototype 下什么都没有/);
  });
});
