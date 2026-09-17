import { describe, expect, it } from "vitest";
import type { Client } from "@notionhq/client";
import schema from "./notion-schema.json" with { type: "json" };
import {
  bootstrapNotion,
  bootstrapRequirements,
  seedRepositoryOptions,
  upgradeEpicBoard,
  upgradeRequirementBoard,
  upgradeStoryBoard,
} from "./bootstrap.js";

describe("bootstrapNotion", () => {
  it("creates Epics before the databases that relate to it, then adds rollups", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const names = ["epics", "stories", "requirements"];
    const client = {
      databases: {
        create: async (args: Record<string, unknown>) => {
          creates.push(args);
          const name = names[creates.length - 1];
          return { object: "database", id: `${name}-db`, data_sources: [{ id: `${name}-ds`, name }] };
        },
        retrieve: async () => { throw new Error("full create response should avoid retrieve"); },
      },
      dataSources: {
        update: async (args: Record<string, unknown>) => { updates.push(args); return { id: "epics-ds" }; },
      },
    } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;

    const result = await bootstrapNotion(client, "hub-page");
    expect(result).toEqual({
      epicsDatabaseId: "epics-db",
      epicsDataSourceId: "epics-ds",
      storiesDatabaseId: "stories-db",
      storiesDataSourceId: "stories-ds",
      requirementsDatabaseId: "requirements-db",
      requirementsDataSourceId: "requirements-ds",
    });
    expect(creates).toHaveLength(3);
    const stories = creates[1] as { initial_data_source: { properties: Record<string, unknown> } };
    expect(stories.initial_data_source.properties[schema.propertyNames.epic]).toMatchObject({
      relation: { data_source_id: "epics-ds" },
    });
    expect(updates).toHaveLength(1);
    expect((updates[0]!.properties as Record<string, unknown>)[schema.propertyNames.storyCount]).toBeDefined();
  });

  it("adds Requirements to a board that already runs Epics and Stories", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const client = {
      databases: {
        create: async (args: Record<string, unknown>) => {
          creates.push(args);
          return { object: "database", id: "requirements-db", data_sources: [{ id: "requirements-ds", name: "r" }] };
        },
        retrieve: async () => { throw new Error("unexpected"); },
      },
      dataSources: { update: async () => { throw new Error("adding Requirements must not touch other schemas"); } },
    } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;

    await expect(bootstrapRequirements(client, "hub-page", "existing-epics-ds")).resolves.toEqual({
      requirementsDatabaseId: "requirements-db",
      requirementsDataSourceId: "requirements-ds",
    });
    const properties = (creates[0]!.initial_data_source as { properties: Record<string, any> }).properties;
    expect(properties[schema.propertyNames.epicRelation]).toMatchObject({
      relation: {
        data_source_id: "existing-epics-ds",
        dual_property: { synced_property_name: schema.propertyNames.requirementRelation },
      },
    });
    const statusOptions = properties[schema.propertyNames.requirementStatus].select.options
      .map((option: any) => option.name);
    expect(statusOptions).toEqual(schema.options.requirementStatus);
    // The Epic total is a rollup, and Notion cannot roll up a rollup.
    expect(properties[schema.propertyNames.cost]).toMatchObject({ number: { format: "dollar" } });
  });

  it("declares the seven board columns and every required Story property", async () => {
    const created: Array<Record<string, unknown>> = [];
    const client = {
      databases: {
        create: async (args: Record<string, unknown>) => {
          created.push(args);
          return {
            object: "database",
            id: `db-${created.length}`,
            data_sources: [{ id: `ds-${created.length}`, name: "x" }],
          };
        },
        retrieve: async () => { throw new Error("unexpected"); },
      },
      dataSources: { update: async () => ({ id: "ds-1" }) },
    } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;
    await bootstrapNotion(client, "hub-page");

    const properties = (created[1]!.initial_data_source as { properties: Record<string, any> }).properties;
    const statusOptions = properties[schema.propertyNames.aiStatus].select.options.map((option: any) => option.name);
    expect(statusOptions).toEqual(schema.options.aiStatus);
    for (const key of [
      "title", "epic", "aiStatus", "phase", "priority", "repository", "capabilities",
      "targetBranch", "mergeRequest", "cost", "tokens", "rounds", "creator", "taskId",
    ] as const) {
      expect(properties[schema.propertyNames[key]], key).toBeDefined();
    }
  });

  it("upgrades a live Epics board without recolouring the options it already has", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const client = {
      databases: { create: async () => { throw new Error("nothing is created on upgrade"); }, retrieve: async () => { throw new Error("unexpected"); } },
      dataSources: {
        retrieve: async () => ({
          properties: {
            [schema.propertyNames.epicStatus]: { select: { options: schema.options.epicStatus.slice(0, 4).map((name) => ({ name, color: "gray" })) } },
          },
        }),
        update: async (input: Record<string, unknown>) => { updates.push(input); return { id: "ds-1" }; },
      },
    } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;

    await upgradeEpicBoard(client, "epics-ds");

    const properties = updates[0]!.properties as Record<string, any>;
    const options = properties[schema.propertyNames.epicStatus].select.options as Array<{ name: string; color?: string }>;
    expect(options.map((option) => option.name)).toEqual(schema.options.epicStatus);
    expect(options.slice(0, 4).every((option) => option.color === undefined)).toBe(true);
    expect(options.slice(4).every((option) => option.color !== undefined)).toBe(true);
    expect(properties[schema.propertyNames.mergeRequest]).toEqual({ url: {} });
    expect(properties[schema.propertyNames.waitingOnHuman].formula.expression).toContain("验收中");
    expect(properties[schema.propertyNames.taskId]).toEqual({ rich_text: {} });
  });

  it("adds the new phase words before moving pages off the old ones, because Notion cannot rename an option", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const moved: Array<{ page: string; to: string }> = [];
    let live = [
      { id: "o-queued", name: "排队中", color: "gray" },
      { id: "o-shape", name: "需求分析", color: "purple" },
      { id: "o-e2e", name: "端到端", color: "orange" },
    ];
    const client = {
      databases: { create: async () => { throw new Error("nothing is created on upgrade"); }, retrieve: async () => { throw new Error("unexpected"); } },
      dataSources: {
        retrieve: async () => ({ properties: { [schema.propertyNames.phase]: { select: { options: live } } } }),
        query: async (input: any) => ({
          results: input.filter.select.equals === "端到端" ? [{ id: "page-1" }] : [],
          has_more: false,
          next_cursor: null,
        }),
        update: async (input: any) => {
          updates.push(input);
          const phase = input.properties[schema.propertyNames.phase];
          if (!phase) return { id: "ds-1" };
          const sent = phase.select.options as Array<{ id?: string; name?: string; color?: string }>;
          live = sent.map((option, index) => {
            const known = live.find((existing) => existing.id === option.id);
            return known ?? { id: `new-${index}`, name: option.name!, color: option.color ?? "default" };
          });
          return { id: "ds-1" };
        },
      },
      pages: {
        update: async (input: any) => {
          moved.push({ page: input.page_id, to: input.properties[schema.propertyNames.phase].select.name });
          return { id: input.page_id };
        },
      },
    } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;

    await upgradeStoryBoard(client, "stories-ds");

    // The word a page moves onto has to be on the board before the page moves,
    // and the word it leaves can only go afterwards.
    const phaseUpdates = updates.filter((update: any) => update.properties[schema.propertyNames.phase]);
    expect(phaseUpdates).toHaveLength(2);
    // The hash column goes with the same upgrade; it was never for a person.
    expect(updates.at(-1)!.properties).toEqual({ [schema.propertyNames.syncFingerprint]: null });
    const added = (phaseUpdates[0]!.properties as any)[schema.propertyNames.phase].select.options
      .map((option: any) => option.name).filter(Boolean);
    expect(added).toContain("验证");
    expect(moved).toEqual([{ page: "page-1", to: "验证" }]);
    expect(live.map((option) => option.name)).toEqual(schema.options.phase);
  });
});

