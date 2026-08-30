import type { ConfigStore } from "../config/store.js";
import { resolveModel, type ModelCatalog, type ResolvedModel } from "./model-resolver.js";

/** Every call site that spends tokens. A new one must be declared here and
 * given a tier in config; there is no default tier for an unknown purpose. */
export const MODEL_PURPOSES = [
  "decompose",
  "design",
  "code",
  "verify",
  "merge",
  "completion_judge",
  "capacity_probe",
  "triage",
  "distiller",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];
export type ModelTier = "brain" | "standard" | "cheap";

type TierMap = Partial<Record<ModelTier, Record<string, string>>>;

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

  async resolve(purpose: ModelPurpose, provider: string): Promise<ResolvedModel> {
    const tier = await this.tierOf(purpose);
    const tierMap = this.config.get("model.tierMap") as TierMap;
    const id = tierMap[tier]?.[provider];
    if (!id) throw new Error(`provider ${provider} has no model configured for the ${tier} tier`);
    return resolveModel(this.catalog, provider, id);
  }

  /** The failover chain narrowed to the providers that declare a model for the
   * purpose's tier, in chain order. Health is a separate concern. */
  async providersFor(purpose: ModelPurpose): Promise<string[]> {
    const tier = await this.tierOf(purpose);
    const tierMap = this.config.get("model.tierMap") as TierMap;
    const chain = this.config.get("model.failoverChain");
    return chain.filter((provider) => tierMap[tier]?.[provider] !== undefined);
  }
}

/** Startup gate: every configured id must exist in its provider's catalogue.
 * A typo here is otherwise discovered as an invented price on a real run. */
export async function assertModelPolicy(config: ConfigStore, catalog: ModelCatalog): Promise<void> {
  await config.reload();
  const tierMap = config.get("model.tierMap") as TierMap;
  const failures: string[] = [];
  for (const [tier, providers] of Object.entries(tierMap)) {
    for (const [provider, id] of Object.entries(providers ?? {})) {
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
