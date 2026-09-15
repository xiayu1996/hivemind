import type { AgentPhase, ModelPurpose, ModelTier } from "../pipeline/phase.js";
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
export declare function startExecutionAgentRules(
  repository: ExecutionAgentRuleSnapshotRepository,
  input: StartExecutionRuleSnapshotInput,
): Promise<ExecutionAgentRuleSnapshot>;

/** Execution-scoped model-policy boundary consumed by dispatch. It selects only
 * from the persisted candidate list; runtime breaker and credential checks may
 * skip a candidate but cannot consult a newer global rule revision. */
export interface ExecutionAgentRulePolicy {
  snapshot: ExecutionAgentRuleSnapshot;
  candidatesFor(agentType: AgentPhase): readonly SnapshotModelCandidate[];
  providersFor(agentType: AgentPhase): readonly string[];
  resolve(agentType: AgentPhase, provider: string): SnapshotModelCandidate;
}

export declare function policyFromExecutionSnapshot(
  snapshot: ExecutionAgentRuleSnapshot,
): ExecutionAgentRulePolicy;
