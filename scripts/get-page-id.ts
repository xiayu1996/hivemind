import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
const rows = await client.execute({
  sql: "SELECT notion_page_id FROM stories WHERE id = ?",
  args: [process.argv[2] ?? "S-VAL-01"],
});
console.log(String(rows.rows[0]?.notion_page_id ?? "(none)"));
process.exit(0);
