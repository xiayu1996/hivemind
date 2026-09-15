import { describe, expect, it } from "vitest";
import type { AgentPhase } from "../pipeline/phase.js";
import type {
  AgentRules,
  AgentRulesValidationContext,
  AgentRulesValidation,
  UnavailableAgentTypesMessage,
} from "./agent-rules.js";
import * as agentRulesModule from "./agent-rules.js";

const currentRules: AgentRules = {
  defaultProvider: "alpha",
  defaultModel: "alpha-code",
  providerStates: { alpha: "enabled", beta: "enabled" },
  failoverOrder: ["alpha", "beta"],
};

const validationContext: AgentRulesValidationContext = {
  agentTypes: [
    { agentType: "VERIFY", purpose: "verify", tier: "standard", requiredCapabilities: { images: true } },
    { agentType: "SHAPE", purpose: "shape", tier: "brain", requiredCapabilities: { thinking: true } },
    { agentType: "CODE", purpose: "code", tier: "standard", requiredCapabilities: {} },
    { agentType: "VERIFY", purpose: "verify", tier: "standard", requiredCapabilities: { images: true } },
  ],
  configuredProviders: {
    alpha: {
      catalogue: [{ provider: "alpha", id: "alpha-code" }],
      assignedModels: { standard: "alpha-code" },
    },
    beta: {
      catalogue: [
        { provider: "beta", id: "beta-brain", thinking: true },
        { provider: "beta", id: "beta-screen", images: true },
      ],
      assignedModels: { brain: "beta-brain", standard: "beta-screen" },
    },
  },
};

function validate(proposal: AgentRules, context = validationContext): AgentRulesValidation {
  expect(typeof agentRulesModule.validateAgentRules).toBe("function");
  return agentRulesModule.validateAgentRules(proposal, context);
}

function format(agentTypes: readonly AgentPhase[]): UnavailableAgentTypesMessage {
  expect(typeof agentRulesModule.formatUnavailableAgentTypes).toBe("function");
  return agentRulesModule.formatUnavailableAgentTypes(agentTypes);
}

describe("global Agent rule validation", () => {
  it("@scenario S-AGENTRULES-01-coverage rejects all and only Agent types that lose their last compatible provider", () => {
    const proposal: AgentRules = {
      ...currentRules,
      providerStates: { alpha: "enabled", beta: "disabled" },
    };

    expect(validate(proposal)).toEqual({
      accepted: false,
      rejection: {
        kind: "unavailable_agent_types",
        affectedAgentTypes: ["SHAPE", "VERIFY"],
        message: "Cannot save rules. No available provider for: SHAPE, VERIFY.",
      },
    });
  });

  it("@scenario S-AGENTRULES-01-coverage sorts and deduplicates affected names without adding unaffected CODE", () => {
    const message = format(["VERIFY", "SHAPE", "VERIFY", "SHAPE"]);

    expect(message).toBe("Cannot save rules. No available provider for: SHAPE, VERIFY.");
    expect(message.match(/SHAPE/g)).toHaveLength(1);
    expect(message.match(/VERIFY/g)).toHaveLength(1);
    expect(message).not.toContain("CODE");
  });

  it("@scenario S-AGENTRULES-01-invaliddefault identifies a disabled default provider and does not mutate the effective rule", () => {
    const before = structuredClone(currentRules);
    const proposal: AgentRules = {
      ...currentRules,
      defaultProvider: "beta",
      defaultModel: "beta-screen",
      providerStates: { alpha: "enabled", beta: "disabled" },
    };

    expect(validate(proposal)).toMatchObject({
      accepted: false,
      rejection: { kind: "invalid_default", field: "defaultProvider" },
    });
    expect(currentRules).toEqual(before);
  });

  it("@scenario S-AGENTRULES-01-invaliddefault identifies a model absent from the selected provider catalogue", () => {
    const proposal: AgentRules = { ...currentRules, defaultModel: "alpha-missing" };

    expect(validate(proposal)).toMatchObject({
      accepted: false,
      rejection: { kind: "invalid_default", field: "defaultModel" },
    });
    expect(currentRules.defaultModel).toBe("alpha-code");
  });

  it("@scenario S-AGENTRULES-01-save accepts a complete rule while retaining a disabled provider in its ordered position", () => {
    const proposal: AgentRules = {
      defaultProvider: "alpha",
      defaultModel: "alpha-screen",
      providerStates: { alpha: "enabled", beta: "disabled" },
      failoverOrder: ["beta", "alpha"],
    };
    const context: AgentRulesValidationContext = {
      agentTypes: validationContext.agentTypes,
      configuredProviders: {
        alpha: {
          catalogue: [
            { provider: "alpha", id: "alpha-screen", images: true },
            { provider: "alpha", id: "alpha-brain", thinking: true },
          ],
          assignedModels: { brain: "alpha-brain", standard: "alpha-screen" },
        },
        beta: validationContext.configuredProviders.beta!,
      },
    };

    expect(validate(proposal, context)).toEqual({ accepted: true, rules: proposal });
    expect(proposal.failoverOrder).toEqual(["beta", "alpha"]);
  });

  it("@scenario S-AGENTRULES-01-save rejects a boundary proposal that omits a configured provider from the order", () => {
    const proposal: AgentRules = { ...currentRules, failoverOrder: ["alpha"] };

    expect(validate(proposal)).toMatchObject({
      accepted: false,
      rejection: { kind: "invalid_provider_set", field: "failoverOrder" },
    });
  });
});
