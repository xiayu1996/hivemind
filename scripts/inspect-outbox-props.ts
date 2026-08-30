import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const pageId = process.argv[2]!;
const rows = (await client.execute({
  sql: "SELECT id, state, attempts, last_error, payload, payload_hash FROM notion_outbox WHERE target = ? ORDER BY id",
  args: [`story-properties:${pageId}`],
})).rows;
for (const row of rows) {
  const payload = JSON.parse(String(row.payload)) as { fingerprint?: string; properties?: Record<string, unknown> };
  const props = payload.properties ?? {};
  console.log(`#${row.id} state=${row.state} attempts=${row.attempts} fp=${String(payload.fingerprint ?? "").slice(0, 8)} mr=${JSON.stringify((props["MR"] as { url?: string })?.url ?? null)} cost=${JSON.stringify(props["成本(USD)"])} err=${String(row.last_error ?? "-").slice(0, 80)}`);
}
process.exit(0);
