import { describe, expect, it } from "vitest";
import { AGENT_PHASES, PHASE_PURPOSE, type AgentPhase } from "../pipeline/phase.js";
import type { VersionedAgentRules } from "../config/agent-rules.js";
import type {
  ExecutionAgentRuleSnapshot,
  ExecutionAgentRuleSnapshotRepository,
  SnapshotModelCandidate,
  StartExecutionRuleSnapshotInput,
} from "./agent-rule-snapshot.js";
import * as snapshotModule from "./agent-rule-snapshot.js";

const oldRules: VersionedAgentRules = {
  revision: 7,
  rules: {
    defaultProvider: "legacy",
    defaultModel: "legacy-model",
    providerStates: { legacy: "enabled", modern: "enabled" },
    failoverOrder: ["legacy", "modern"],
  },
};

const newRules: VersionedAgentRules = {
  revision: 8,
  rules: {
    defaultProvider: "modern",
    defaultModel: "modern-model",
    providerStates: { legacy: "disabled", modern: "enabled" },
    failoverOrder: ["legacy", "modern"],
  },
};

function candidate(provider: string, id: string, agentType: AgentPhase, order: number): SnapshotModelCandidate {
  return { provider, id, purpose: PHASE_PURPOSE[agentType], tier: "standard", order };
}

function candidates(provider: string, id: string): Readonly<Record<AgentPhase, readonly SnapshotModelCandidate[]>> {
  return Object.fromEntries(
    AGENT_PHASES.map((agentType) => [agentType, [candidate(provider, id, agentType, 0)]]),
  ) as unknown as Readonly<Record<AgentPhase, readonly SnapshotModelCandidate[]>>;
}

class InsertOnceSnapshotRepository implements ExecutionAgentRuleSnapshotRepository {
  readonly rows = new Map<string, ExecutionAgentRuleSnapshot>();

  async start(input: StartExecutionRuleSnapshotInput): Promise<ExecutionAgentRuleSnapshot> {
    const existing = this.rows.get(input.executionId);
    if (existing) return existing;
    const snapshot: ExecutionAgentRuleSnapshot = {
      executionId: input.executionId,
      ruleRevision: input.rules.revision,
      rules: structuredClone(input.rules.rules),
      candidatesByAgentType: structuredClone(input.candidatesByAgentType),
    };
    this.rows.set(input.executionId, snapshot);
    return snapshot;
  }

  async find(executionId: string): Promise<ExecutionAgentRuleSnapshot | null> {
    return this.rows.get(executionId) ?? null;
  }
}

function starter() {
  expect(typeof snapshotModule.startExecutionAgentRules).toBe("function");
  return snapshotModule.startExecutionAgentRules;
}

function policyFactory() {
  expect(typeof snapshotModule.policyFromExecutionSnapshot).toBe("function");
  return snapshotModule.policyFromExecutionSnapshot;
}

describe("execution Agent rule snapshots", () => {
  it("@scenario S-AGENTRULES-01-lifecycle keeps execution A on its insert-once old snapshot while B starts on the new rule", async () => {
    const repository = new InsertOnceSnapshotRepository();
    const start = starter();
    const firstA = await start(repository, {
      executionId: "execution-a",
      rules: oldRules,
      candidatesByAgentType: candidates("legacy", "legacy-model"),
    });

    const resumedA = await start(repository, {
      executionId: "execution-a",
      rules: newRules,
      candidatesByAgentType: candidates("modern", "modern-model"),
    });
    const firstB = await start(repository, {
      executionId: "execution-b",
      rules: newRules,
      candidatesByAgentType: candidates("modern", "modern-model"),
    });

    expect(firstA).toEqual(resumedA);
    expect(resumedA.ruleRevision).toBe(7);
    expect(resumedA.rules.defaultProvider).toBe("legacy");
    expect(resumedA.candidatesByAgentType.CODE.map(({ provider, id }) => ({ provider, id }))).toEqual([
      { provider: "legacy", id: "legacy-model" },
    ]);
    expect(firstB.ruleRevision).toBe(8);
    expect(firstB.candidatesByAgentType.CODE.map((entry) => entry.provider)).toEqual(["modern"]);
  });

  it("@scenario S-AGENTRULES-01-lifecycle dispatch policy never reloads a newer global rule for an active execution", () => {
    const snapshot: ExecutionAgentRuleSnapshot = {
      executionId: "execution-a",
      ruleRevision: 7,
      rules: structuredClone(oldRules.rules),
      candidatesByAgentType: candidates("legacy", "legacy-model"),
    };
    const policy = policyFactory()(snapshot);

    expect(policy.snapshot.ruleRevision).toBe(7);
    expect(policy.providersFor("CODE")).toEqual(["legacy"]);
    expect(policy.resolve("CODE", "legacy")).toMatchObject({ provider: "legacy", id: "legacy-model" });
    expect(policy.providersFor("CODE")).not.toContain(newRules.rules.defaultProvider);
  });

  it("@scenario S-AGENTRULES-01-save retains a disabled provider in saved order but excludes it from new dispatch candidates", () => {
    const snapshot: ExecutionAgentRuleSnapshot = {
      executionId: "execution-b",
      ruleRevision: 8,
      rules: structuredClone(newRules.rules),
      candidatesByAgentType: candidates("modern", "modern-model"),
    };
    const policy = policyFactory()(snapshot);

    expect(policy.snapshot.rules.failoverOrder).toEqual(["legacy", "modern"]);
    expect(policy.providersFor("VERIFY")).toEqual(["modern"]);
    expect(() => policy.resolve("VERIFY", "legacy")).toThrow(/legacy|candidate|provider/i);
  });
});
