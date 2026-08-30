// One-shot operator cleanup: archives the misnamed seed cards (task ids
// without the S- prefix required by the DoD grammar) and the superseded
// S-VAL-001 validation card so the corrected seeds can be recreated.
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";

const secrets = await loadSecretsFile();
const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token: secrets.get("NOTION_TOKEN")! }) });
const dataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID")!;

let archived = 0;
let cursor: string | undefined;
do {
  const response = await gateway.request({
    method: "POST",
    path: `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
    priority: "interaction",
    body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
  });
  const data = response.data as { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
  for (const page of data.results) {
    const properties = (page.properties ?? {}) as Record<string, unknown>;
    const rich = properties["任务 ID"] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    const taskId = (rich?.rich_text ?? []).map((item) => item.plain_text ?? "").join("").trim();
    const misnamed = /^[MP][0-9]-[0-9]{2}$/.test(taskId) || taskId === "S-VAL-001";
    if (misnamed) {
      await gateway.request({
        method: "PATCH",
        path: `/v1/pages/${encodeURIComponent(String(page.id))}`,
        priority: "interaction",
        body: { archived: true },
      });
      archived++;
      console.log(`archived ${taskId}`);
    }
  }
  cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
} while (cursor);
console.log(`done: ${archived} cards archived`);
process.exit(0);
