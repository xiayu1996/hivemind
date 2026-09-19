import { describe, expect, it, vi } from "vitest";
import {
  compareRoleConfigurationVersions,
  formatRoleVersionTime,
  readRoleConfigurationView,
  renderRoleConfigurationPage,
  resolveRoleConfigurationPageRequest,
  type RoleConfigurationReadPort,
  type RoleConfigurationVersion,
  type RoleConfigurationViewState,
  type RoleVersionPair,
} from "./role-configuration.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [], providerSlots: [] }),
};

const roles = [
  { id: "engineer", label: "工程师" },
  { id: "prototype", label: "原型设计" },
];

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
        provider: { current: current.provider, previous: previousVersion.provider, changed: true },
        model: { current: current.model, previous: previousVersion.model, changed: true },
      },
  };
}

function readerWith(pair: RoleVersionPair): RoleConfigurationReadPort {
  return {
    readCatalog: async () => ({ status: "ready", roles }),
    readVersionPair: async (roleId) => ({ status: "ready", pair: { ...pair, roleId } }),
  };
}

async function serverWith(reader: RoleConfigurationReadPort) {
  return createConsoleServer(data, { serveUi: false, roleConfigurationReader: reader });
}

describe("role configuration versions", () => {
  it("@scenario S-R237511RC-01-versions 选中角色后并排展示当前版与紧邻上一版的完整配置", () => {
    const state: RoleConfigurationViewState = {
      status: "ready",
      roles,
      selectedRoleId: "prototype",
      pair: pairWith(previous),
    };

    const html = renderRoleConfigurationPage(state);

    expect(html).toContain("智能体角色配置");
    expect(html).toContain("编辑当前配置");
    expect(html).toContain("上一版配置");
    expect(html).toContain("当前版 v12");
    expect(html).toContain("上一版 v11");
    expect(html).toContain(formatRoleVersionTime(current.savedAt));
    expect(html).toContain(formatRoleVersionTime(previous.savedAt));
    expect(html).toContain("Claude Sonnet 4");
    expect(html).toContain("Anthropic");
    expect(html).toContain("GPT-5 Codex");
    expect(html).toContain("OpenAI");
    expect(html).toContain(current.prompt);
    expect(html).toContain(previous.prompt);
    expect(html).not.toContain("v10");
    expect(html).not.toContain("工程师");
  });

  it("@scenario S-R237511RC-01-versions 读取只返回所选角色的当前版与紧邻上一版", async () => {
    const readCatalog = vi.fn<RoleConfigurationReadPort["readCatalog"]>(async () => ({ status: "ready", roles }));
    const readVersionPair = vi.fn<RoleConfigurationReadPort["readVersionPair"]>(async () => ({
      status: "ready",
      pair: pairWith(previous),
    }));
    const app = await serverWith({ readCatalog, readVersionPair });

    const catalogResponse = await app.inject({ method: "GET", url: "/api/roles" });
    const versionResponse = await app.inject({ method: "GET", url: "/api/roles/prototype/versions" });

    expect(catalogResponse.statusCode).toBe(200);
    expect(versionResponse.statusCode).toBe(200);
    expect(readVersionPair).toHaveBeenCalledWith("prototype");
    expect(versionResponse.json().pair.current.version).toBe(12);
    expect(versionResponse.json().pair.previous.version).toBe(11);
    expect(JSON.stringify(versionResponse.json())).not.toContain('"version":10');
    expect(JSON.stringify(versionResponse.json())).not.toContain('"roleId":"engineer"');
    await app.close();
  });

  it("@scenario S-R237511RC-01-versions 只有一个已保存版本时不虚构上一版", async () => {
    const app = await serverWith({
      readCatalog: async () => ({ status: "ready", roles }),
      readVersionPair: async () => ({ status: "ready", pair: pairWith(null) }),
    });

    const response = await app.inject({ method: "GET", url: "/api/roles/prototype/versions" });

    expect(response.statusCode).toBe(200);
    expect(response.json().pair.previous).toBeNull();
    expect(response.json().pair.difference).toBeNull();
    await app.close();
  });
});
