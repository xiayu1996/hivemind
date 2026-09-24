import type { ConfigStore } from "../config/store.js";
import { MODEL_PURPOSES, type ModelPurpose, type ModelTier } from "../pipeline/phase.js";
import type { ModelCatalog, ResolvedModel } from "./model-resolver.js";
import { ModelPolicy } from "./model-policy.js";
import {
  installSolPiConfig,
  OBSERVATION_PACK_TOOL,
  renderSolPiConfig,
  type SolPiConfig,
} from "./sol-pi.js";

/**
 * The one place a spawn's seven dimensions are decided.
 *
 * Model, effort, prompt, tools, guard, context, skills and MCP used to be
 * settled in four different files, and three of them were literals repeated
 * per port. The consequences were not theoretical: the Story path read only
 * `.id` off the resolved model, so the configured reasoning effort and tier
 * never reached a card, and cost rows were written with a hardcoded purpose so
 * nothing could be attributed per phase.
 *
 * The result carries a brand so that it cannot be assembled by hand. A spawn
 * accepts only a branded spec, which is what makes "pass the model string
 * straight through" a compile error rather than a silent downgrade.
 */

const BRAND: unique symbol = Symbol("ResolvedAgentSpec");

export interface AgentLimits {
  promptTimeoutMs?: number;
  maxContinueRetries?: number;
  toolOutputMaxBytes?: number;
  toolOutputMaxLines?: number;
}

export interface AgentGuardOverrides {
  fencedPatterns?: string[];
  e2eHostAllowlist?: string[];
}

export interface AgentPromptOverride {
  /** Replaces the phase layer entirely. */
  text?: string;
  /** Appended after the phase layer. */
  append?: string;
}

export interface ResolvedAgentSpec {
  readonly [BRAND]: true;
  purpose: ModelPurpose;
  tier: ModelTier;
  model: ResolvedModel;
  /**
   * Whether this execution spends real money. It belongs on the spec rather
   * than on the process: a card that starts on a subscription and fails over
   * to a metered API changes the answer mid-card, and reading it once at
   * startup is how such a card ran with no ceiling attached at all.
   */
  metered: boolean;
  /** Sorted and deduplicated: the tool block leads the cached prefix, so its
   * byte order has to be a function of the configuration, not of iteration. */
  tools: readonly string[];
  prompt: AgentPromptOverride;
  guard: AgentGuardOverrides;
  contextPaths: readonly string[];
  limits: AgentLimits;
  skills: readonly string[];
  mcpServers: readonly string[];
  /**
   * SoL-Pi mechanisms this spawn runs. It sits on the spec so that the tool
   * block and the extension list come from one decision: ObservationPack hands
   * the model a handle it can only open with `obs_recall`, so a spawn that
   * loads the extension without the tool, or the tool without the extension,
   * is broken in a way neither half can detect.
   */
  solPi: SolPiConfig;
}

/** The default tool set, used for any purpose the config does not name. */
export const DEFAULT_AGENT_TOOLS = ["bash", "edit", "grep", "find", "ls", "read", "write"] as const;

