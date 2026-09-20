import { describe, expect, it } from "vitest";
import type { AgentRoleConfigurationBinding } from "../config/role-configuration-version.js";
import { ConfigStore } from "../config/store.js";
import * as agentSpecModule from "./agent-spec.js";
import type {
  AgentSpecSources,
  RoleAgentSpecResolutionResult,
} from "./agent-spec.js";
import { resolveModel } from "./model-resolver.js";

const oldBinding: AgentRoleConfigurationBinding = {
  agentRunId: "prototype-old",
  roleId: "prototype",
  roleVersion: 12,
  boundAt: "2026-06-19T02:00:00.000Z",
  content: {
    prompt: "先确认业务场景，再逐页绘制。",
    providerId: "anthropic",
    modelId: "claude-sonnet-4",
  },
};
const newBinding: AgentRoleConfigurationBinding = {
  agentRunId: "prototype-new",
  roleId: "prototype",
  roleVersion: 13,
  boundAt: "2026-06-20T02:00:00.000Z",
  content: {
    prompt: "先确认业务场景，并标明关键状态。",
    providerId: "openai",
    modelId: "gpt-5.2",
  },
};

type RoleResolver = (
  sources: AgentSpecSources,
  purpose: "prototype",
  binding: AgentRoleConfigurationBinding,
) => Promise<RoleAgentSpecResolutionResult>;

function roleResolver(): RoleResolver {
  const candidate = (agentSpecModule as unknown as { resolveRoleAgentSpec?: RoleResolver }).resolveRoleAgentSpec;
  expect(candidate, "resolveRoleAgentSpec must exist at runtime").toBeTypeOf("function");
  return candidate!;
}

async function sources(): Promise<AgentSpecSources> {
  const models = {
    anthropic: await resolveModel(
      { list: async () => [{ provider: "anthropic", id: "claude-sonnet-4" }] },
      "anthropic",
      "claude-sonnet-4",
    ),
    openai: await resolveModel(
      { list: async () => [{ provider: "openai", id: "gpt-5.2" }] },
      "openai",
      "gpt-5.2",
    ),
  };
  return {
    config: ConfigStore.defaults(),
    policy: {
      resolve: async (_purpose, provider) => {
        const model = models[provider as keyof typeof models];
        if (!model) throw new Error(`provider ${provider} unavailable`);
        return model;
      },
      providersFor: async () => ["anthropic", "openai"],
      tierOf: async () => "standard",
      isMetered: async (provider) => provider === "openai",
    },
  };
}

describe("resolving an agent from its bound role version", () => {
  it("@scenario S-R237511RC-02-future resolves continuing and newly started agents from their own complete bindings", async () => {
    const resolveRoleAgentSpec = roleResolver();
    const sharedSources = await sources();

    const continued = await resolveRoleAgentSpec(sharedSources, "prototype", oldBinding);
    const started = await resolveRoleAgentSpec(sharedSources, "prototype", newBinding);

    expect(continued).toMatchObject({
      status: "resolved",
      value: {
        binding: oldBinding,
        spec: {
          model: { provider: "anthropic", id: "claude-sonnet-4" },
          prompt: { text: oldBinding.content.prompt },
        },
      },
    });
    expect(started).toMatchObject({
      status: "resolved",
      value: {
        binding: newBinding,
        spec: {
          model: { provider: "openai", id: "gpt-5.2" },
          prompt: { text: newBinding.content.prompt },
        },
      },
    });
  });

  it("@scenario S-R237511RC-02-future fails closed instead of mixing a bound prompt with a replacement model", async () => {
    const resolveRoleAgentSpec = roleResolver();
    const replacement = await resolveModel(
      { list: async () => [{ provider: "anthropic", id: "claude-opus-4" }] },
      "anthropic",
      "claude-opus-4",
    );
    const mismatchedSources: AgentSpecSources = {
      config: ConfigStore.defaults(),
      policy: {
        resolve: async () => replacement,
        providersFor: async () => ["anthropic"],
        tierOf: async () => "standard",
        isMetered: async () => false,
      },
    };

    const result = await resolveRoleAgentSpec(mismatchedSources, "prototype", oldBinding);

    expect(result).toMatchObject({ status: "unavailable", reason: "model-unavailable", retryable: false });
    expect(JSON.stringify(result)).not.toContain("claude-opus-4");
  });
});
