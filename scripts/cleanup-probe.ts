import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
await client.execute({
  sql: "DELETE FROM phase_runs WHERE card_id = ? AND session_id = 'probe-session'",
  args: [process.argv[2] ?? "S-M2-01"],
});
console.log("probe rows removed");
process.exit(0);
