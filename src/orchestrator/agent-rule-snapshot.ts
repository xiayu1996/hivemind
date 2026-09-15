import { AGENT_PHASES, PHASE_PURPOSE, type AgentPhase, type ModelPurpose, type ModelTier } from "../pipeline/phase.js";
import type { ConfigStore } from "../config/store.js";
import {
  isModelCompatibleWithAgent,
  type AgentRules,
  type AgentRulesValidationContext,
  type VersionedAgentRules,
} from "../config/agent-rules.js";
import type { AgentModelPolicy } from "../runner/agent-spec.js";
import { isMeteredProvider } from "../runner/provider-env.js";
import type { ProviderProfile } from "../runner/model-policy.js";
import {
  resolveModel,
  withThinkingLevel,
  type ModelCatalog,
  type ModelDescriptor,
  type ThinkingLevel,
} from "../runner/model-resolver.js";

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

/**
 * Canonical Agent type for each call site purpose. Several Agent types share a
 * purpose (CODE and REGRESSION_FIX, CLARIFY and PRD), and dispatch only knows
 * the purpose, so resolution and dispatch have to agree on one representative.
 * Purposes that belong to no Agent type (capacity_probe, triage) have no
 * per-execution candidates and are not dispatchable under a rule snapshot.
 */
const PURPOSE_AGENT_PHASE: Partial<Record<ModelPurpose, AgentPhase>> = (() => {
  const map: Partial<Record<ModelPurpose, AgentPhase>> = {};
  for (const phase of AGENT_PHASES) {
    const purpose = PHASE_PURPOSE[phase];
    if (map[purpose] === undefined) map[purpose] = phase;
  }
  return map;
})();

/**
 * Turns a saved rule plus the static catalogues into the ordered candidate
 * models every Agent type may run on. The global default pair leads; the saved
 * failover order then contributes each enabled provider's catalogued tier
 * assignment. Disabled providers, providers with no assignment for the tier,
 * and models incompatible with the Agent type are skipped, so an empty list is
 * impossible for a rule the validator accepted.
 */
export function resolveExecutionCandidates(
  rules: AgentRules,
  context: AgentRulesValidationContext,
): Readonly<Record<AgentPhase, readonly SnapshotModelCandidate[]>> {
  const resolved = {} as Record<AgentPhase, readonly SnapshotModelCandidate[]>;
  for (const requirement of context.agentTypes) {
    const candidates: SnapshotModelCandidate[] = [];
    const seen = new Set<string>();
    const offer = (provider: string, model: ModelDescriptor, order: number): void => {
      const key = `${provider}\u0000${model.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        provider,
        id: model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutput === undefined ? {} : { maxOutput: model.maxOutput }),
        ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
        ...(model.images === undefined ? {} : { images: model.images }),
        purpose: requirement.purpose,
        tier: requirement.tier,
        order,
      });
    };
    if (rules.providerStates[rules.defaultProvider] === "enabled") {
      const profile = context.configuredProviders[rules.defaultProvider];
      const preferred = profile?.catalogue.find((model) => model.id === rules.defaultModel);
      if (preferred && isModelCompatibleWithAgent(preferred, requirement)) {
        offer(rules.defaultProvider, preferred, 0);
      }
    }
    rules.failoverOrder.forEach((provider, index) => {
      if (rules.providerStates[provider] !== "enabled") return;
      const profile = context.configuredProviders[provider];
      if (!profile) return;
      const assignedId = profile.assignedModels[requirement.tier];
      if (assignedId === undefined) return;
      const assigned = profile.catalogue.find((model) => model.id === assignedId);
      if (assigned && isModelCompatibleWithAgent(assigned, requirement)) offer(provider, assigned, index + 1);
    });
    resolved[requirement.agentType] = candidates;
  }
  return resolved;
}

/** The snapshot's own candidate list is the only model catalogue dispatch is
 * allowed to resolve against, so a spawn cannot reach a model the execution
 * start did not record. */
function snapshotCatalog(snapshot: ExecutionAgentRuleSnapshot): ModelCatalog {
  return {
    async list(provider: string): Promise<ModelDescriptor[]> {
      const models = new Map<string, ModelDescriptor>();
      for (const phase of AGENT_PHASES) {
        for (const candidate of snapshot.candidatesByAgentType[phase] ?? []) {
          if (candidate.provider !== provider || models.has(candidate.id)) continue;
          models.set(candidate.id, candidate);
        }
      }
      return [...models.values()];
    },
  };
}

/**
 * The production dispatch boundary over one execution's snapshot. It answers
 * the same AgentModelPolicy questions the live ModelPolicy does, but providers
 * and models come from the persisted candidates and never from the current
 * global rule: a save mid-execution cannot re-resolve an execution already in
 * flight, and a disabled provider is absent for a new one. Tier, reasoning
 * effort and billing stay configuration, because the rule does not own them.
 */
export function agentModelPolicyFromSnapshot(
  snapshot: ExecutionAgentRuleSnapshot,
  config: ConfigStore,
): AgentModelPolicy {
  const policy = policyFromExecutionSnapshot(snapshot);
  const catalog = snapshotCatalog(snapshot);
  const phaseFor = (purpose: ModelPurpose): AgentPhase => {
    const phase = PURPOSE_AGENT_PHASE[purpose];
    if (!phase) {
      throw new Error(`purpose ${purpose} has no resolved Agent rules in execution ${snapshot.executionId}`);
    }
    return phase;
  };
  return {
    async providersFor(purpose) {
      return [...policy.providersFor(phaseFor(purpose))];
    },
    async tierOf(purpose) {
      const [first] = policy.candidatesFor(phaseFor(purpose));
      if (!first) throw new Error(`execution ${snapshot.executionId} resolved no candidate for ${purpose}`);
      return first.tier;
    },
    async resolve(purpose, provider) {
      const candidate = policy.resolve(phaseFor(purpose), provider);
      const levels = config.get("model.purposeThinking") as Partial<Record<ModelPurpose, ThinkingLevel>>;
      return withThinkingLevel(await resolveModel(catalog, provider, candidate.id), levels[purpose]);
    },
    async isMetered(provider) {
      const profiles = config.get("model.providers") as Record<string, ProviderProfile>;
      const profile = profiles[provider];
      if (!profile) throw new Error(`provider ${provider} is not configured`);
      return isMeteredProvider(profile);
    },
  };
}
