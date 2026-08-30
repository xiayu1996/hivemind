import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2]!;
const rows = (await client.execute({
  sql: "SELECT run_id, phase, round, status, started_at FROM phase_runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 6",
  args: [cardId],
})).rows;
for (const row of rows) {
  const runId = String(row.run_id); console.log(`${runId.slice(0, 40)} ${row.phase} r${row.round} ${row.status} ${new Date(Number(row.started_at)).toISOString()}`);
}
process.exit(0);
