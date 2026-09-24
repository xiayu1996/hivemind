// Seeds the bootstrapped Notion board with the post-M1 development tasks so the
// pipeline can self-host its own roadmap. Idempotent: existing task ids and
// epic titles are skipped. Cards stay unarmed (no AI status) until a human
// moves one to the ready column.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";

interface SeedTask {
  id: string;
  title: string;
  goal: string;
  acceptance: string;
  dependsOn: string;
  capabilities?: string[];
}
interface SeedEpic {
  id: string;
  title: string;
  priority: string;
  goal: string;
  exitCriteria: string;
  notes?: string;
  tasks: SeedTask[];
}

const seeds = JSON.parse(
  await readFile(fileURLToPath(new URL("./notion-task-seeds.json", import.meta.url)), "utf8"),
) as {
  repository: string;
  deliveryConstraint: string;
  epics: SeedEpic[];
};

const paragraph = (content: string) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content } }] },
});
const heading = (content: string) => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: [{ type: "text", text: { content } }] },
});

async function queryAll(gateway: NotionGateway, dataSourceId: string): Promise<Array<Record<string, unknown>>> {
  const pages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const response = await gateway.request({
      method: "POST",
      path: `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      priority: "interaction",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    const data = response.data as { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}

function plainText(property: unknown): string {
  const value = property as { type?: string; rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!value || value.type !== "rich_text") return "";
  return (value.rich_text ?? []).map((item) => item.plain_text ?? "").join("").trim();
}

function titleText(property: unknown): string {
  const value = property as { type?: string; title?: Array<{ plain_text?: string }> } | undefined;
  if (!value || value.type !== "title") return "";
  return (value.title ?? []).map((item) => item.plain_text ?? "").join("").trim();
}

async function main(): Promise<void> {
  const secrets = await loadSecretsFile();
  const token = secrets.get("NOTION_TOKEN");
  const storiesDataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID");
  if (!token || !storiesDataSourceId) throw new Error("NOTION_TOKEN or stories data source id missing");

  const db = openDb("file:data/seed-tasks.db");
  await migrate(db.client);
  const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token }) });

  // Locate the Epics database: a child database block under the parent page.
  const parentPageId = secrets.get("HIVEMIND_NOTION_PARENT_PAGE_ID");
  if (!parentPageId) throw new Error("HIVEMIND_NOTION_PARENT_PAGE_ID missing");
  const childDatabases: Array<{ id: string; title: string }> = [];
  let cursor: string | undefined;
  do {
    const response = await gateway.request({
      method: "GET",
      path: `/v1/blocks/${encodeURIComponent(parentPageId)}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      priority: "interaction",
    });
    const data = response.data as {
      results: Array<{ type: string; child_database?: { title?: string }; id: string }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const block of data.results) {
      if (block.type === "child_database") {
        childDatabases.push({ id: block.id, title: block.child_database?.title ?? "" });
      }
    }
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);
  const epicsDatabaseId = childDatabases.find((entry) => entry.title === "Epics")?.id;
  if (!epicsDatabaseId) throw new Error(`Epics database not found among: ${childDatabases.map((entry) => entry.title).join(", ")}`);
  const epicsDatabase = await gateway.request({
    method: "GET",
    path: `/v1/databases/${encodeURIComponent(epicsDatabaseId)}`,
    priority: "interaction",
  });
  const epicsDataSourceId = ((epicsDatabase.data as { data_sources?: Array<{ id: string }> }).data_sources ?? [])[0]?.id;
  if (!epicsDataSourceId) throw new Error("Epics database has no data source");

  const existingTasks = new Map<string, string>();
  for (const page of await queryAll(gateway, storiesDataSourceId)) {
    const properties = (page.properties ?? {}) as Record<string, unknown>;
    const taskId = plainText(properties["任务 ID"]);
    if (taskId) existingTasks.set(taskId, String(page.id));
  }
  const existingEpics = new Map<string, string>();
  for (const page of await queryAll(gateway, epicsDataSourceId)) {
    const properties = (page.properties ?? {}) as Record<string, unknown>;
    const epicTitle = titleText(properties["标题"]);
    if (epicTitle) existingEpics.set(epicTitle, String(page.id));
  }

  let createdEpics = 0;
  let createdTasks = 0;
  let skippedTasks = 0;

  for (const epic of seeds.epics) {
    let epicPageId = existingEpics.get(epic.title);
    if (!epicPageId) {
      const epicChildren = [
        heading("需求描述"),
        paragraph(`里程碑目标: ${epic.goal}`),
        paragraph(`出口判据: ${epic.exitCriteria}`),
        paragraph("总约束: 每张任务卡独立产出一个 PR, 未经人工评审不得合并, 禁止直接推送主分支。"),
        ...(epic.notes ? [paragraph(epic.notes)] : []),
      ];
      const created = await gateway.request({
        method: "POST",
        path: "/v1/pages",
        priority: "interaction",
        body: {
          parent: { type: "data_source_id", data_source_id: epicsDataSourceId },
          properties: { 标题: { title: [{ type: "text", text: { content: epic.title } }] } },
          children: epicChildren,
        },
      });
      epicPageId = String((created.data as { id: string }).id);
      createdEpics++;
      console.log(`epic created: ${epic.title} -> ${epicPageId}`);
    }

    for (const task of epic.tasks) {
      if (existingTasks.has(task.id)) {
        skippedTasks++;
        continue;
      }
      const capabilities = (task.capabilities ?? []).map((name) => ({ name }));
      const body = [
        heading("需求描述"),
        paragraph(`目标: ${task.goal}`),
        paragraph(`验收: ${task.acceptance}`),
        paragraph(`前置: ${task.dependsOn}`),
        paragraph(seeds.deliveryConstraint),
      ];
      const created = await gateway.request({
        method: "POST",
        path: "/v1/pages",
        priority: "interaction",
        body: {
          parent: { type: "data_source_id", data_source_id: storiesDataSourceId },
          properties: {
            标题: { title: [{ type: "text", text: { content: `${task.id} ${task.title}` } }] },
            "任务 ID": { rich_text: [{ type: "text", text: { content: task.id } }] },
            目标仓库: { select: { name: seeds.repository } },
            目标分支: { rich_text: [{ type: "text", text: { content: "main" } }] },
            优先级: { select: { name: epic.priority } },
            Epic: { relation: [{ id: epicPageId! }] },
            ...(capabilities.length > 0 ? { 能力标签: { multi_select: capabilities } } : {}),
          },
          children: body,
        },
      });
      console.log(`task created: ${task.id} -> ${(created.data as { id: string }).id}`);
      createdTasks++;
    }
  }

  console.log(`seed complete: epics created=${createdEpics}, tasks created=${createdTasks}, tasks skipped(exists)=${skippedTasks}`);
  db.close();
}

main().catch((error: unknown) => {
  console.error(`SEED FAILED: ${(error as Error).message}`);
  process.exit(1);
});
