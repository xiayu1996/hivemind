import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2] ?? "S-VAL-01";
const verifies = await client.execute(
  "SELECT round, verdict, failed_scenarios FROM verify_records WHERE card_id = ? ORDER BY round",
  [cardId],
);
console.log("verify_records:", JSON.stringify(verifies.rows));
const events = await client.execute(
  "SELECT type, data FROM event_log WHERE card_id = ? ORDER BY ts DESC LIMIT 8",
  [cardId],
);
for (const row of events.rows) console.log(String(row.type), String(row.data).slice(0, 180));
process.exit(0);