function stableList(values: readonly string[] | undefined, fallback: readonly string[]): string[] {
  return [...new Set(values ?? fallback)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

type PurposeMap<T> = Partial<Record<ModelPurpose, T>>;

/**
 * The part of the model policy a spec needs. Stated as an interface so that a
 * caller holding a model catalogue of its own can supply one, and so that the
 * brand stays sealed: there is no second way to build a spec, only a second
 * way to answer "which model serves this purpose on this provider".
 */
export interface AgentModelPolicy {
  resolve(purpose: ModelPurpose, provider: string): Promise<ResolvedModel>;
  providersFor(purpose: ModelPurpose): Promise<string[]>;
  tierOf(purpose: ModelPurpose): Promise<ModelTier>;
  /** Whether tokens on this provider cost money as they are spent. */
  isMetered(provider: string): Promise<boolean>;
}

export interface AgentSpecSources {
  config: ConfigStore;
  catalog?: ModelCatalog;
  policy?: AgentModelPolicy;
  /** Where this host's SoL-Pi reads its mechanism switches. Left out in tests
   * and anywhere no pi is spawned, which then renders nothing. The same
   * reasoning as the provider declaration: pi is a separate process that reads
   * the file off disk, so the configuration has to be written before a spawn,
   * and doing it here means every spawn passes the one place that decides it. */
  solPiConfigPath?: string;
}

function policyOf(sources: AgentSpecSources): AgentModelPolicy {
  if (sources.policy) return sources.policy;
  if (!sources.catalog) throw new Error("resolveAgentSpec needs either a model policy or a catalogue");
  return new ModelPolicy(sources.config, sources.catalog);
}

/**
 * Resolves every dimension for one spawn. `provider` is the one this attempt
 * actually runs on, so a failover to another provider re-resolves rather than
 * reusing the spec the card started with -- the model, its price and its
 * billing all change with it.
 */
export async function resolveAgentSpec(
  sources: AgentSpecSources,
  purpose: ModelPurpose,
  provider: string,
): Promise<ResolvedAgentSpec> {
  const { config } = sources;
  await config.reload();
  const policy = policyOf(sources);
  const [model, tier, metered] = await Promise.all([
    policy.resolve(purpose, provider),
    policy.tierOf(purpose),
    policy.isMetered(provider),
  ]);

  const tools = config.get("agent.purposeTools") as PurposeMap<string[]>;
  const prompts = config.get("agent.purposePrompts") as PurposeMap<AgentPromptOverride>;
  const guard = config.get("agent.purposeGuard") as PurposeMap<AgentGuardOverrides>;
  const context = config.get("agent.purposeContext") as PurposeMap<string[]>;
  const limits = config.get("agent.purposeLimits") as PurposeMap<AgentLimits>;
  const skills = config.get("agent.purposeSkills") as PurposeMap<string[]>;
  const mcp = config.get("agent.purposeMcp") as PurposeMap<string[]>;
  const solPi = config.get("agent.solPi") as SolPiConfig;
  if (sources.solPiConfigPath !== undefined) {
    await installSolPiConfig(renderSolPiConfig(solPi), sources.solPiConfigPath);
  }

  return {
    [BRAND]: true,
    purpose,
    tier,
    model,
    metered,
    // `code` carries the default set so that one edit moves every phase at
    // once; a purpose naming its own set opts out deliberately.
    // `obs_recall` rides with the mechanism that creates the handles it opens,
    // so it cannot be listed for a spawn that does not load ObservationPack.
    tools: stableList(
      [...(tools[purpose] ?? tools.code ?? DEFAULT_AGENT_TOOLS),
        ...(solPi.observationPack ? [OBSERVATION_PACK_TOOL] : [])],
      DEFAULT_AGENT_TOOLS,
    ),
    prompt: prompts[purpose] ?? {},
    guard: guard[purpose] ?? {},
    contextPaths: stableList(context[purpose], []),
    limits: limits[purpose] ?? {},
    skills: stableList(skills[purpose], []),
    mcpServers: stableList(mcp[purpose], []),
    solPi,
  };
}

/**
 * Startup gate over every purpose, alongside `assertModelPolicy`. It answers
 * the question a spawn cannot: does each declared call site resolve at all, on
 * the providers its tier is allowed to use.
 */
export async function assertAgentSpecs(sources: AgentSpecSources): Promise<void> {
  const { config } = sources;
  await config.reload();
  const policy = policyOf(sources);
  const failures: string[] = [];
  for (const purpose of MODEL_PURPOSES) {
    let providers: string[];
    try {
      providers = await policy.providersFor(purpose);
    } catch (cause) {
      failures.push(`${purpose}: ${(cause as Error).message}`);
      continue;
    }
    if (providers.length === 0) {
      failures.push(`${purpose}: no provider in the failover chain serves its tier`);
      continue;
    }
    for (const provider of providers) {
      try {
        await resolveAgentSpec({ ...sources, policy }, purpose, provider);
      } catch (cause) {
        failures.push(`${purpose}/${provider}: ${(cause as Error).message}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`agent specs do not resolve: ${failures.toSorted().join(", ")}`);
  }
}
