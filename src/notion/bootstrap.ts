import type { Client, CreateDatabaseParameters, UpdateDataSourceParameters } from "@notionhq/client";
import schema from "./notion-schema.json" with { type: "json" };

type BootstrapClient = Pick<Client, "databases" | "dataSources">;
type InitialDataSource = NonNullable<CreateDatabaseParameters["initial_data_source"]>;
type Properties = NonNullable<InitialDataSource["properties"]>;
type UpdateProperties = NonNullable<UpdateDataSourceParameters["properties"]>;

export interface NotionBootstrapResult {
  epicsDatabaseId: string;
  epicsDataSourceId: string;
  storiesDatabaseId: string;
  storiesDataSourceId: string;
}

function title(content: string) {
  return [{ type: "text" as const, text: { content } }];
}

function selectOptions(names: readonly string[]) {
  return names.map((name) => ({ name }));
}

function epicProperties(): Properties {
  const names = schema.propertyNames;
  return {
    [names.title]: { title: {} },
    [names.epicStatus]: { select: { options: selectOptions(schema.options.epicStatus) } },
    [names.targetDate]: { date: {} },
    [names.creator]: { created_by: {} },
  };
}

function storyProperties(epicsDataSourceId: string): Properties {
  const names = schema.propertyNames;
  return {
    [names.title]: { title: {} },
    [names.epic]: {
      relation: {
        data_source_id: epicsDataSourceId,
        dual_property: { synced_property_name: names.storyRelation },
      },
    },
    [names.aiStatus]: { select: { options: selectOptions(schema.options.aiStatus) } },
    [names.phase]: { select: { options: selectOptions(schema.options.phase) } },
    [names.priority]: { select: { options: selectOptions(schema.options.priority) } },
    [names.repository]: { select: { options: [] } },
    [names.capabilities]: { multi_select: { options: selectOptions(schema.options.capabilities) } },
    [names.targetBranch]: { rich_text: {} },
    [names.mergeRequest]: { url: {} },
    [names.cost]: { number: { format: "dollar" } },
    [names.tokens]: { number: { format: "number" } },
    [names.rounds]: { number: { format: "number" } },
    [names.creator]: { created_by: {} },
    [names.taskId]: { rich_text: {} },
    [names.syncFingerprint]: { rich_text: {} },
    [names.completionValue]: {
      formula: { expression: `if(prop("${names.aiStatus}") == "${schema.options.aiStatus[5]}", 1, 0)` },
    },
  };
}

function epicRollups(): UpdateProperties {
  const names = schema.propertyNames;
  return {
    [names.storyCount]: {
      rollup: {
        relation_property_name: names.storyRelation,
        rollup_property_name: names.title,
        function: "count",
      },
    },
    [names.completedCount]: {
      rollup: {
        relation_property_name: names.storyRelation,
        rollup_property_name: names.completionValue,
        function: "sum",
      },
    },
    [names.costRollup]: {
      rollup: {
        relation_property_name: names.storyRelation,
        rollup_property_name: names.cost,
        function: "sum",
      },
    },
  };
}

async function dataSourceId(
  client: BootstrapClient,
  databaseId: string,
  response: Awaited<ReturnType<BootstrapClient["databases"]["create"]>>,
): Promise<string> {
  const complete = "data_sources" in response ? response : await client.databases.retrieve({ database_id: databaseId });
  if (!("data_sources" in complete) || complete.data_sources.length !== 1) {
    throw new Error(`database ${databaseId} did not expose exactly one initial data source`);
  }
  return complete.data_sources[0]!.id;
}

/** Creates the two code-managed databases; board view setup remains manual. */
export async function bootstrapNotion(
  client: BootstrapClient,
  parentPageId: string,
): Promise<NotionBootstrapResult> {
  const epics = await client.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: title(schema.databaseTitles.epics),
    initial_data_source: { properties: epicProperties() },
  });
  const epicsDataSourceId = await dataSourceId(client, epics.id, epics);

  const stories = await client.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: title(schema.databaseTitles.stories),
    initial_data_source: { properties: storyProperties(epicsDataSourceId) },
  });
  const storiesDataSourceId = await dataSourceId(client, stories.id, stories);

  await client.dataSources.update({
    data_source_id: epicsDataSourceId,
    properties: epicRollups(),
  });

  return {
    epicsDatabaseId: epics.id,
    epicsDataSourceId,
    storiesDatabaseId: stories.id,
    storiesDataSourceId,
  };
}
