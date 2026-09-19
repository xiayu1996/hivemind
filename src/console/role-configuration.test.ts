import { describe, expect, it, vi } from "vitest";
import type { ConsoleDataSource } from "./server.js";
import { createConsoleServer } from "./server.js";
import {
  compareRoleConfigurationVersions,
  type RoleConfigurationReadPort,
  type RoleConfigurationVersion,
  type RoleVersionPair,
} from "./role-configuration.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [], providerSlots: [] }),
};

const previous: RoleConfigurationVersion = {
  roleId: "prototype",
  version: 11,
  savedAt: "2026-06-18T01:20:00.000Z",
  prompt: "共同说明。先按页面清单逐页绘制。保留结尾。",
  provider: { id: "openai", label: "OpenAI" },
  model: { id: "gpt-5-codex", label: "GPT-5 Codex" },
};

const current: RoleConfigurationVersion = {
  roleId: "prototype",
  version: 12,
  savedAt: "2026-06-19T01:40:00.000Z",
  prompt: "共同说明。每页优先证明它承接了业务场景。保留结尾。",
  provider: { id: "anthropic", label: "Anthropic" },
  model: { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
};

function pairWith(previousVersion: RoleConfigurationVersion | null): RoleVersionPair {
  return {
    roleId: current.roleId,
    current,
    previous: previousVersion,
    difference: previousVersion === null
      ? null
      : {
        currentPrompt: [
          { kind: "unchanged", text: "共同说明。" },
          { kind: "added", text: "每页优先证明它承接了业务场景。" },
          { kind: "unchanged", text: "保留结尾。" },
        ],
        previousPrompt: [
          { kind: "unchanged", text: "共同说明。" },
          { kind: "removed", text: "先按页面清单逐页绘制。" },
          { kind: "unchanged", text: "保留结尾。" },
        ],
        provider: { current: current.provider, previous: previous.provider, changed: true },
        model: { current: current.model, previous: previous.model, changed: true },
      },
  };
}

describe("role configuration version comparison", () => {
  it("@scenario S-R237511RC-01-diff returns the added, removed, and changed values beside their content", () => {
    expect(compareRoleConfigurationVersions).toBeTypeOf("function");
    const result = compareRoleConfigurationVersions(current, previous);

    expect(result.currentPrompt.map((segment) => segment.text).join("")).toBe(current.prompt);
    expect(result.previousPrompt.map((segment) => segment.text).join("")).toBe(previous.prompt);
    expect(result.currentPrompt.filter((segment) => segment.kind === "added").map((segment) => segment.text).join("")).toBe(
      "每页优先证明它承接了业务场景。",
    );
    expect(result.previousPrompt.filter((segment) => segment.kind === "removed").map((segment) => segment.text).join("")).toBe(
      "先按页面清单逐页绘制。",
    );
    expect(result.provider).toEqual({ current: current.provider, previous: previous.provider, changed: true });
    expect(result.model).toEqual({ current: current.model, previous: previous.model, changed: true });
  });

  it("@scenario S-R237511RC-01-diff does not mark unchanged prompt, provider, or model values as differences", () => {
    const sameContent = { ...current, version: 11, savedAt: previous.savedAt };

    expect(compareRoleConfigurationVersions).toBeTypeOf("function");
    const result = compareRoleConfigurationVersions(current, sameContent);

    expect(result.currentPrompt.map((segment) => segment.text).join("")).toBe(current.prompt);
    expect(result.previousPrompt.map((segment) => segment.text).join("")).toBe(current.prompt);
    expect(result.currentPrompt.some((segment) => segment.kind === "added")).toBe(false);
    expect(result.previousPrompt.some((segment) => segment.kind === "removed")).toBe(false);
    expect(result.provider.changed).toBe(false);
    expect(result.model.changed).toBe(false);
  });
});

describe("role configuration read API", () => {
  it("@scenario S-R237511RC-01-versions returns only the selected role's complete current and adjacent previous versions", async () => {
    const readCatalog = vi.fn<RoleConfigurationReadPort["readCatalog"]>(async () => ({
      status: "ready",
      roles: [
        { id: "engineer", label: "工程师" },
        { id: "prototype", label: "原型设计" },
      ],
    }));
    const readVersionPair = vi.fn<RoleConfigurationReadPort["readVersionPair"]>(async () => ({
      status: "ready",
      pair: pairWith(previous),
    }));
    const app = await createConsoleServer(data, {
      serveUi: false,
      roleConfigurationReader: { readCatalog, readVersionPair },
    });

    const catalogResponse = await app.inject({ method: "GET", url: "/api/roles" });
    const versionResponse = await app.inject({ method: "GET", url: "/api/roles/prototype/versions" });

    expect(catalogResponse.statusCode).toBe(200);
    expect(catalogResponse.json()).toEqual({
      status: "ready",
      roles: [
        { id: "engineer", label: "工程师" },
        { id: "prototype", label: "原型设计" },
      ],
    });
    expect(versionResponse.statusCode).toBe(200);
    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(readVersionPair).toHaveBeenCalledTimes(1);
    expect(readVersionPair).toHaveBeenCalledWith("prototype");
    expect(versionResponse.json()).toEqual({ status: "ready", pair: pairWith(previous) });
    expect(JSON.stringify(versionResponse.json())).not.toContain('"version":10');
    expect(JSON.stringify(versionResponse.json())).not.toContain('"roleId":"engineer"');
    await app.close();
  });

  it("@scenario S-R237511RC-01-versions does not invent a previous version when the selected role has only one saved version", async () => {
    const readVersionPair = vi.fn<RoleConfigurationReadPort["readVersionPair"]>(async () => ({
      status: "ready",
      pair: pairWith(null),
    }));
    const app = await createConsoleServer(data, {
      serveUi: false,
      roleConfigurationReader: {
        readCatalog: async () => ({ status: "ready", roles: [{ id: "prototype", label: "原型设计" }] }),
        readVersionPair,
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/roles/prototype/versions" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", pair: pairWith(null) });
    expect(response.json().pair.previous).toBeNull();
    expect(response.json().pair.difference).toBeNull();
    await app.close();
  });
});
