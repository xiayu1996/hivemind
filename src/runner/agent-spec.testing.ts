import { ConfigStore } from "../config/store.js";
import type { ModelPurpose } from "../pipeline/phase.js";
import { resolveAgentSpec, type ResolvedAgentSpec } from "./agent-spec.js";
import { resolveModel } from "./model-resolver.js";

/**
 * Test support: a spec built through the real entry point.
 *
 * The brand on `ResolvedAgentSpec` exists so nothing assembles one by hand, so
 * tests go through `resolveAgentSpec` too, with a stub policy standing in for
 * the catalogue round trip. That keeps them honest about how a spawn is
 * actually configured instead of letting them invent a shape production never
 * produces.
 */
export async function testAgentSpec(options: {
  purpose?: ModelPurpose;
  provider?: string;
  modelId?: string;
  metered?: boolean;
} = {}): Promise<ResolvedAgentSpec> {
  const provider = options.provider ?? "mock";
  const modelId = options.modelId ?? "mock-1";
  const model = await resolveModel({ list: async () => [{ provider, id: modelId }] }, provider, modelId);
  return resolveAgentSpec({
    config: ConfigStore.defaults(),
    policy: {
      resolve: async () => model,
      providersFor: async () => [provider],
      tierOf: async () => "standard",
      isMetered: async () => options.metered ?? false,
    },
  }, options.purpose ?? "code", provider);
}
