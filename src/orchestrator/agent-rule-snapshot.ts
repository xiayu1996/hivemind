import { AGENT_PHASES, type AgentPhase, type ModelPurpose, type ModelTier } from "../pipeline/phase.js";
import type { AgentRules, VersionedAgentRules } from "../config/agent-rules.js";
import type { ModelDescriptor } from "../runner/model-resolver.js";

export interface SnapshotModelCandidate extends ModelDescriptor {
  purpose: ModelPurpose;
  tier: ModelTier;
  /** Zero is the compatible global default pair; later values preserve the
   * saved failover order after disabled and incompatible providers are skipped. */
  order: number;
}

export interface ExecutionAgentRuleSnapshot {
  executionId: string;
  ruleRevision: number;
  rules: AgentRules;
  candidatesByAgentType: Readonly<Record<AgentPhase, readonly SnapshotModelCandidate[]>>;
}

export interface StartExecutionRuleSnapshotInput {
  executionId: string;
  rules: VersionedAgentRules;
  /** Fully resolved from the static catalogues at execution start. */
  candidatesByAgentType: Readonly<Record<AgentPhase, readonly SnapshotModelCandidate[]>>;
}

/**
 * Owns immutable per-execution rule snapshots in central libsql. start is an
 * insert-if-absent transaction keyed by executionId: concurrent starters and
 * crash recovery all receive the first committed snapshot. Global saves never
 * update or delete these rows, so an active execution is not cancelled or
 * re-resolved when the global revision changes.
 */
export interface ExecutionAgentRuleSnapshotRepository {
  start(input: StartExecutionRuleSnapshotInput): Promise<ExecutionAgentRuleSnapshot>;
  find(executionId: string): Promise<ExecutionAgentRuleSnapshot | null>;
}

/** Captures candidates for every registered Agent type before execution state
 * can advance. An empty candidate list is impossible for a successfully saved
 * rule and is treated as corrupt persisted configuration. */
export async function startExecutionAgentRules(
  repository: ExecutionAgentRuleSnapshotRepository,
  input: StartExecutionRuleSnapshotInput,
): Promise<ExecutionAgentRuleSnapshot> {
  const snapshot = await repository.start(input);
  const unresolved = AGENT_PHASES.filter(
    (agentType) => (snapshot.candidatesByAgentType[agentType]?.length ?? 0) === 0,
  );
  if (unresolved.length > 0) {
    throw new Error(
      `execution ${snapshot.executionId} has no resolved model candidate for: ${unresolved.join(", ")}`,
    );
  }
  return snapshot;
}

/** Execution-scoped model-policy boundary consumed by dispatch. It selects only
 * from the persisted candidate list; runtime breaker and credential checks may
 * skip a candidate but cannot consult a newer global rule revision. */
export interface ExecutionAgentRulePolicy {
  snapshot: ExecutionAgentRuleSnapshot;
  candidatesFor(agentType: AgentPhase): readonly SnapshotModelCandidate[];
  providersFor(agentType: AgentPhase): readonly string[];
  resolve(agentType: AgentPhase, provider: string): SnapshotModelCandidate;
}

export function policyFromExecutionSnapshot(
  snapshot: ExecutionAgentRuleSnapshot,
): ExecutionAgentRulePolicy {
  /** Candidates arrive in failover order, but sorting on the recorded order
   * keeps the contract independent of how the caller assembled the list. */
  const candidatesFor = (agentType: AgentPhase): readonly SnapshotModelCandidate[] =>
    (snapshot.candidatesByAgentType[agentType] ?? []).toSorted((left, right) => left.order - right.order);

  return {
    snapshot,
    candidatesFor,
    providersFor(agentType) {
      const providers: string[] = [];
      for (const candidate of candidatesFor(agentType)) {
        if (!providers.includes(candidate.provider)) providers.push(candidate.provider);
      }
      return providers;
    },
    resolve(agentType, provider) {
      const candidate = candidatesFor(agentType).find((entry) => entry.provider === provider);
      if (!candidate) {
        throw new Error(`no resolved model candidate for provider ${provider} on ${agentType}`);
      }
      return candidate;
    },
  };
}
