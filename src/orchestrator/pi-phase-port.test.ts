import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRunner, PromptResult } from "../runner/types.js";
import { testAgentSpec } from "../runner/agent-spec.testing.js";
import type { CodeExitFacts } from "../pipeline/code-exit-gate.js";
import { CodeExitNotMetError, PhaseExitNotMetError, PiStoryPhasePort } from "./pi-phase-port.js";
import type { ManagedPhaseInput } from "./story-worker.js";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, costUsd: 0.1 };

function fakeRunner(reply: string, stateId = "session-1"): PiRunner {
  const result: PromptResult = { settled: true, failure: null, usage, events: [{ type: "agent_settled" }] };
  return {
    alive: true,
    start: vi.fn(async () => undefined),
    prompt: vi.fn(async () => result),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    waitingOnUser: [],
    getMessages: vi.fn(async () => [{ role: "assistant", content: [{ type: "text", text: reply }] }]),
    getState: vi.fn(async () => ({ sessionId: stateId })),
    setAutoRetry: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
  };
}

function phaseInput(phase: ManagedPhaseInput["phase"]): ManagedPhaseInput {
  return {
    runId: `run-${phase.toLowerCase()}`,
    phase,
    round: 1,
    prompt: "complete the phase",
    context: {
      cardId: "S-EPIC1-01",
      phase,
      round: 1,
      title: "Story",
      requirement: "Requirement",
      specs: [],
      artifacts: [],
      feedback: [],
    previousRejections: [],
      evidence: [],
      failedScenarios: [],
    },
  };
}

