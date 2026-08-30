// One-shot operator fix: the target-repository select must carry the GitHub
// owner/name slug the MR adapter hands to gh, not the bare repository name.
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";

const secrets = await loadSecretsFile();
const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token: secrets.get("NOTION_TOKEN")! }) });
const dataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID")!;
let fixed = 0;
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
    const repo = properties["目标仓库"] as { select?: { name?: string } } | undefined;
    if (repo?.select?.name === "hivemind") {
      await gateway.request({
        method: "PATCH",
        path: `/v1/pages/${encodeURIComponent(String(page.id))}`,
        priority: "interaction",
        body: { properties: { "目标仓库": { select: { name: "xiayu1996/hivemind" } } } },
      });
      fixed++;
    }
  }
  cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
} while (cursor);
console.log(`fixed ${fixed} cards`);
process.exit(0);