function boardWith(options: Array<{ id: string; name: string }>, updates: Array<Record<string, unknown>>) {
  return {
    databases: { create: async () => { throw new Error("nothing is created"); }, retrieve: async () => { throw new Error("unexpected"); } },
    dataSources: {
      retrieve: async () => ({ properties: { [schema.propertyNames.repository]: { select: { options } } } }),
      update: async (input: Record<string, unknown>) => { updates.push(input); return { id: "ds-1" }; },
    },
  } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;
}

describe("seedRepositoryOptions", () => {
  it("adds a newly registered repository as an option, keeping the ones already there", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const client = boardWith([{ id: "o-1", name: "acme/widget" }], updates);

    await expect(seedRepositoryOptions(client, "requirements-ds", ["acme/widget", "acme/gadget"]))
      .resolves.toEqual(["acme/gadget"]);
    const sent = (updates[0]!.properties as any)[schema.propertyNames.repository].select.options;
    // An option that is dropped blanks the property on every page holding it,
    // so the ones already there travel by id.
    expect(sent).toEqual([{ id: "o-1" }, { name: "acme/gadget" }]);
  });

  it("writes nothing when the board already offers every registered repository", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const client = boardWith([{ id: "o-1", name: "acme/widget" }], updates);

    await expect(seedRepositoryOptions(client, "requirements-ds", ["acme/widget"])).resolves.toEqual([]);
    expect(updates).toEqual([]);
  });

  it("adds the target repository column to a Requirements board that predates it", async () => {
    const updates: Array<Record<string, unknown>> = [];
    let properties: Record<string, unknown> = {};
    const client = {
      databases: { create: async () => { throw new Error("nothing is created"); }, retrieve: async () => { throw new Error("unexpected"); } },
      dataSources: {
        retrieve: async () => ({ properties }),
        update: async (input: any) => {
          updates.push(input);
          properties = { ...properties, ...input.properties };
          return { id: "ds-1" };
        },
      },
    } as unknown as Pick<Client, "databases" | "dataSources" | "pages">;

    await upgradeRequirementBoard(client, "requirements-ds", ["acme/widget"]);

    expect((updates[0]!.properties as any)[schema.propertyNames.repository]).toEqual({ select: { options: [] } });
    expect((updates[1]!.properties as any)[schema.propertyNames.repository].select.options)
      .toEqual([{ name: "acme/widget" }]);
  });
});
