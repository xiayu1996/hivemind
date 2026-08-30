import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2]!;
const artifacts = await client.execute(
  `SELECT body FROM phase_artifacts WHERE card_id = ? AND kind = 'dod' ORDER BY id DESC LIMIT 1`,
  [cardId],
);
console.log(String(artifacts.rows[0]?.body ?? "(none)").slice(0, 1200));
process.exit(0);
