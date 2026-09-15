import { CONFIG_KEYS } from "../config/registry.js";
import { ConfigStore } from "../config/store.js";
import {
  initialAgentRules,
  InMemoryAgentRulesRepository,
} from "../config/agent-rules-repository.js";
import type { AgentCompatibilityRequirement, AgentRulesValidationContext } from "../config/agent-rules.js";
import { AGENT_PHASES, PHASE_PURPOSE, type AgentPhase, type ModelTier } from "../pipeline/phase.js";
import { snapshotCatalog } from "../runner/catalog-snapshot.js";
import type { ModelCatalog, ModelDescriptor } from "../runner/model-resolver.js";
import { createConsoleAgentRulesService, type AgentRulesCatalogueSource, type ConsoleAgentRulesService } from "./agent-rules.js";

/**
 * What each registered Agent type needs from a model, independent of which
 * provider serves it. `thinking` marks the phases that read a person's words or
 * judge whether a claim is true, so the coverage rule can strand them when no
 * enabled provider serves a reasoning model. `images` marks the phases whose
 * own work is reading rendered or attached evidence, so a provider set that
 * cannot see is a real gap for them.
 *
 * The browser lanes are deliberately split. E2E drives Playwright itself and
 * compares structured output, so it consumes no image input of its own, while
 * the optional screen-acceptance lane (UI_REVIEW) resolves its own model and
 * turns itself off when that model cannot see (scripts/run-story.ts), so image
 * support there is a dispatch-time preference and not a rule that has to stay
 * satisfiable before a save is allowed.
 *
 * This is code, not configuration: it is what "this Agent type can run at all"
 * means, and an operator who could edit it could make the coverage rule pass by
 * lowering the bar instead of by enabling a provider.
 */
export const AGENT_REQUIRED_CAPABILITIES: Record<AgentPhase, { images?: true; thinking?: true }> = {
  SHAPE: { images: true, thinking: true },
  DESIGN: { thinking: true },
  SPECIFY: { thinking: true },
  CODE: {},
  VERIFY: { images: true },
  MERGE: {},
  REGRESSION_FIX: {},
  DECOMPOSE: { thinking: true },
  CLARIFY: { thinking: true },
  PRD: { thinking: true },
  REQUIREMENT_DECOMPOSE: { thinking: true },
  UI_REVIEW: { thinking: true },
  E2E: {},
  DISTILL: {},
  REPORT: {},
};

/** Tier an Agent type runs at when `model.purposeTiers` names none. */
const DEFAULT_TIER: ModelTier = "standard";

/**
 * Turns the declared provider universe and the recorded model catalogues into
 * the static facts the rule validator judges. Only enabled state, order
 * membership, catalogued assignments and this module's capability requirements
 * enter it: breakers, quota windows and credential probes are never read, so a
 * transient outage cannot change whether a rule saves.
 */
export function createAgentRulesCatalogueSource(
  config: ConfigStore,
  catalog: ModelCatalog,
): AgentRulesCatalogueSource {
  return {
    async validationContext(): Promise<AgentRulesValidationContext> {
      const providers = config.get("model.providers");
      const purposeTiers = config.get("model.purposeTiers");
      const configuredProviders: Record<string, {
        catalogue: readonly ModelDescriptor[];
        assignedModels: Partial<Record<ModelTier, string>>;
      }> = {};
      for (const [provider, profile] of Object.entries(providers)) {
        configuredProviders[provider] = {
          catalogue: await catalog.list(provider),
          assignedModels: profile.tiers,
        };
      }
      const agentTypes: AgentCompatibilityRequirement[] = AGENT_PHASES.map((agentType) => {
        const purpose = PHASE_PURPOSE[agentType];
        return {
          agentType,
          purpose,
          tier: purposeTiers[purpose] ?? DEFAULT_TIER,
          requiredCapabilities: AGENT_REQUIRED_CAPABILITIES[agentType],
        };
      });
      return { agentTypes, configuredProviders };
    },
  };
}

/**
 * The rules surface a console with no central database still hosts. Its initial
 * rule is the code default, which is the fallback truth the pipeline itself
 * runs on, and its catalogue is the recorded snapshot, so the page is identical
 * on a machine with no pi and no credentials. The orchestrator injects the
 * libsql-backed service instead; this exists so the page is never absent.
 */
export function createDefaultAgentRulesService(): ConsoleAgentRulesService {
  return createConsoleAgentRulesService(
    new InMemoryAgentRulesRepository(initialAgentRules(
      CONFIG_KEYS["model.providers"].default,
      CONFIG_KEYS["model.failoverChain"].default,
    )),
    createAgentRulesCatalogueSource(ConfigStore.defaults(), snapshotCatalog()),
  );
}
