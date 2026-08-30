import { createClient } from "@libsql/client";
import { parse } from "yaml";

const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2] ?? "S-M2-01";
const artifacts = await client.execute(
  "SELECT body FROM phase_artifacts WHERE card_id = ? AND kind = 'dod' ORDER BY id DESC LIMIT 1",
  [cardId],
);
const body = String(artifacts.rows[0]?.body ?? "");
const doc = parse(body) as Record<string, unknown>;
console.log("top keys:", JSON.stringify(Object.keys(doc)));
const scenario = (doc.scenarios as Array<Record<string, unknown>>)[0] ?? {};
for (const [key, value] of Object.entries(scenario)) {
  console.log(`scenario.${key}: ${Array.isArray(value) ? "array" : typeof value}`);
}
for (const [key, value] of Object.entries(doc)) {
  if (key === "scenarios") continue;
  console.log(`doc.${key}: ${Array.isArray(value) ? "array" : typeof value}`);
}
process.exit(0);
