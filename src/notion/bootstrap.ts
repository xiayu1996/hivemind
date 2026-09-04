import type { Client, CreateDatabaseParameters, UpdateDataSourceParameters } from "@notionhq/client";
import schema from "./notion-schema.json" with { type: "json" };

type BootstrapClient = Pick<Client, "databases" | "dataSources">;
type InitialDataSource = NonNullable<CreateDatabaseParameters["initial_data_source"]>;
type Properties = NonNullable<InitialDataSource["properties"]>;
type UpdateProperties = NonNullable<UpdateDataSourceParameters["properties"]>;

export interface NotionBootstrapResult extends RequirementsBootstrapResult {
  epicsDatabaseId: string;
  epicsDataSourceId: string;
  storiesDatabaseId: string;
  storiesDataSourceId: string;
}

export interface RequirementsBootstrapResult {
  requirementsDatabaseId: string;
  requirementsDataSourceId: string;
}

function title(content: string) {
  return [{ type: "text" as const, text: { content } }];
}

type OptionGroup = keyof typeof schema.optionColors;
type SelectOption = NonNullable<Extract<Properties[string], { select: unknown }>["select"]["options"]>[number];

// Colors are only honored at creation time: Notion rejects recoloring an
// existing option through the API, so a live board keeps whatever it has.
function selectOptions(group: OptionGroup): SelectOption[] {
  const colors: Record<string, string | undefined> = schema.optionColors[group];
  return schema.options[group].map((name) => {
    const color = colors[name];
    if (!color) throw new Error(`notion-schema.json has no color for option ${name} in ${group}`);
    return { name, color: color as NonNullable<SelectOption["color"]> };
  });
}

type WaitingGroup = Exclude<keyof typeof schema.waitingLabels, "hoursSuffix">;

/**
 * Builds the human-facing "waiting on you" formula: a label per status that
 * needs a person, followed by the hours since the page last changed.
 */
function waitingFormula(statusProperty: string, group: WaitingGroup): string {
  const hours = `format(dateBetween(now(), prop("${schema.propertyNames.lastEdited}"), "hours"))`;
  const suffix = schema.waitingLabels.hoursSuffix;
  const labels: Record<string, string> = schema.waitingLabels[group];
  return Object.entries(labels).reduceRight(
    (fallback, [status, label]) => `if(prop("${statusProperty}") == "${status}", "${label} " + ${hours} + " ${suffix}", ${fallback})`,
    '""',
  );
}

function epicProperties(): Properties {
  const names = schema.propertyNames;
  return {
    [names.title]: { title: {} },
    [names.epicStatus]: { select: { options: selectOptions("epicStatus") } },
    [names.targetDate]: { date: {} },
    [names.creator]: { created_by: {} },
    [names.lastEdited]: { last_edited_time: {} },
    [names.waitingOnHuman]: {
      formula: {
        expression: waitingFormula(names.epicStatus, "epicStatus"),
      },
    },
  };
}

function requirementProperties(epicsDataSourceId: string): Properties {
  const names = schema.propertyNames;
  return {
    [names.title]: { title: {} },
    [names.requirementStatus]: { select: { options: selectOptions("requirementStatus") } },
    [names.priority]: { select: { options: selectOptions("priority") } },
    [names.epicRelation]: {
      relation: {
        data_source_id: epicsDataSourceId,
        dual_property: { synced_property_name: names.requirementRelation },
      },
    },
    // Written by the orchestrator, not rolled up: the Epic total is itself a
    // rollup, and Notion cannot roll up a rollup property.
    [names.cost]: { number: { format: "dollar" } },
    [names.creator]: { created_by: {} },
    [names.taskId]: { rich_text: {} },
    [names.syncFingerprint]: { rich_text: {} },
    [names.lastEdited]: { last_edited_time: {} },
    [names.waitingOnHuman]: {
      formula: {
        expression: waitingFormula(names.requirementStatus, "requirementStatus"),
      },
    },
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
    [names.aiStatus]: { select: { options: selectOptions("aiStatus") } },
    [names.phase]: { select: { options: selectOptions("phase") } },
    [names.priority]: { select: { options: selectOptions("priority") } },
    [names.repository]: { select: { options: [] } },
    [names.capabilities]: { multi_select: { options: selectOptions("capabilities") } },
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
    [names.lastEdited]: { last_edited_time: {} },
    [names.waitingOnHuman]: {
      formula: {
        expression: waitingFormula(names.aiStatus, "aiStatus"),
      },
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
    // Depends on the two rollups above, so it can only exist after they do.
    [names.progress]: {
      formula: {
        expression:
          `if(prop("${names.storyCount}") > 0, format(round(prop("${names.completedCount}") / prop("${names.storyCount}") * 100)) + "%", "-")`,
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

/**
 * Adds the Requirements database beside an existing board. Separate from the
 * full bootstrap so a workspace that already runs Epics and Stories gains the
 * product-manager layer without a second copy of everything else.
 */
export async function bootstrapRequirements(
  client: BootstrapClient,
  parentPageId: string,
  epicsDataSourceId: string,
): Promise<RequirementsBootstrapResult> {
  const requirements = await client.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: title(schema.databaseTitles.requirements),
    initial_data_source: { properties: requirementProperties(epicsDataSourceId) },
  });
  return {
    requirementsDatabaseId: requirements.id,
    requirementsDataSourceId: await dataSourceId(client, requirements.id, requirements),
  };
}

/** Creates the three code-managed databases; board view setup remains manual. */
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

  const requirements = await bootstrapRequirements(client, parentPageId, epicsDataSourceId);

  await client.dataSources.update({
    data_source_id: epicsDataSourceId,
    properties: epicRollups(),
  });

  return {
    epicsDatabaseId: epics.id,
    epicsDataSourceId,
    storiesDatabaseId: stories.id,
    storiesDataSourceId,
    ...requirements,
  };
}