describe("PiStoryPhasePort", () => {
  let temporary: string;

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it("injects the guard before spawn and parses a DESIGN result", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const reply = JSON.stringify({
      design_summary: "Persist artifacts centrally.",
      declarations: [{ file: "src/pipeline/phase.ts", note: "the phase enum every table keys off" }],
    });
    const runner = fakeRunner(reply, "fresh-design-session");
    const configs: unknown[] = [];
    const telemetry = vi.fn(() => undefined);
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: (config) => { configs.push(config); return runner; },
      emit: telemetry,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run(phaseInput("DESIGN"))).resolves.toMatchObject({
      sessionId: "fresh-design-session",
      artifacts: [
        { kind: "design-summary", body: "Persist artifacts centrally." },
        {
          kind: "declarations",
          body: JSON.stringify([{ file: "src/pipeline/phase.ts", note: "the phase enum every table keys off" }], null, 2),
        },
      ],
    });
    expect(configs).toMatchObject([{
      contextFiles: "explicit",
      // One tool set for every phase: a per-phase set is a cache prefix break
      // that bought nothing, and the constraints live in the prompt tail and
      // the deterministic exits instead.
      tools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
      env: { PI_GUARD_POLICY: expect.stringContaining('"phase":"DESIGN"') },
    }]);
    expect(telemetry).toHaveBeenCalledOnce();
  });

  it("finishes the phase even when the observability emitter throws", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => fakeRunner(JSON.stringify({ delivery_report: "Shipped the thing." })),
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      // The buffer does not throw; an axiom that holds only while every caller
      // is well behaved is a convention, so the port does not rely on it.
      emit: () => { throw new Error("observer is broken"); },
    });

    await expect(port.run(phaseInput("MERGE"))).resolves.toMatchObject({
      artifacts: [{ kind: "delivery-report" }],
    });
  });

  it("puts the repository context ahead of the per-phase layer so phases share a prefix", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const contextFile = join(temporary, "AGENTS.md");
    await writeFile(contextFile, "# repository conventions\n\nA long, stable block.\n");
    const spawn = async (phase: ManagedPhaseInput["phase"], reply: string): Promise<string> => {
      const configs: { systemPrompt?: { text: string } }[] = [];
      const port = new PiStoryPhasePort({
        binary: "pi",
        resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
        worktreePath: resolve("."),
        promptRoot: resolve("prompts"),
        sessionRoot: join(temporary, "sessions"),
        evidencePath: join(temporary, "evidence"),
        auditPath: join(temporary, "audit", "tool-audit.jsonl"),
        guardExtension: resolve("extensions/hive-guard.ts"),
        canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
        contextFiles: [{ label: "repository", path: contextFile }],
        createRunner: (config) => {
          configs.push(config as { systemPrompt?: { text: string } });
          return fakeRunner(reply, `${phase}-session`);
        },
        readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      });
      await port.run(phaseInput(phase));
      return configs[0]!.systemPrompt!.text;
    };

    const design = await spawn("DESIGN", JSON.stringify({ design_summary: "Summary.", declarations: [] }));
    const merge = await spawn("MERGE", JSON.stringify({ delivery_report: "Shipped the thing." }));
    // Most stable first: the baseline, then the repository context, then the
    // layer that differs per phase. Two phases of one card therefore share
    // everything up to the context's last byte, which is the whole point --
    // with the context last, the shared prefix was the baseline alone.
    const shared = design.slice(0, [...design].findIndex((_, index) => design[index] !== merge[index]));
    expect(shared).toContain("# repository conventions");
    expect(shared).toContain("A long, stable block.");
    expect(design.indexOf("# repository conventions")).toBeLessThan(design.indexOf("# DESIGN"));
    // Byte determinism: the same phase assembled twice is the same string.
    expect(await spawn("MERGE", JSON.stringify({ delivery_report: "Shipped the thing." }))).toBe(merge);
  });

  it("spawns with the credential of the provider the phase was granted", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const reply = JSON.stringify({ design_summary: "Persist artifacts centrally.", declarations: [] });
    const configs: { env?: Record<string, string> }[] = [];
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({
        spec: await testAgentSpec({ provider: "deepseek" }),
        release: async () => undefined,
      }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: (config) => {
        configs.push(config as { env?: Record<string, string> });
        return fakeRunner(reply, "fresh-design-session");
      },
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      providerEnv: (provider) => provider === "deepseek" ? { DEEPSEEK_API_KEY: "from-secrets" } : {},
    });

    await port.run(phaseInput("DESIGN"));
    expect(configs[0]?.env).toMatchObject({ DEEPSEEK_API_KEY: "from-secrets" });
  });

  it("hands the CODE exit findings back to the same session instead of failing the phase", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const runner = fakeRunner(JSON.stringify({ implementation: "Done; committed." }));
    const measured: CodeExitFacts[] = [
      {
        uncommittedPaths: ["src/console/data.ts"],
        commitCount: 0,
        whitespaceErrors: [],
        redScenarioIds: [],
        greenScenarioIds: [],
        markedScenarioIds: [],
        dodScenarioIds: [],
        projectChecks: [],
      },
      {
        uncommittedPaths: [],
        commitCount: 2,
        whitespaceErrors: [],
        redScenarioIds: [],
        greenScenarioIds: [],
        markedScenarioIds: [],
        dodScenarioIds: [],
        projectChecks: [],
      },
    ];
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      codeExit: { baseRef: "main", projectChecks: [] },
      createRunner: () => runner,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      collectExitFacts: async () => measured.shift()!,
    });

    await expect(port.run(phaseInput("CODE"))).resolves.toMatchObject({
      artifacts: [{ kind: "implementation", body: "Done; committed." }],
    });
    const prompted = (runner.prompt as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]!);
    expect(prompted).toHaveLength(2);
    expect(prompted[1]).toContain("The worktree is not clean");
    expect(prompted[1]).toContain("no commit of its own");
  });

  it("gives up on a CODE exit that never satisfies its checks, with the findings attached", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      codeExit: { baseRef: "main", projectChecks: [], maxRounds: 2 },
      createRunner: () => fakeRunner(JSON.stringify({ implementation: "Done." })),
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      collectExitFacts: async () => ({
        uncommittedPaths: ["src/a.ts"],
        commitCount: 1,
        whitespaceErrors: [],
        redScenarioIds: [],
        greenScenarioIds: [],
        markedScenarioIds: [],
        dodScenarioIds: [],
        projectChecks: [],
      }),
    });

    await expect(port.run(phaseInput("CODE"))).rejects.toBeInstanceOf(CodeExitNotMetError);
  });

  it("hands a phase exit's findings back to the same session", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const runner = fakeRunner(JSON.stringify({ test_contract_yaml: "story_id: S-EPIC1-01" }));
    const verdicts = [
      { passed: false as const, findings: "The contract must be full, not narrow." },
      { passed: true as const },
    ];
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => runner,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run({
      ...phaseInput("SPECIFY"),
      exitGates: [{ name: "specify-exit", maxRounds: 3, exhausted: "fail", evaluate: async () => verdicts.shift()! }],
    })).resolves.toMatchObject({ exitGateRounds: { "specify-exit": 2 } });
    const prompted = (runner.prompt as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]!);
    expect(prompted).toHaveLength(2);
    expect(prompted[1]).toContain("The contract must be full");
  });

  it("runs every exit a phase has through one mechanism, in order", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const runner = fakeRunner(JSON.stringify({ test_contract_yaml: "story_id: S-EPIC1-01" }));
    const judged: string[] = [];
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => runner,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run({
      ...phaseInput("SPECIFY"),
      exitGates: [
        { name: "first", maxRounds: 2, exhausted: "fail", evaluate: async () => { judged.push("first"); return { passed: true }; } },
        { name: "second", maxRounds: 2, exhausted: "fail", evaluate: async () => { judged.push("second"); return { passed: true }; } },
      ],
    })).resolves.toMatchObject({ exitGateRounds: { first: 1, second: 1 } });
    expect(judged).toEqual(["first", "second"]);
  });

  it("ships what a gate with no veto could not get rewritten, rather than stalling the card", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const runner = fakeRunner(JSON.stringify({ test_contract_yaml: "story_id: S-EPIC1-01" }));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => runner,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run({
      ...phaseInput("SPECIFY"),
      exitGates: [{
        name: "prose", maxRounds: 2, exhausted: "ship",
        evaluate: async () => ({ passed: false, findings: "still reads like a transcript" }),
      }],
    })).resolves.toMatchObject({ exitGateRounds: { prose: 2 } });
  });

  it("gives up on a phase exit its own session cannot satisfy", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => fakeRunner(JSON.stringify({ test_contract_yaml: "story_id: S-EPIC1-01" })),
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run({
      ...phaseInput("SPECIFY"),
      exitGates: [{
        name: "specify-exit", maxRounds: 2, exhausted: "fail",
        evaluate: async () => ({ passed: false, findings: "still not red" }),
      }],
    })).rejects.toBeInstanceOf(PhaseExitNotMetError);
  });

  it("asks MERGE to rewrite a report whose business section reads like a transcript", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const replies = [
      JSON.stringify({ delivery_report: "Fixed src/console/data.ts." }),
      JSON.stringify({ delivery_report: "The board now shows the cards waiting on a person." }),
    ];
    const runner = fakeRunner("");
    runner.getMessages = vi.fn(async () => [
      { role: "assistant", content: [{ type: "text", text: replies.shift() ?? "" }] },
    ]);
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => runner,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run(phaseInput("MERGE"))).resolves.toMatchObject({
      artifacts: [{ kind: "delivery-report", body: "The board now shows the cards waiting on a person." }],
    });
    const prompted = (runner.prompt as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]!);
    expect(prompted[1]).toContain("a file path");
  });

  it("ships a report that is still technical after its rewrites rather than stalling the card", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => fakeRunner(JSON.stringify({ delivery_report: "Fixed src/console/data.ts." })),
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      maxReportRewrites: 1,
    });

    await expect(port.run(phaseInput("MERGE"))).resolves.toMatchObject({
      artifacts: [{ kind: "delivery-report", body: "Fixed src/console/data.ts." }],
    });
  });

  it("sends back the implementation prose the linter is blind to, and ships it anyway", async () => {
    // All Chinese, no path, no code block: lintBusinessLanguage has nothing to
    // say, so without the judge this goes out as the delivery report's
    // business section.
    const prose = "本次改动把缓存层抽出来，复用到三个调用点。";
    const runner = fakeRunner(JSON.stringify({ delivery_report: prose }));
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => runner,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
      maxReportRewrites: 1,
      readabilityJudge: {
        judge: { async ask() { return { answers: { is_implementation: { type: "noul", noul: 0.97 } } }; } },
        model: "jev-latest",
        threshold: 0.6,
      },
    });

    // Refused, rewritten, refused again -- and delivered, because this gate has
    // no veto. A probability may never stop a Story.
    await expect(port.run(phaseInput("MERGE"))).resolves.toMatchObject({
      artifacts: [{ kind: "delivery-report", body: prose }],
    });
    const prompted = (runner.prompt as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]!);
    expect(prompted[1]).toContain(prose);
  });

  it("fails closed before persistence when the phase output is not the declared JSON contract", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => fakeRunner("I am done"),
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run(phaseInput("CODE"))).rejects.toThrow(/invalid JSON/);
  });
});

