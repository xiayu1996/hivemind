import type { Client, CreateDatabaseParameters, UpdateDataSourceParameters } from "@notionhq/client";
import schema from "./notion-schema.json" with { type: "json" };
import { STORY_BOARD_STATUS } from "./board-status.js";

type BootstrapClient = Pick<Client, "databases" | "dataSources" | "pages">;
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
    [names.mergeRequest]: { url: {} },
    [names.taskId]: { rich_text: {} },
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
    // Which registered repository the requirement is for. Seeded empty: the
    // options are the registry's slugs, added as repositories are registered.
    [names.repository]: { select: { options: [] } },
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
    [names.completionValue]: {
      formula: { expression: `if(prop("${names.aiStatus}") == "${STORY_BOARD_STATUS.done}", 1, 0)` },
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

/**
 * Brings a live Epics database up to the current schema: new status options,
 * the review request column and the waiting formula that mentions them. Notion
 * keeps existing options (their colours included) and adds the missing ones,
 * so this is safe to run on every board and does nothing on a current one.
 */
export async function upgradeEpicBoard(client: BootstrapClient, epicsDataSourceId: string): Promise<void> {
  const names = schema.propertyNames;
  // Notion refuses a colour on an option that already exists, even the colour it
  // has; existing options travel by name only and new ones bring their colour.
  const current = await client.dataSources.retrieve({ data_source_id: epicsDataSourceId });
  const statusProperty = current.properties[names.epicStatus];
  const existing = new Set(
    statusProperty && "select" in statusProperty ? statusProperty.select.options.map((option) => option.name) : [],
  );
  const options = selectOptions("epicStatus").map((option) => (existing.has(option.name) ? { name: option.name } : option));
  await client.dataSources.update({
    data_source_id: epicsDataSourceId,
    properties: {
      [names.epicStatus]: { select: { options } },
      [names.mergeRequest]: { url: {} },
      [names.taskId]: { rich_text: {} },
      [names.waitingOnHuman]: { formula: { expression: waitingFormula(names.epicStatus, "epicStatus") } },
    },
  });
}

interface LiveOption {
  id: string;
  name: string;
}

function liveOptions(property: unknown): LiveOption[] {
  if (!property || typeof property !== "object" || !("select" in property)) return [];
  const select = (property as { select: { options?: Array<{ id?: string; name?: string }> } }).select;
  return (select.options ?? [])
    .filter((option): option is LiveOption => typeof option.id === "string" && typeof option.name === "string");
}

/** Moves every page holding one select value to another, which has to happen
 * before the value is deleted: Notion blanks the property on pages that still
 * hold an option it removes. */
async function moveOption(
  client: BootstrapClient,
  sourceId: string,
  property: string,
  from: string,
  to: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const response = await client.dataSources.query({
      data_source_id: sourceId,
      filter: { property, select: { equals: from } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of response.results) {
      await client.pages.update({ page_id: page.id, properties: { [property]: { select: { name: to } } } });
    }
    cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
  } while (cursor);
}

/**
 * Rewrites one select column to the current vocabulary in three passes, which
 * is what the API leaves available: Notion ignores a new name sent with an
 * option id (renaming is a UI-only move) and silently drops every option the
 * update omits, blanking the pages that hold it. So the new words are added
 * first, the pages move onto them, and only then do the old words go.
 */
async function retireOptions(
  client: BootstrapClient,
  sourceId: string,
  property: string,
  group: OptionGroup,
  renames: Record<string, string | undefined>,
): Promise<void> {
  const read = async (): Promise<LiveOption[]> => {
    const current = await client.dataSources.retrieve({ data_source_id: sourceId });
    return liveOptions(current.properties[property]);
  };
  const order = schema.options[group] as readonly string[];
  const rank = (name: string) => (order.indexOf(name) < 0 ? order.length : order.indexOf(name));

  const before = await read();
  const missing = selectOptions(group).filter((option) => !before.some((live) => live.name === option.name));
  if (missing.length > 0) {
    await client.dataSources.update({
      data_source_id: sourceId,
      properties: {
        [property]: { select: { options: [...before.map((option) => ({ id: option.id })), ...missing] as never } },
      },
    });
  }

  const retired = before.filter((option) => renames[option.name]);
  for (const option of retired) {
    await moveOption(client, sourceId, property, option.name, renames[option.name]!);
  }
  if (retired.length === 0 && missing.length === 0) return;

  const after = await read();
  const kept = after
    .filter((option) => !renames[option.name])
    .toSorted((left, right) => rank(left.name) - rank(right.name));
  await client.dataSources.update({
    data_source_id: sourceId,
    properties: { [property]: { select: { options: kept.map((option) => ({ id: option.id })) as never } } },
  });
}

/**
 * Adds one select option per registered repository, adding only.
 *
 * Deleting an option would blank the property on every page still holding it,
 * so a repository that leaves the registry keeps its option until a person
 * removes it on the board.
 */
export async function seedRepositoryOptions(
  client: BootstrapClient,
  boardDataSourceId: string,
  slugs: readonly string[],
): Promise<string[]> {
  const names = schema.propertyNames;
  const live = liveOptions(
    (await client.dataSources.retrieve({ data_source_id: boardDataSourceId })).properties[names.repository],
  );
  const missing = slugs.filter((slug) => !live.some((option) => option.name === slug));
  if (missing.length === 0) return [];
  await client.dataSources.update({
    data_source_id: boardDataSourceId,
    properties: {
      [names.repository]: {
        select: {
          options: [...live.map((option) => ({ id: option.id })), ...missing.map((slug) => ({ name: slug }))] as never,
        },
      },
    },
  });
  return missing;
}

/**
 * Brings a live Requirements database up to the current schema: the target
 * repository a person picks when more than one is registered.
 */
export async function upgradeRequirementBoard(
  client: BootstrapClient,
  requirementsDataSourceId: string,
  slugs: readonly string[] = [],
): Promise<void> {
  const names = schema.propertyNames;
  const properties = (await client.dataSources.retrieve({ data_source_id: requirementsDataSourceId })).properties;
  if (!properties[names.repository]) {
    await client.dataSources.update({
      data_source_id: requirementsDataSourceId,
      properties: { [names.repository]: { select: { options: [] } } } as never,
    });
  }
  await seedRepositoryOptions(client, requirementsDataSourceId, slugs);
}

/**
 * Brings a live Stories database up to the current schema: the execution-phase
 * words the orchestrator now writes, and one option per repository slug instead
 * of the bare name an early board was seeded with.
 */
export async function upgradeStoryBoard(
  client: BootstrapClient,
  storiesDataSourceId: string,
  repositorySlug?: string,
): Promise<void> {
  const names = schema.propertyNames;
  await retireOptions(
    client,
    storiesDataSourceId,
    names.phase,
    "phase",
    schema.retiredOptions.phase as Record<string, string | undefined>,
  );
  // A Story's own review request is no longer something a person confirms one
  // card at a time; the review they gate is the Epic's.
  await retireOptions(
    client,
    storiesDataSourceId,
    names.aiStatus,
    "aiStatus",
    schema.retiredOptions.aiStatus as Record<string, string | undefined>,
  );
  // The fingerprint is central truth now. Left on the board it is a column of
  // hashes a person has to look past, and one they can edit.
  await client.dataSources.update({
    data_source_id: storiesDataSourceId,
    properties: { [names.syncFingerprint]: null } as never,
  });

  if (!repositorySlug) return;
  const bare = repositorySlug.split("/").at(-1);
  if (!bare || bare === repositorySlug) return;
  const live = liveOptions(
    (await client.dataSources.retrieve({ data_source_id: storiesDataSourceId })).properties[names.repository],
  );
  if (!live.some((option) => option.name === bare)) return;
  // The slug has to exist before the pages can move onto it, and the bare name
  // can only go once nothing holds it.
  if (!live.some((option) => option.name === repositorySlug)) {
    await client.dataSources.update({
      data_source_id: storiesDataSourceId,
      properties: {
        [names.repository]: {
          select: { options: [...live.map((option) => ({ id: option.id })), { name: repositorySlug }] as never },
        },
      },
    });
  }
  await moveOption(client, storiesDataSourceId, names.repository, bare, repositorySlug);
  const after = liveOptions(
    (await client.dataSources.retrieve({ data_source_id: storiesDataSourceId })).properties[names.repository],
  );
  await client.dataSources.update({
    data_source_id: storiesDataSourceId,
    properties: {
      [names.repository]: {
        select: { options: after.filter((option) => option.name !== bare).map((option) => ({ id: option.id })) as never },
      },
    },
  });
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
