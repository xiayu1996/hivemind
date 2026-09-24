import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDoD } from "../pipeline/dod.js";
import { testAgentSpec } from "../runner/agent-spec.testing.js";
import { BlindVerifyStoryPort } from "./blind-verify-port.js";

const dod = parseDoD(`story_id: S-EPIC1-01
design_summary: Verify independently.
scenarios:
  - id: S-EPIC1-01-a
    given: A branch
    when: it is verified
    then: the scenario is observed
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The scenario passes.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
predicted_footprint: [src]
depends_on: []
`);

describe("BlindVerifyStoryPort", () => {
  it("passes only the DoD and CODE session identity into a fresh blind verification", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hivemind-blind-port-"));
    const run = vi.fn(async (input) => ({
      record: {
        cardId: input.cardId,
        round: input.round,
        codeSessionId: input.codeSessionId,
        verifySessionId: "session-verify",
        verdict: "accepted" as const,
        failedScenarios: [],
        evidenceDir: input.evidencePath,
        createdAt: 1,
      },
      screenshots: [],
      pages: [],
        reasons: [],
      validationErrors: [],
      treeChanged: false,
      runnerFailure: null,
      events: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      messages: [{ role: "assistant", content: "accepted" }],
    }));
    const port = new BlindVerifyStoryPort({
      executor: { run },
      worktreePath: "D:/worktree",
      evidenceRoot: temporary,
      auditPath: join(temporary, "tool-audit.jsonl"),
      allowedHosts: ["localhost"],
      resolveSpec: async () => ({ spec: await testAgentSpec({ purpose: "verify" }), release: async () => undefined }),
      commitMessages: async () => ["test(S-EPIC1-01-a): red", "feat(S-EPIC1-01-a): green"],
    });

    await expect(port.run({
      runId: "run-verify-1",
      round: 1,
      prompt: "model-visible phase prompt",
      context: {
        cardId: "S-EPIC1-01",
        phase: "VERIFY",
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
      codeSessionId: "session-code",
      definitionOfDone: dod,
    })).resolves.toMatchObject({
      sessionId: "session-verify",
      verdict: "accepted",
      failedScenarios: [],
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      codeSessionId: "session-code",
      declaredScenarioIds: ["S-EPIC1-01-a"],
      specification: expect.not.stringContaining("model-visible phase prompt"),
    }));
    await rm(temporary, { recursive: true, force: true });
  });

  it("starts the repository's application for the round and stops it when the round ends", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hivemind-blind-port-"));
    const appPort = 45_500 + Math.floor(Math.random() * 400);
    const run = vi.fn(async (input) => ({
      record: {
        cardId: input.cardId,
        round: input.round,
        codeSessionId: input.codeSessionId,
        verifySessionId: "session-verify",
        verdict: "accepted" as const,
        failedScenarios: [],
        evidenceDir: input.evidencePath,
        createdAt: 1,
      },
      screenshots: [],
      pages: [],
      reasons: [],
      validationErrors: [],
      treeChanged: false,
      runnerFailure: null,
      events: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      messages: [{ role: "assistant", content: "accepted" }],
    }));
    const port = new BlindVerifyStoryPort({
      executor: { run },
      worktreePath: process.cwd(),
      evidenceRoot: temporary,
      auditPath: join(temporary, "tool-audit.jsonl"),
      allowedHosts: ["localhost"],
      app: {
        command: [
          process.execPath,
          "-e",
          "const http = require('node:http'); http.createServer((q, r) => r.end('ok')).listen(Number(process.env.APP_PORT)); setInterval(() => undefined, 1000);",
        ],
        readyUrl: `http://127.0.0.1:${appPort}/`,
        timeoutMs: 10_000,
        env: { APP_PORT: String(appPort) },
      },
      resolveSpec: async () => ({ spec: await testAgentSpec({ purpose: "verify" }), release: async () => undefined }),
      commitMessages: async () => [],
    });

    await port.run({
      runId: "run-verify-1",
      round: 1,
      prompt: "model-visible phase prompt",
      context: {
        cardId: "S-EPIC1-01",
        phase: "VERIFY",
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
      codeSessionId: "session-code",
      definitionOfDone: dod,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      app: { url: `http://127.0.0.1:${appPort}/` },
      allowedHosts: ["localhost", "127.0.0.1"],
    }));
    await expect(fetch(`http://127.0.0.1:${appPort}/`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    await rm(temporary, { recursive: true, force: true });
  });
});
