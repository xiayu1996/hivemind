import { describe, expect, it, vi } from "vitest";
import type {
  AgentRules,
  AgentRulesRepository,
  AgentRulesValidationContext,
  ReplaceAgentRulesInput,
  ReplaceAgentRulesResult,
  VersionedAgentRules,
} from "../config/agent-rules.js";
import * as consoleRulesModule from "./agent-rules.js";

const validation: AgentRulesValidationContext = {
  agentTypes: [
    { agentType: "SHAPE", purpose: "shape", tier: "brain", requiredCapabilities: { thinking: true } },
    { agentType: "CODE", purpose: "code", tier: "standard", requiredCapabilities: {} },
  ],
  configuredProviders: {
    deepseek: {
      catalogue: [{ provider: "deepseek", id: "deepseek-code", thinking: true }],
      assignedModels: { brain: "deepseek-code", standard: "deepseek-code" },
    },
    "openai-codex": {
      catalogue: [
        { provider: "openai-codex", id: "gpt-code" },
        { provider: "openai-codex", id: "gpt-brain", thinking: true },
      ],
      assignedModels: { brain: "gpt-brain", standard: "gpt-code" },
    },
  },
};

const oldRules: VersionedAgentRules = {
  revision: 4,
  rules: {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-brain",
    providerStates: { "openai-codex": "enabled", deepseek: "disabled" },
    failoverOrder: ["openai-codex", "deepseek"],
  },
};

function presenter() {
  expect(typeof consoleRulesModule.presentAgentRules).toBe("function");
  return consoleRulesModule.presentAgentRules;
}

function serviceFactory() {
  expect(typeof consoleRulesModule.createConsoleAgentRulesService).toBe("function");
  return consoleRulesModule.createConsoleAgentRulesService;
}

function repositoryReturning(
  result: ReplaceAgentRulesResult,
): AgentRulesRepository & { replace: ReturnType<typeof vi.fn<(input: ReplaceAgentRulesInput) => Promise<ReplaceAgentRulesResult>>> } {
  let current = oldRules;
  return {
    read: vi.fn(async () => current),
    replace: vi.fn(async (_input: ReplaceAgentRulesInput) => {
      if (result.saved) current = result.current;
      return result;
    }),
  };
}

describe("Agent rules console aggregate", () => {
  it("@scenario S-AGENTRULES-01-view presents the current defaults, every state, and each provider once in failover order", () => {
    const view = presenter()(oldRules.revision, oldRules.rules, validation);

    expect(view).toEqual({
      revision: 4,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-brain",
      providers: [
        {
          name: "openai-codex",
          state: "enabled",
          stateLabel: "Enabled",
          modelChoices: ["gpt-code", "gpt-brain"],
        },
        {
          name: "deepseek",
          state: "disabled",
          stateLabel: "Disabled",
          modelChoices: ["deepseek-code"],
        },
      ],
      failoverOrder: ["openai-codex", "deepseek"],
    });
    expect(view.providers.map((provider) => provider.name)).toEqual(["openai-codex", "deepseek"]);
  });

  it("@scenario S-AGENTRULES-01-view limits choices to each provider catalogue and exposes neither credentials nor health", () => {
    const view = presenter()(oldRules.revision, oldRules.rules, validation);
    const openai = view.providers.find((provider) => provider.name === "openai-codex");
    const deepseek = view.providers.find((provider) => provider.name === "deepseek");

    expect(openai?.modelChoices).toEqual(["gpt-code", "gpt-brain"]);
    expect(openai?.modelChoices).not.toContain("deepseek-code");
    expect(deepseek?.modelChoices).toEqual(["deepseek-code"]);
    for (const provider of view.providers) {
      expect(provider).not.toHaveProperty("credentials");
      expect(provider).not.toHaveProperty("health");
    }
  });

  it("@scenario S-AGENTRULES-01-save sends one complete replacement and returns Rules saved with the committed revision", async () => {
    const savedRules: AgentRules = {
      defaultProvider: "deepseek",
      defaultModel: "deepseek-code",
      providerStates: { "openai-codex": "disabled", deepseek: "enabled" },
      failoverOrder: ["deepseek", "openai-codex"],
    };
    const repository = repositoryReturning({ saved: true, current: { revision: 5, rules: savedRules } });
    const service = serviceFactory()(repository, { validationContext: async () => validation });

    const response = await service.save({ revision: 4, ...savedRules, updatedBy: "maintainer" });

    expect(repository.replace).toHaveBeenCalledTimes(1);
    expect(repository.replace).toHaveBeenCalledWith({
      proposal: savedRules,
      expectedRevision: 4,
      updatedBy: "maintainer",
      validation,
    });
    expect(response).toMatchObject({
      status: "saved",
      message: "Rules saved",
      rules: {
        revision: 5,
        defaultProvider: "deepseek",
        defaultModel: "deepseek-code",
        providers: [
          { name: "deepseek", state: "enabled", stateLabel: "Enabled" },
          { name: "openai-codex", state: "disabled", stateLabel: "Disabled" },
        ],
        failoverOrder: ["deepseek", "openai-codex"],
      },
    });
    await expect(service.view()).resolves.toMatchObject({
      revision: 5,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-code",
      failoverOrder: ["deepseek", "openai-codex"],
    });
  });

  it("@scenario S-AGENTRULES-01-save keeps the old complete view when the aggregate replacement is rejected", async () => {
    const rejection = {
      kind: "unavailable_agent_types" as const,
      affectedAgentTypes: ["SHAPE", "VERIFY"] as const,
      message: "Cannot save rules. No available provider for: SHAPE, VERIFY." as const,
    };
    const repository = repositoryReturning({ saved: false, reason: "validation", current: oldRules, rejection });
    const service = serviceFactory()(repository, { validationContext: async () => validation });

    const response = await service.save({
      revision: 4,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-code",
      providerStates: { "openai-codex": "disabled", deepseek: "disabled" },
      failoverOrder: ["deepseek", "openai-codex"],
      updatedBy: "maintainer",
    });

    expect(response).toMatchObject({
      status: "rejected",
      message: "Cannot save rules. No available provider for: SHAPE, VERIFY.",
      rules: {
        revision: 4,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-brain",
        providers: [
          { name: "openai-codex", state: "enabled", stateLabel: "Enabled" },
          { name: "deepseek", state: "disabled", stateLabel: "Disabled" },
        ],
        failoverOrder: ["openai-codex", "deepseek"],
      },
    });
  });

  it("@scenario S-AGENTRULES-01-invaliddefault returns the invalid field and previously effective rule as one rejection", async () => {
    const rejection = {
      kind: "invalid_default" as const,
      field: "defaultModel" as const,
      message: "Default model is not in the selected provider catalogue.",
    };
    const repository = repositoryReturning({ saved: false, reason: "validation", current: oldRules, rejection });
    const service = serviceFactory()(repository, { validationContext: async () => validation });

    const response = await service.save({
      revision: 4,
      defaultProvider: "openai-codex",
      defaultModel: "missing-model",
      providerStates: oldRules.rules.providerStates,
      failoverOrder: oldRules.rules.failoverOrder,
      updatedBy: "maintainer",
    });

    expect(response).toMatchObject({
      status: "rejected",
      rejection: { kind: "invalid_default", field: "defaultModel" },
      rules: { revision: 4, defaultProvider: "openai-codex", defaultModel: "gpt-brain" },
    });
  });
});
