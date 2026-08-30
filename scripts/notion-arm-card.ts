// Arms a Story card for pipeline intake by setting its AI status to the ready
// option. Acceptance operators use this to feed one card at a time so the
// orchestrator never races two self-hosting tasks.
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";
import schema from "../src/notion/notion-schema.json" with { type: "json" };

const READY_STATUS = schema.options.aiStatus[0]!;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const taskId = argument("--task-id");
  if (!taskId) throw new Error("--task-id is required");
  const secrets = await loadSecretsFile();
  const token = secrets.get("NOTION_TOKEN");
  const dataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID");
  if (!token || !dataSourceId) throw new Error("NOTION_TOKEN or stories data source id missing");

  const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token }) });
  const matches: Array<{ id: string; title: string }> = [];
  let cursor: string | undefined;
  do {
    const response = await gateway.request({
      method: "POST",
      path: `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      priority: "interaction",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    const data = response.data as {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const page of data.results) {
      const properties = (page.properties ?? {}) as Record<string, unknown>;
      const rich = properties[schema.propertyNames.taskId] as
        | { type?: string; rich_text?: Array<{ plain_text?: string }> }
        | undefined;
      const id = (rich?.rich_text ?? []).map((item) => item.plain_text ?? "").join("").trim();
      if (id === taskId) {
        const title = properties[schema.propertyNames.title] as
          | { title?: Array<{ plain_text?: string }> }
          | undefined;
        matches.push({
          id: String(page.id),
          title: (title?.title ?? []).map((item) => item.plain_text ?? "").join(""),
        });
      }
    }
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);
  if (matches.length === 0) throw new Error(`no Story card carries task id ${taskId}`);
  if (matches.length > 1) throw new Error(`task id ${taskId} is ambiguous across ${matches.length} cards`);

  await gateway.request({
    method: "PATCH",
    path: `/v1/pages/${encodeURIComponent(matches[0]!.id)}`,
    priority: "interaction",
    body: {
      properties: {
        [schema.propertyNames.aiStatus]: { select: { name: READY_STATUS } },
      },
    },
  });
  console.log(`armed ${taskId} (${matches[0]!.title}) with AI status ${READY_STATUS}: ${matches[0]!.id}`);
}

main().catch((error: unknown) => {
  console.error(`ARM FAILED: ${(error as Error).message}`);
  process.exit(1);
});
