import { Client } from "@notionhq/client";
import { bootstrapNotion } from "../src/notion/bootstrap.js";
import { loadSecretsFile, upsertSecretFile } from "../src/config/secrets-file.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const stored = await loadSecretsFile();
  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  const parentPageId = argument("--parent") ?? process.env.HIVEMIND_NOTION_PARENT_PAGE_ID ??
    stored.get("HIVEMIND_NOTION_PARENT_PAGE_ID");
  if (!token) throw new Error("NOTION_TOKEN is missing from ~/.hivemind/secrets.env");
  if (!parentPageId) throw new Error("pass --parent or set HIVEMIND_NOTION_PARENT_PAGE_ID");

  const client = new Client({ auth: token, notionVersion: "2025-09-03" });
  const result = await bootstrapNotion(client, parentPageId);
  const bot = await client.users.me({});
  await upsertSecretFile("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID", result.storiesDataSourceId);
  await upsertSecretFile("HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID", result.epicsDataSourceId);
  await upsertSecretFile("NOTION_BOT_USER_ID", bot.id);
  console.log(JSON.stringify(result, null, 2));
  console.log("Database schemas created and the bot identity was stored locally. Complete the board view steps in docs/runbooks/notion-bootstrap.md.");
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
