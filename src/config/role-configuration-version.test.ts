import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import * as roleVersionModule from "./role-configuration-version.js";
import type {
  AgentRoleConfigurationBindingPort,
  RoleConfigurationMutationPort,
} from "./role-configuration-version.js";

type RoleConfigurationStore = RoleConfigurationMutationPort & AgentRoleConfigurationBindingPort;
type StoreConstructor = new (client: Client, now?: () => number) => RoleConfigurationStore;

let client: Client;

const v11 = {
  prompt: "先梳理页面，再逐页绘制。",
  providerId: "openai",
  modelId: "gpt-5-codex",
};
const v12 = {
  prompt: "先确认业务场景，再逐页绘制。",
  providerId: "anthropic",
  modelId: "claude-sonnet-4",
};
const v13Draft = {
  prompt: "先确认业务场景，并标明关键状态。",
  providerId: "openai",
  modelId: "gpt-5.2",
};
const engineerV4 = {
  prompt: "实现并验证改动。",
  providerId: "openai",
  modelId: "gpt-5-codex",
};

function storeConstructor(): StoreConstructor {
  const candidate = (roleVersionModule as unknown as { LibsqlRoleConfigurationStore?: StoreConstructor })
    .LibsqlRoleConfigurationStore;
  expect(candidate, "LibsqlRoleConfigurationStore must implement the declared central-store ports").toBeTypeOf("function");
  return candidate!;
}

