import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@notionhq/client";
import { bootstrapNotion } from "../src/notion/bootstrap.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function secrets(): Promise<Map<string, string>> {
  const path = join(homedir(), ".hivemind", "secrets.env");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${path}: ${(cause as Error).message}`, { cause });
  }
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`invalid secrets.env assignment for key ${line.split("=")[0]}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

async function main(): Promise<void> {
  const stored = await secrets();
  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  const parentPageId = argument("--parent") ?? process.env.HIVEMIND_NOTION_PARENT_PAGE_ID ??
    stored.get("HIVEMIND_NOTION_PARENT_PAGE_ID");
  if (!token) throw new Error("NOTION_TOKEN is missing from ~/.hivemind/secrets.env");
  if (!parentPageId) throw new Error("pass --parent or set HIVEMIND_NOTION_PARENT_PAGE_ID");

  const client = new Client({ auth: token, notionVersion: "2025-09-03" });
  const result = await bootstrapNotion(client, parentPageId);
  console.log(JSON.stringify(result, null, 2));
  console.log("Database schemas created. Complete the board view steps in docs/runbooks/notion-bootstrap.md.");
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
