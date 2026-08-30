import { createClient } from "@libsql/client";
import { parseDoD } from "../src/pipeline/dod.js";

const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const cardId = process.argv[2] ?? "S-M2-01";
const artifacts = await client.execute(
  "SELECT body FROM phase_artifacts WHERE card_id = ? AND kind = 'dod' ORDER BY id DESC LIMIT 1",
  [cardId],
);
try {
  const dod = parseDoD(String(artifacts.rows[0]?.body));
  console.log("DoD is valid; scenarios:", dod.scenarios.length);
} catch (cause) {
  const error = cause as { cause?: { issues?: Array<{ path: (string | number)[]; message: string; code: string }> } };
  for (const issue of error.cause?.issues ?? []) {
    console.log(`${issue.path.join(".")}: [${issue.code}] ${issue.message}`);
  }
}
process.exit(0);