async function seedStore(): Promise<RoleConfigurationStore> {
  const Store = storeConstructor();
  await migrate(client);
  await client.batch([
    {
      sql: `INSERT INTO role_configuration_versions
              (role_id, version, prompt, provider_id, model_id, saved_at, saved_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["prototype", 11, v11.prompt, v11.providerId, v11.modelId, Date.UTC(2026, 5, 18), "owner"],
    },
    {
      sql: `INSERT INTO role_configuration_versions
              (role_id, version, prompt, provider_id, model_id, saved_at, saved_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["prototype", 12, v12.prompt, v12.providerId, v12.modelId, Date.UTC(2026, 5, 19), "owner"],
    },
    {
      sql: `INSERT INTO role_configuration_versions
              (role_id, version, prompt, provider_id, model_id, saved_at, saved_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["engineer", 4, engineerV4.prompt, engineerV4.providerId, engineerV4.modelId, Date.UTC(2026, 5, 17), "owner"],
    },
    {
      sql: "INSERT INTO role_configuration_heads (role_id, current_version) VALUES (?, ?)",
      args: ["prototype", 12],
    },
    {
      sql: "INSERT INTO role_configuration_heads (role_id, current_version) VALUES (?, ?)",
      args: ["engineer", 4],
    },
  ], "write");
  return new Store(client, () => Date.UTC(2026, 5, 20));
}

async function versions(roleId: string): Promise<Array<Record<string, unknown>>> {
  const result = await client.execute({
    sql: `SELECT role_id, version, prompt, provider_id, model_id
            FROM role_configuration_versions
           WHERE role_id = ? ORDER BY version`,
    args: [roleId],
  });
  return result.rows.map((row) => Object.fromEntries(Object.entries(row)));
}

async function currentVersion(roleId: string): Promise<number | null> {
  const result = await client.execute({
    sql: "SELECT current_version FROM role_configuration_heads WHERE role_id = ?",
    args: [roleId],
  });
  return (result.rows[0]?.current_version as number | undefined) ?? null;
}

beforeEach(() => {
  client = createClient({ url: ":memory:" });
});

describe("saving immutable role configuration versions", () => {
  it("@scenario S-R237511RC-02-save appends the complete confirmed configuration and advances only that role", async () => {
    const store = await seedStore();

    const result = await store.saveNewVersion({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      effectScope: "future-agent-starts",
      content: v13Draft,
      requestedBy: "owner",
    });

    expect(result).toMatchObject({
      status: "saved",
      previousVersion: 12,
      current: { roleId: "prototype", version: 13, content: v13Draft },
    });
    expect(await versions("prototype")).toHaveLength(3);
    expect(await currentVersion("prototype")).toBe(13);
    expect(await currentVersion("engineer")).toBe(4);
    expect(await versions("engineer")).toEqual([
      expect.objectContaining({
        role_id: "engineer",
        version: 4,
        prompt: engineerV4.prompt,
        provider_id: engineerV4.providerId,
        model_id: engineerV4.modelId,
      }),
    ]);
  });

  it("@scenario S-R237511RC-02-save does not create a version for an unknown role", async () => {
    const store = await seedStore();

    const result = await store.saveNewVersion({
      roleId: "unknown",
      expectedCurrentVersion: 0,
      effectScope: "future-agent-starts",
      content: v13Draft,
      requestedBy: "owner",
    });

    expect(result).toMatchObject({ status: "rejected", reason: "unknown-role" });
    expect(await versions("unknown")).toEqual([]);
    expect((await versions("prototype")).map((row) => row.version)).toEqual([11, 12]);
  });
});

describe("optimistic role configuration writes", () => {
  it("@scenario S-R237511RC-02-conflict lets one v12 editor create v13 and returns v13 to the stale editor without creating v14", async () => {
    const store = await seedStore();
    const first = await store.saveNewVersion({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      effectScope: "future-agent-starts",
      content: v13Draft,
      requestedBy: "first-window",
    });
    const secondDraft = { prompt: "保留第二个窗口的说明。", providerId: "anthropic", modelId: "claude-opus-4" };

    const second = await store.saveNewVersion({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      effectScope: "future-agent-starts",
      content: secondDraft,
      requestedBy: "second-window",
    });

    expect(first).toMatchObject({ status: "saved", current: { version: 13 } });
    expect(second).toMatchObject({ status: "conflict", current: { version: 13, content: v13Draft } });
    expect((await versions("prototype")).map((row) => row.version)).toEqual([11, 12, 13]);
    expect(await currentVersion("prototype")).toBe(13);
    expect(JSON.stringify(await versions("prototype"))).not.toContain(secondDraft.prompt);
  });

  it("@scenario S-R237511RC-02-conflict concurrent stale submissions have exactly one winner", async () => {
    const store = await seedStore();
    const command = (prompt: string) => store.saveNewVersion({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      effectScope: "future-agent-starts" as const,
      content: { ...v13Draft, prompt },
      requestedBy: prompt,
    });

    const results = await Promise.all([command("窗口甲"), command("窗口乙")]);

    expect(results.filter((result) => result.status === "saved")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    expect((await versions("prototype")).map((row) => row.version)).toEqual([11, 12, 13]);
  });
});

describe("restoring an immutable previous role version", () => {
  it("@scenario S-R237511RC-02-restore copies all three v11 fields into v13, retains history, and leaves a started agent on v12", async () => {
    const store = await seedStore();
    const startedAgent = await store.bindAtAgentStart("prototype-started", "prototype");

    const result = await store.restorePrevious({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      sourceVersion: 11,
      effectScope: "future-agent-starts",
      requestedBy: "owner",
    });

    expect(result).toMatchObject({
      status: "saved",
      previousVersion: 12,
      current: { version: 13, content: v11 },
    });
    const continuedAgent = await store.bindAtAgentStart("prototype-started", "prototype");
    const saved = await versions("prototype");
    expect(saved.map((row) => row.version)).toEqual([11, 12, 13]);
    expect(await currentVersion("prototype")).toBe(13);
    expect(saved[2]).toMatchObject({
      prompt: v11.prompt,
      provider_id: v11.providerId,
      model_id: v11.modelId,
    });
    expect(startedAgent).toMatchObject({ status: "bound", created: true, binding: { roleVersion: 12, content: v12 } });
    expect(continuedAgent).toMatchObject({ status: "bound", created: false, binding: { roleVersion: 12, content: v12 } });
  });

  it("@scenario S-R237511RC-02-restore refuses a source that is not the adjacent previous version", async () => {
    const store = await seedStore();

    const result = await store.restorePrevious({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      sourceVersion: 10,
      effectScope: "future-agent-starts",
      requestedBy: "owner",
    });

    expect(result).toMatchObject({ status: "rejected", reason: "source-is-not-previous" });
    expect((await versions("prototype")).map((row) => row.version)).toEqual([11, 12]);
  });
});

describe("binding role versions when an agent starts", () => {
  it("@scenario S-R237511RC-02-future keeps an existing agent on v12 and binds a later agent to complete v13 content", async () => {
    const store = await seedStore();
    const oldAgent = await store.bindAtAgentStart("prototype-old", "prototype");
    await store.saveNewVersion({
      roleId: "prototype",
      expectedCurrentVersion: 12,
      effectScope: "future-agent-starts",
      content: v13Draft,
      requestedBy: "owner",
    });

    const continuedOldAgent = await store.bindAtAgentStart("prototype-old", "prototype");
    const newAgent = await store.bindAtAgentStart("prototype-new", "prototype");
    const engineer = await store.bindAtAgentStart("engineer-new", "engineer");

    expect(oldAgent).toMatchObject({ status: "bound", created: true, binding: { roleVersion: 12, content: v12 } });
    expect(continuedOldAgent).toMatchObject({ status: "bound", created: false, binding: { roleVersion: 12, content: v12 } });
    expect(newAgent).toMatchObject({ status: "bound", created: true, binding: { roleVersion: 13, content: v13Draft } });
    expect(engineer).toMatchObject({ status: "bound", binding: { roleVersion: 4, content: engineerV4 } });
  });

  it("@scenario S-R237511RC-02-future refuses to reuse one agent id for another role", async () => {
    const store = await seedStore();
    await store.bindAtAgentStart("shared-agent", "prototype");

    const result = await store.bindAtAgentStart("shared-agent", "engineer");

    expect(result).toEqual({ status: "binding-conflict", agentRunId: "shared-agent", boundRoleId: "prototype" });
    const binding = await store.readBinding("shared-agent");
    expect(binding).toMatchObject({ roleId: "prototype", roleVersion: 12, content: v12 });
  });
});
