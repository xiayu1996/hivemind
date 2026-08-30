import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";

const secrets = await loadSecretsFile();
const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token: secrets.get("NOTION_TOKEN")! }) });
const pageId = process.argv[2]!;
const page = await gateway.request({ method: "GET", path: `/v1/pages/${pageId}`, priority: "interaction" });
const props = (page.data as { properties?: Record<string, unknown> }).properties ?? {};
for (const name of ["AI 状态", "执行阶段", "MR", "成本(USD)", "Tokens", "轮次", "同步指纹"]) {
  const value = props[name] as {
    type?: string;
    select?: { name?: string };
    url?: string | null;
    number?: number | null;
    rich_text?: Array<{ plain_text?: string }>;
  };
  const rendered = value?.type === "select" ? value.select?.name
    : value?.type === "url" ? value.url
    : value?.type === "number" ? String(value.number)
    : (value?.rich_text ?? []).map((item) => item.plain_text).join("");
  console.log(`${name}: ${rendered ?? "(empty)"}`);
}
const blocks = await gateway.request({ method: "GET", path: `/v1/blocks/${pageId}/children?page_size=100`, priority: "interaction" });
const items = (blocks.data as { results: Array<Record<string, unknown>> }).results;
const headings = items.filter((b) => b.type === "heading_2").map((b) => {
  const value = b.heading_2 as { rich_text?: Array<{ plain_text?: string }> };
  return (value.rich_text ?? []).map((t) => t.plain_text).join("");
});
console.log("页面区段:", headings.join(" / "));
console.log("验证轮次 toggles:", items.filter((b) => b.type === "toggle").length);
process.exit(0);
