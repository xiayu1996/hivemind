import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2]!;
const cost = await client.execute({
  sql: "SELECT count(*) AS n, ROUND(SUM(cost_usd), 8) AS total FROM cost_entries WHERE card_id = ?",
  args: [cardId],
});
console.log("cost_entries:", JSON.stringify(cost.rows[0]));
const runs = await client.execute({
  sql: "SELECT phase, count(*) AS n FROM phase_runs WHERE card_id = ? GROUP BY phase ORDER BY phase",
  args: [cardId],
});
console.log("phase_runs:", JSON.stringify(runs.rows));
process.exit(0);
