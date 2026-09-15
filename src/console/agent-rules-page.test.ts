import { describe, expect, it, vi } from "vitest";
import type { AgentRulesView, SaveAgentRulesResponse } from "./agent-rules.js";
import type { AgentRulesApi } from "../../console-ui/src/agent-rules.js";
import * as pageModule from "../../console-ui/src/agent-rules.js";

const loadedView: AgentRulesView = {
  revision: 2,
  defaultProvider: "openai-codex",
  defaultModel: "gpt-brain",
  providers: [
    {
      name: "openai-codex",
      state: "enabled",
      stateLabel: "Enabled",
      modelChoices: ["gpt-brain", "gpt-code"],
    },
    {
      name: "deepseek",
      state: "disabled",
      stateLabel: "Disabled",
      modelChoices: ["deepseek-code"],
    },
  ],
  failoverOrder: ["openai-codex", "deepseek"],
};

function controllerFactory() {
  expect(typeof pageModule.createAgentRulesPageController).toBe("function");
  return pageModule.createAgentRulesPageController;
}

function apiReturning(response: SaveAgentRulesResponse): AgentRulesApi & { save: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => loadedView),
    save: vi.fn(async () => response),
  };
}

describe("Agent rules page state", () => {
  it("@scenario S-AGENTRULES-01-view opens with a credential-free draft matching all loaded rule fields", async () => {
    const api = apiReturning({ status: "saved", message: "Rules saved", rules: loadedView });
    const controller = controllerFactory()(api);

    await controller.open();

    expect(controller.state).toMatchObject({
      status: "ready",
      persisted: loadedView,
      draft: {
        revision: 2,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-brain",
        providerStates: { "openai-codex": "enabled", deepseek: "disabled" },
        failoverOrder: ["openai-codex", "deepseek"],
      },
      message: "",
    });
    expect(controller.state.draft).not.toHaveProperty("credentials");
    expect(controller.state.draft).not.toHaveProperty("health");
  });

  it("@scenario S-AGENTRULES-01-save submits all edited fields together and displays the literal success message", async () => {
    const saved: AgentRulesView = {
      revision: 3,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-code",
      providers: [
        { name: "deepseek", state: "enabled", stateLabel: "Enabled", modelChoices: ["deepseek-code"] },
        { name: "openai-codex", state: "disabled", stateLabel: "Disabled", modelChoices: ["gpt-brain", "gpt-code"] },
      ],
      failoverOrder: ["deepseek", "openai-codex"],
    };
    const api = apiReturning({ status: "saved", message: "Rules saved", rules: saved });
    const controller = controllerFactory()(api);
    await controller.open();

    controller.selectDefaultProvider("deepseek");
    controller.selectDefaultModel("deepseek-code");
    controller.setProviderState("openai-codex", "disabled");
    controller.setProviderState("deepseek", "enabled");
    controller.reorderProviders(["deepseek", "openai-codex"]);
    await controller.save("maintainer");

    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith({
      revision: 2,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-code",
      providerStates: { "openai-codex": "disabled", deepseek: "enabled" },
      failoverOrder: ["deepseek", "openai-codex"],
      updatedBy: "maintainer",
    });
    expect(controller.state).toMatchObject({ status: "saved", message: "Rules saved", persisted: saved });
  });

  it("@scenario S-AGENTRULES-01-coverage keeps the complete rejected draft visible and the old rule persisted", async () => {
    const message = "Cannot save rules. No available provider for: SHAPE, VERIFY.";
    const api = apiReturning({
      status: "rejected",
      message,
      rejection: {
        kind: "unavailable_agent_types",
        affectedAgentTypes: ["SHAPE", "VERIFY"],
        message,
      },
      rules: loadedView,
    });
    const controller = controllerFactory()(api);
    await controller.open();
    controller.setProviderState("openai-codex", "disabled");

    await controller.save("maintainer");

    expect(controller.state.status).toBe("rejected");
    expect(controller.state.message).toBe(message);
    expect(controller.state.persisted).toEqual(loadedView);
    expect(controller.state.draft?.providerStates).toEqual({ "openai-codex": "disabled", deepseek: "disabled" });
    expect(controller.state.message).not.toContain("CODE");
  });
});
