import { createClient } from "@libsql/client";
import { parse } from "yaml";

const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2] ?? "S-M2-01";
const artifacts = await client.execute(
  "SELECT body FROM phase_artifacts WHERE card_id = ? AND kind = 'dod' ORDER BY id DESC LIMIT 1",
  [cardId],
);
const doc = parse(String(artifacts.rows[0]?.body)) as { acceptance_criteria?: unknown[] };
for (const [index, item] of (doc.acceptance_criteria ?? []).entries()) {
  if (typeof item !== "string") {
    console.log(`criterion ${index} (${typeof item}):`);
    console.log(JSON.stringify(item, null, 2).slice(0, 400));
  }
}
process.exit(0);
