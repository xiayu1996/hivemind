// Read-only probe confirming the stored Notion credentials and bootstrapped
// data source are live. Prints only identifiers and counts, never token values.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@notionhq/client";

async function loadSecrets(): Promise<Map<string, string>> {
  const path = join(homedir(), ".hivemind", "secrets.env");
  const content = await readFile(path, "utf8");
  const values = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

async function main(): Promise<void> {
  const secrets = await loadSecrets();
  const token = secrets.get("NOTION_TOKEN");
  const dataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID");
  const botUserId = secrets.get("NOTION_BOT_USER_ID");
  if (!token || !dataSourceId) throw new Error("NOTION_TOKEN or data source id missing");

  const client = new Client({ auth: token, notionVersion: "2025-09-03" });

  const me = await client.users.me({}) as unknown as {
    id: string;
    name?: string;
    bot?: { owner?: { type?: string } };
  };
  console.log(`token works: bot = ${me.bot?.owner?.type ?? "unknown"} owner, name = ${me.name ?? "(unnamed)"}`);
  if (botUserId && me.id !== botUserId) {
    console.log(`WARNING: stored bot user id ${botUserId} does not match live token user ${me.id}`);
  } else {
    console.log("stored bot user id matches the live token user");
  }

  const dataSource = await client.dataSources.retrieve({ data_source_id: dataSourceId }) as unknown as {
    title?: Array<{ plain_text?: string }>;
    properties: Record<string, unknown>;
  };
  const storiesTitle = Array.isArray(dataSource.title) && dataSource.title[0]
    ? dataSource.title[0].plain_text
    : "(untitled)";
  console.log(`stories data source live: ${storiesTitle}, properties = ${Object.keys(dataSource.properties).join(", ")}`);

  const rows = await client.dataSources.query({ data_source_id: dataSourceId, page_size: 5 });
  console.log(`stories rows visible: ${rows.results.length} (of has_more=${rows.has_more ? "many" : "none"})`);
}

main().catch((error: unknown) => {
  console.error(`PROBE FAILED: ${(error as Error).message}`);
  process.exit(1);
});
