import type { AgentPhase, ModelPurpose, ModelTier } from "../pipeline/phase.js";
import type { ModelDescriptor } from "../runner/model-resolver.js";

export type ProviderRuleState = "enabled" | "disabled";

export type AgentRuleConfigKey =
  | "model.defaultProvider"
  | "model.defaultModel"
  | "model.providerStates"
  | "model.failoverChain";

export type UnavailableAgentTypesMessage =
  `Cannot save rules. No available provider for: ${string}.`;

/** The four operator-owned values edited as one logical rule. Provider profiles,
 * credentials, catalogues, and transient health remain outside this boundary. */
export interface AgentRules {
  defaultProvider: string;
  defaultModel: string;
  providerStates: Readonly<Record<string, ProviderRuleState>>;
  failoverOrder: readonly string[];
}

export interface VersionedAgentRules {
  revision: number;
  rules: AgentRules;
}

/** Code-owned compatibility metadata for one registered Agent type. */
export interface AgentCompatibilityRequirement {
  agentType: AgentPhase;
  purpose: ModelPurpose;
  tier: ModelTier;
  requiredCapabilities: {
    images?: true;
    thinking?: true;
  };
}

/** Static save-time facts. No breaker, quota, credential, or probe state is
 * accepted here, so a transient outage cannot change whether a rule saves. */
export interface AgentRulesValidationContext {
  agentTypes: readonly AgentCompatibilityRequirement[];
  configuredProviders: Readonly<Record<string, {
    catalogue: readonly ModelDescriptor[];
    assignedModels: Partial<Record<ModelTier, string>>;
  }>>;
}

export type InvalidAgentRuleField = "defaultProvider" | "defaultModel";

export type AgentRulesRejection =
  | {
      kind: "invalid_default";
      field: InvalidAgentRuleField;
      message: string;
    }
  | {
      kind: "unavailable_agent_types";
      /** Unique Agent names in stable lexical order. */
      affectedAgentTypes: readonly AgentPhase[];
      message: UnavailableAgentTypesMessage;
    }
  | {
      kind: "invalid_provider_set";
      field: "providerStates" | "failoverOrder";
      message: string;
    };

export type AgentRulesValidation =
  | { accepted: true; rules: AgentRules }
  | { accepted: false; rejection: AgentRulesRejection };

/**
 * Validates the complete proposal before persistence. Every configured provider
 * must occur exactly once in both providerStates and failoverOrder. The default
 * provider must be enabled and its default model must occur in that provider's
 * catalogue. Availability means an enabled provider in failover order has a
 * catalogued assigned model compatible with the Agent type; the default pair is
 * considered first when compatible.
 */
export function validateAgentRules(
  proposal: AgentRules,
  context: AgentRulesValidationContext,
): AgentRulesValidation {
  const configured = Object.keys(context.configuredProviders).toSorted();
  const order = proposal.failoverOrder;
  if (order.length !== new Set(order).size || !sameNames([...order].toSorted(), configured)) {
    return {
      accepted: false,
      rejection: {
        kind: "invalid_provider_set",
        field: "failoverOrder",
        message: "The failover order must name every configured provider exactly once.",
      },
    };
  }
  if (!sameNames(Object.keys(proposal.providerStates).toSorted(), configured)) {
    return {
      accepted: false,
      rejection: {
        kind: "invalid_provider_set",
        field: "providerStates",
        message: "The provider states must name every configured provider exactly once.",
      },
    };
  }
  return { accepted: true, rules: proposal };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** Produces the exact user-facing coverage rejection after sorting and
 * deduplicating Agent names. */
export declare function formatUnavailableAgentTypes(
  agentTypes: readonly AgentPhase[],
): UnavailableAgentTypesMessage;

export interface ReplaceAgentRulesInput {
  proposal: AgentRules;
  expectedRevision: number;
  updatedBy: string;
  validation: AgentRulesValidationContext;
}

export type ReplaceAgentRulesResult =
  | { saved: true; current: VersionedAgentRules }
  | { saved: false; reason: "validation"; current: VersionedAgentRules; rejection: AgentRulesRejection }
  | { saved: false; reason: "revision_conflict"; current: VersionedAgentRules };

/**
 * Owns the global rule in central libsql. replace serializes concurrent saves
 * with an expected-revision CAS and one transaction spanning all rule keys and
 * their history rows. Validation or conflict writes none of the proposed
 * fields; readers observe either the old complete rule or the new complete rule.
 */
export interface AgentRulesRepository {
  read(): Promise<VersionedAgentRules>;
  replace(input: ReplaceAgentRulesInput): Promise<ReplaceAgentRulesResult>;
}
