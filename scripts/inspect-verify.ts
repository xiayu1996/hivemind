import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2] ?? "S-VAL-01";
const artifacts = await client.execute(
  `SELECT pa.body FROM phase_artifacts pa
   JOIN phase_runs pr ON pr.run_id = pa.run_id
   WHERE pr.card_id = ? AND pr.phase = 'VERIFY'
   ORDER BY pr.started_at DESC LIMIT 1`,
  [cardId],
);
console.log(String(artifacts.rows[0]?.body ?? "(no verify artifact)").slice(0, 1500));
process.exit(0);