describe("SHAPE acceptance criteria flattening", () => {
  let temporary: string;

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it("keeps the text of a nested criterion instead of stringifying the object away", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-dod-"));
    const reply = JSON.stringify({
      dod_yaml: {
        story_id: "S-EPIC1-01",
        acceptance_criteria: [
          // oxlint-disable-next-line unicorn/no-thenable -- the DoD grammar names this field
          { given: { customer: "has a coupon" }, then: "the discount is deducted once" },
        ],
      },
    });
    const port = new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => fakeRunner(reply, "fresh-design-session"),
      emit: () => undefined,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    const result = await port.run(phaseInput("SHAPE"));
    const dod = result.artifacts.find((item) => item.kind === "dod")?.body ?? "";
    expect(dod).not.toContain("[object Object]");
    expect(dod).toContain("has a coupon");
    expect(dod).toContain("the discount is deducted once");
  });

  async function shapePort(reply: string): Promise<PiStoryPhasePort> {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-dod-"));
    return new PiStoryPhasePort({
      binary: "pi",
      resolveSpec: async () => ({ spec: await testAgentSpec(), release: async () => undefined }),
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      createRunner: () => fakeRunner(reply, "fresh-design-session"),
      emit: () => undefined,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });
  }

  it("reads a DoD whose line breaks arrived as the two characters backslash and n", async () => {
    const reply = JSON.stringify({
      dod_yaml: "story_id: S-EPIC1-01\\nscenarios:\\n  - id: S-EPIC1-01-a\\n    then: it works",
    });
    const result = await (await shapePort(reply)).run(phaseInput("SHAPE"));
    const dod = result.artifacts.find((item) => item.kind === "dod")?.body ?? "";
    expect(dod).toContain("story_id: S-EPIC1-01\n");
    expect(dod).toContain("then: it works");
  });

  it("quotes a bare scenario sentence that YAML would otherwise read as a nested mapping", async () => {
    const reply = JSON.stringify({
      dod_yaml: "story_id: S-EPIC1-01\nscenarios:\n  - id: S-EPIC1-01-a\n    then: the page shows Unable to load: HTTP 503 and a Retry button\n",
    });
    const result = await (await shapePort(reply)).run(phaseInput("SHAPE"));
    const dod = result.artifacts.find((item) => item.kind === "dod")?.body ?? "";
    expect(dod).toContain("Unable to load: HTTP 503 and a Retry button");
  });
});
