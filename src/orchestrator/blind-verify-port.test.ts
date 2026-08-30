import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDoD } from "../pipeline/dod.js";
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
acceptance_criteria: [The scenario passes.]
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
      validationErrors: [],
      treeChanged: false,
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
});
