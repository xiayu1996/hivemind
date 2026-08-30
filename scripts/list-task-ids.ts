import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";

const secrets = await loadSecretsFile();
const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token: secrets.get("NOTION_TOKEN")! }) });
const dataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID")!;
const ids: string[] = [];
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
    const id = (rich?.rich_text ?? []).map((item) => item.plain_text ?? "").join("").trim();
    ids.push(id || "(empty)");
  }
  cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
} while (cursor);
const nonconforming = ids.filter((id) => !/^S-M[2345]-\d{2}$/.test(id) && id !== "S-VAL-01");
console.log(`count: ${ids.length}, nonconforming: ${JSON.stringify(nonconforming)}`);
process.exit(0);
