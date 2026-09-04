import { describe, expect, it } from "vitest";
import type { Client } from "@notionhq/client";
import schema from "./notion-schema.json" with { type: "json" };
import { bootstrapNotion, bootstrapRequirements } from "./bootstrap.js";

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
    } as unknown as Pick<Client, "databases" | "dataSources">;

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
    } as unknown as Pick<Client, "databases" | "dataSources">;

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
    } as unknown as Pick<Client, "databases" | "dataSources">;
    await bootstrapNotion(client, "hub-page");

    const properties = (created[1]!.initial_data_source as { properties: Record<string, any> }).properties;
    const statusOptions = properties[schema.propertyNames.aiStatus].select.options.map((option: any) => option.name);
    expect(statusOptions).toEqual(schema.options.aiStatus);
    for (const key of [
      "title", "epic", "aiStatus", "phase", "priority", "repository", "capabilities",
      "targetBranch", "mergeRequest", "cost", "tokens", "rounds", "creator", "taskId", "syncFingerprint",
    ] as const) {
      expect(properties[schema.propertyNames[key]], key).toBeDefined();
    }
  });
});
