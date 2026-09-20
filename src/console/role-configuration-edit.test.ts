import { describe, expect, it, vi } from "vitest";
import * as roleConfigurationModule from "./role-configuration.js";
import {
  renderRoleConfigurationPage,
  type RoleConfigurationChoiceReadPort,
  type RoleConfigurationDraft,
  type RoleConfigurationSavePreparation,
  type RoleConfigurationVersion,
  type RoleConfigurationViewState,
  type RoleConfigurationWritePort,
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

const current: RoleConfigurationVersion = {
  roleId: "prototype",
  version: 12,
  savedAt: "2026-06-19T01:40:00.000Z",
  prompt: "先确认业务场景，再逐页绘制。",
  provider: { id: "anthropic", label: "Anthropic" },
  model: { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
};
const previous: RoleConfigurationVersion = {
  roleId: "prototype",
  version: 11,
  savedAt: "2026-06-18T01:20:00.000Z",
  prompt: "先梳理页面，再逐页绘制。",
  provider: { id: "openai", label: "OpenAI" },
  model: { id: "gpt-5-codex", label: "GPT-5 Codex" },
};
const draft: RoleConfigurationDraft = {
  roleId: "prototype",
  roleLabel: "原型设计",
  baseVersion: 12,
  prompt: "先确认业务场景，并标明关键状态。",
  provider: { id: "openai", label: "OpenAI" },
  model: { id: "gpt-5.2", label: "GPT-5.2" },
  futureAgentsOnlyConfirmed: true,
};

function savePreparer(): (
  draft: RoleConfigurationDraft,
  current: RoleConfigurationVersion,
) => RoleConfigurationSavePreparation {
  const candidate = (roleConfigurationModule as unknown as {
    prepareRoleConfigurationSave?: (
      draft: RoleConfigurationDraft,
      current: RoleConfigurationVersion,
    ) => RoleConfigurationSavePreparation;
  }).prepareRoleConfigurationSave;
  expect(candidate, "prepareRoleConfigurationSave must exist at runtime").toBeTypeOf("function");
  return candidate!;
}

function renderEditingState(state: Record<string, unknown>): string {
  return renderRoleConfigurationPage(state as unknown as RoleConfigurationViewState);
}

function writer(overrides: Partial<RoleConfigurationWritePort> = {}): RoleConfigurationWritePort {
  return {
    saveNewVersion: async (command) => ({
      status: "saved",
      previousVersion: 12,
      current: {
        roleId: command.roleId,
        version: 13,
        savedAt: "2026-06-20T00:00:00.000Z",
        savedBy: command.requestedBy,
        content: command.content,
      },
    }),
    restorePrevious: async (command) => ({
      status: "saved",
      previousVersion: 12,
      current: {
        roleId: command.roleId,
        version: 13,
        savedAt: "2026-06-20T00:00:00.000Z",
        savedBy: command.requestedBy,
        content: {
          prompt: previous.prompt,
          providerId: previous.provider.id,
          modelId: previous.model.id,
        },
      },
    }),
    ...overrides,
  };
}

describe("preparing a role configuration save", () => {
  it("@scenario S-R237511RC-02-confirm prepares the selected role, all three changes, and the future-agent scope without writing", () => {
    const prepare = savePreparer();

    const result = prepare(draft, current);

    expect(result).toEqual({ status: "confirmation-required", draft, current });
    expect(current.version).toBe(12);
  });

  it("@scenario S-R237511RC-02-confirm renders a modal with both final actions and does not claim v13 exists", () => {
    const html = renderEditingState({
      status: "save-confirmation",
      roles: [{ id: "prototype", label: "原型设计" }],
      selectedRoleId: "prototype",
      current,
      previous,
      draft,
    });

    expect(html).toContain('role="dialog"');
    expect(html).toContain("保存原型设计角色的新配置？");
    expect(html).toContain(draft.prompt);
    expect(html).toContain("OpenAI");
    expect(html).toContain("GPT-5.2");
    expect(html).toContain("只用于之后新开始的原型设计智能体，已开始工作的智能体不变。");
    expect(html).toContain("保存为新版本");
    expect(html).toContain("取消");
    expect(html).toContain("当前版 v12");
    expect(html).not.toContain("已保存为 v13");
  });
});

describe("requiring explicit effect-scope confirmation", () => {
  it("@scenario S-R237511RC-02-scope returns the complete draft instead of opening save confirmation", () => {
    const prepare = savePreparer();
    const unconfirmed = { ...draft, futureAgentsOnlyConfirmed: false };

    const result = prepare(unconfirmed, current);

    expect(result).toEqual({ status: "scope-required", draft: unconfirmed });
    expect(result.draft).toMatchObject({
      prompt: draft.prompt,
      provider: draft.provider,
      model: draft.model,
      baseVersion: 12,
    });
  });

  it("@scenario S-R237511RC-02-scope keeps all fields visible and shows no dialog or new version", () => {
    const html = renderEditingState({
      status: "scope-required",
      roles: [{ id: "prototype", label: "原型设计" }],
      selectedRoleId: "prototype",
      current,
      previous,
      draft: { ...draft, futureAgentsOnlyConfirmed: false },
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("保存前请确认生效范围，避免误以为正在工作的智能体会切换配置。");
    expect(html).toContain(draft.prompt);
    expect(html).toContain('value="openai"');
    expect(html).toContain('value="gpt-5.2"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("已保存为 v13");
    expect(html).toContain("当前版 v12");
  });
});

describe("confirmed role configuration write routes", () => {
  it("@scenario S-R237511RC-02-save lists only the provider and model choices available to the selected role", async () => {
    const readChoices = vi.fn<RoleConfigurationChoiceReadPort["readChoices"]>(async () => ({
      status: "ready",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          models: [
            { id: "gpt-5.2", label: "GPT-5.2" },
            { id: "gpt-5-codex", label: "GPT-5 Codex" },
          ],
        },
      ],
    }));
    const app = await createConsoleServer(data, {
      serveUi: false,
      roleConfigurationChoiceReader: { readChoices },
    });

    const response = await app.inject({ method: "GET", url: "/api/roles/prototype/choices" });

    expect(response.statusCode).toBe(200);
    expect(readChoices).toHaveBeenCalledOnce();
    expect(readChoices).toHaveBeenCalledWith("prototype");
    expect(response.json()).toEqual({
      status: "ready",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          models: [
            { id: "gpt-5.2", label: "GPT-5.2" },
            { id: "gpt-5-codex", label: "GPT-5 Codex" },
          ],
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toContain("claude-sonnet-4");
    await app.close();
  });

  it("@scenario S-R237511RC-02-save does not invent choices when the selected role's choice source is unavailable", async () => {
    const readChoices = vi.fn<RoleConfigurationChoiceReadPort["readChoices"]>(async () => ({
      status: "unavailable",
      retryable: true,
      detail: "catalog unavailable",
    }));
    const app = await createConsoleServer(data, {
      serveUi: false,
      roleConfigurationChoiceReader: { readChoices },
    });

    const response = await app.inject({ method: "GET", url: "/api/roles/prototype/choices" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable", retryable: true, detail: "catalog unavailable" });
    expect(JSON.stringify(response.json())).not.toContain('"providers"');
    await app.close();
  });

  it("@scenario S-R237511RC-02-save submits exactly the confirmed three fields and reports v13", async () => {
    const saveNewVersion = vi.fn<RoleConfigurationWritePort["saveNewVersion"]>(writer().saveNewVersion);
    const app = await createConsoleServer(data, { serveUi: false, roleConfigurationWriter: writer({ saveNewVersion }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles/prototype/versions",
      payload: {
        expectedCurrentVersion: 12,
        effectScope: "future-agent-starts",
        prompt: draft.prompt,
        providerId: draft.provider.id,
        modelId: draft.model.id,
        requestedBy: "owner",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(saveNewVersion).toHaveBeenCalledTimes(1);
    expect(saveNewVersion).toHaveBeenCalledWith({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      effectScope: "future-agent-starts",
      content: { prompt: draft.prompt, providerId: "openai", modelId: "gpt-5.2" },
      requestedBy: "owner",
    });
    expect(response.json()).toMatchObject({
      status: "saved",
      message: "已保存为 v13。新配置只用于之后新开始的原型设计智能体。",
      current: { version: 13 },
      previousVersion: 12,
    });
    await app.close();
  });

  it("@scenario S-R237511RC-02-save rejects a write without the literal future-agent scope", async () => {
    const saveNewVersion = vi.fn<RoleConfigurationWritePort["saveNewVersion"]>();
    const app = await createConsoleServer(data, { serveUi: false, roleConfigurationWriter: writer({ saveNewVersion }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles/prototype/versions",
      payload: {
        expectedCurrentVersion: 12,
        effectScope: "current-and-future",
        prompt: draft.prompt,
        providerId: draft.provider.id,
        modelId: draft.model.id,
        requestedBy: "owner",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(saveNewVersion).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({ status: "scope-required", draft: expect.objectContaining({ prompt: draft.prompt }) });
    await app.close();
  });

  it("@scenario S-R237511RC-02-conflict returns v13 and the complete stale draft without presenting v14 as saved", async () => {
    const saveNewVersion = vi.fn<RoleConfigurationWritePort["saveNewVersion"]>(async () => ({
      status: "conflict",
      current: {
        roleId: "prototype",
        version: 13,
        savedAt: "2026-06-20T00:00:00.000Z",
        savedBy: "first-window",
        content: { prompt: "第一个窗口的修改。", providerId: "openai", modelId: "gpt-5.2" },
      },
    }));
    const app = await createConsoleServer(data, { serveUi: false, roleConfigurationWriter: writer({ saveNewVersion }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles/prototype/versions",
      payload: {
        expectedCurrentVersion: 12,
        effectScope: "future-agent-starts",
        prompt: draft.prompt,
        providerId: draft.provider.id,
        modelId: draft.model.id,
        requestedBy: "second-window",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      status: "conflict",
      message: "当前版已更新为 v13。你的修改尚未保存，请检查后再保存。",
      draft: {
        prompt: draft.prompt,
        providerId: draft.provider.id,
        modelId: draft.model.id,
        expectedCurrentVersion: 12,
      },
      current: { version: 13 },
    });
    expect(JSON.stringify(response.json())).not.toContain("已保存为 v14");
    await app.close();
  });

  it("@scenario S-R237511RC-02-conflict does not turn an unavailable write into a successful version", async () => {
    const saveNewVersion = vi.fn<RoleConfigurationWritePort["saveNewVersion"]>(async () => ({
      status: "unavailable",
      retryable: true,
      detail: "central store unavailable",
    }));
    const app = await createConsoleServer(data, { serveUi: false, roleConfigurationWriter: writer({ saveNewVersion }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles/prototype/versions",
      payload: {
        expectedCurrentVersion: 12,
        effectScope: "future-agent-starts",
        prompt: draft.prompt,
        providerId: draft.provider.id,
        modelId: draft.model.id,
        requestedBy: "owner",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "unavailable", retryable: true });
    expect(JSON.stringify(response.json())).not.toContain("已保存为 v13");
    await app.close();
  });
});

describe("restoring the adjacent role configuration", () => {
  it("@scenario S-R237511RC-02-restore sends only the adjacent source version and reports the copied v13", async () => {
    const restorePrevious = vi.fn<RoleConfigurationWritePort["restorePrevious"]>(writer().restorePrevious);
    const app = await createConsoleServer(data, { serveUi: false, roleConfigurationWriter: writer({ restorePrevious }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles/prototype/restore",
      payload: {
        expectedCurrentVersion: 12,
        sourceVersion: 11,
        effectScope: "future-agent-starts",
        requestedBy: "owner",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(restorePrevious).toHaveBeenCalledWith({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      sourceVersion: 11,
      effectScope: "future-agent-starts",
      requestedBy: "owner",
    });
    expect(response.json()).toMatchObject({
      status: "saved",
      message: "已恢复为 v13。内容来自 v11，只用于之后新开始的原型设计智能体。",
      current: {
        version: 13,
        content: { prompt: previous.prompt, providerId: "openai", modelId: "gpt-5-codex" },
      },
      previousVersion: 12,
    });
    await app.close();
  });

  it("@scenario S-R237511RC-02-restore renders the copy-and-scope warning before confirmation and leaves v12 current", () => {
    const html = renderEditingState({
      status: "restore-confirmation",
      roles: [{ id: "prototype", label: "原型设计" }],
      selectedRoleId: "prototype",
      current,
      previous,
    });

    expect(html).toContain('role="dialog"');
    expect(html).toContain("恢复原型设计角色的上一版？");
    expect(html).toContain("将复制 v11 的完整配置并生成新版本");
    expect(html).toContain("只影响之后新开始的原型设计智能体");
    expect(html).toContain("恢复上一版");
    expect(html).toContain("取消");
    expect(html).toContain("当前版 v12");
    expect(html).not.toContain("v11 已重新成为当前版");
  });
});
