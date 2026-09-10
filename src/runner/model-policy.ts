import type { ConfigStore } from "../config/store.js";
import { resolveModel, withThinkingLevel, type ModelCatalog, type ResolvedModel, type ThinkingLevel } from "./model-resolver.js";

/** Every call site that spends tokens. A new one must be declared here and
 * given a tier in config; there is no default tier for an unknown purpose. */
export const MODEL_PURPOSES = [
  "product_manager",
  "decompose",
  "design",
  "code",
  "verify",
  "merge",
  "capacity_probe",
  "triage",
  "distiller",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];
export type ModelTier = "brain" | "standard" | "cheap";

export interface ProviderProfile {
  authType: "api_key" | "oauth";
  envKey?: string;
  /** Whether tokens cost money as they are spent; see `isMeteredProvider`. */
  billing?: "subscription" | "metered";
  tiers: Partial<Record<ModelTier, string>>;
}

type ProviderProfiles = Record<string, ProviderProfile>;

/**
 * The single entry point from a purpose to a spawnable model. pi accepts an
 * unknown model id with only a warning and then invents pricing for it, so the
 * id is always checked against the provider's own catalogue before it escapes.
 */
export class ModelPolicy {
  constructor(
    private readonly config: ConfigStore,
    private readonly catalog: ModelCatalog,
  ) {}

  async tierOf(purpose: ModelPurpose): Promise<ModelTier> {
    await this.config.reload();
    const tiers = this.config.get("model.purposeTiers") as Partial<Record<ModelPurpose, ModelTier>>;
    const tier = tiers[purpose];
    if (!tier) throw new Error(`no tier is configured for purpose ${purpose}`);
    return tier;
  }

  /** The reasoning effort this call site asks for, before the model is consulted. */
  thinkingFor(purpose: ModelPurpose): ThinkingLevel | undefined {
    const levels = this.config.get("model.purposeThinking") as Partial<Record<ModelPurpose, ThinkingLevel>>;
    return levels[purpose];
  }

  async resolve(purpose: ModelPurpose, provider: string): Promise<ResolvedModel> {
    const tier = await this.tierOf(purpose);
    const profiles = this.config.get("model.providers") as ProviderProfiles;
    const id = profiles[provider]?.tiers[tier];
    if (!id) throw new Error(`provider ${provider} has no model configured for the ${tier} tier`);
    // The effort rides on the model so that every port relays it for free.
    return withThinkingLevel(await resolveModel(this.catalog, provider, id), this.thinkingFor(purpose));
  }

  /** The profile of a provider hivemind is configured to spawn. */
  async profileOf(provider: string): Promise<ProviderProfile> {
    await this.config.reload();
    const profile = (this.config.get("model.providers") as ProviderProfiles)[provider];
    if (!profile) throw new Error(`provider ${provider} is not configured`);
    return profile;
  }

  /** The failover chain narrowed to the providers that declare a model for the
   * purpose's tier, in chain order. Health is a separate concern. */
  async providersFor(purpose: ModelPurpose): Promise<string[]> {
    const tier = await this.tierOf(purpose);
    const profiles = this.config.get("model.providers") as ProviderProfiles;
    const chain = this.config.get("model.failoverChain");
    return chain.filter((provider) => profiles[provider]?.tiers[tier] !== undefined);
  }
}

/** Startup gate: every configured id must exist in its provider's catalogue.
 * A typo here is otherwise discovered as an invented price on a real run. */
export async function assertModelPolicy(config: ConfigStore, catalog: ModelCatalog): Promise<void> {
  await config.reload();
  const profiles = config.get("model.providers") as ProviderProfiles;
  const failures: string[] = [];
  for (const [provider, profile] of Object.entries(profiles)) {
    for (const [tier, id] of Object.entries(profile.tiers)) {
      try {
        await resolveModel(catalog, provider, id);
      } catch {
        failures.push(`${tier}/${provider}: ${id}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`model policy names ids no provider catalogue lists: ${failures.toSorted().join(", ")}`);
  }
}
