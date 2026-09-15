import type { Client } from "@libsql/client";
import type { ConfigStore } from "../config/store.js";
import { initialAgentRules, LibsqlAgentRulesRepository } from "../config/agent-rules-repository.js";
import { createAgentRulesCatalogueSource } from "../console/agent-rules-source.js";
import type { AgentModelPolicy } from "../runner/agent-spec.js";
import type { ModelCatalog } from "../runner/model-resolver.js";
import {
  agentModelPolicyFromSnapshot,
  resolveExecutionCandidates,
  startExecutionAgentRules,
  type ExecutionAgentRuleSnapshot,
} from "./agent-rule-snapshot.js";
import { LibsqlExecutionAgentRuleSnapshotRepository } from "./execution-rule-snapshot-store.js";

export interface OpenExecutionAgentRulesInput {
  client: Client;
  /** Stable identity of one execution. The same id across restarts is what
   * makes crash recovery read back the snapshot it started with. */
  executionId: string;
  config: ConfigStore;
  catalog: ModelCatalog;
}

export interface OpenedExecutionAgentRules {
  snapshot: ExecutionAgentRuleSnapshot;
  policy: AgentModelPolicy;
}

/**
 * The one production entry point that turns the operator's saved global rule
 * into dispatch. It reads the rule once, resolves the candidates every Agent
 * type may run on from the static catalogues, persists them insert-once, and
 * hands back a policy that reads only that snapshot. Called before a Story
 * spawns anything, it is why a save mid-execution cannot re-resolve a card
 * already in flight, and why a card that has not started picks up the new rule
 * and skips providers the new rule disabled.
 */
export async function openExecutionAgentRules(
  input: OpenExecutionAgentRulesInput,
): Promise<OpenedExecutionAgentRules> {
  const fallback = initialAgentRules(
    input.config.get("model.providers"),
    input.config.get("model.failoverChain"),
  );
  const rules = await new LibsqlAgentRulesRepository(input.client, fallback).read();
  const validation = await createAgentRulesCatalogueSource(input.config, input.catalog).validationContext();
  const candidates = resolveExecutionCandidates(rules.rules, validation);
  const snapshot = await startExecutionAgentRules(
    new LibsqlExecutionAgentRuleSnapshotRepository(input.client),
    { executionId: input.executionId, rules, candidatesByAgentType: candidates },
  );
  return { snapshot, policy: agentModelPolicyFromSnapshot(snapshot, input.config) };
}
