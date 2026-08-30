import { createClient } from "@libsql/client";
const client = createClient({ url: process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db" });
await client.execute("UPDATE stories SET repo = 'xiayu1996/hivemind' WHERE repo = 'hivemind'");
const rows = await client.execute("SELECT id, repo FROM stories");
console.log(JSON.stringify(rows.rows));
process.exit(0);
