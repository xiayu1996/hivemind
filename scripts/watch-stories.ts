// Acceptance monitor: prints the central execution state of every Story card
// so an operator can follow pipeline progress without touching Notion.
import { createClient } from "@libsql/client";

const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
const client = createClient({ url: dbUrl });

const stories = await client.execute(
  "SELECT id, state, phase, inner_loop_rounds, phase_reentries, stop_reason, mr_url, updated_at FROM stories ORDER BY created_at",
);
for (const row of stories.rows) {
  const parts = [
    `id=${row.id}`,
    `state=${row.state}`,
    `phase=${row.phase ?? "-"}`,
    `loop=${row.inner_loop_rounds}`,
    `reentry=${row.phase_reentries}`,
    `stop=${row.stop_reason ?? "-"}`,
    `mr=${row.mr_url ?? "-"}`,
  ];
  console.log(parts.join(" "));
}
if (stories.rows.length === 0) console.log("(no stories in central db)");
const recent = await client.execute(
  "SELECT type, count(*) as n FROM event_log GROUP BY type ORDER BY n DESC LIMIT 8",
);
for (const row of recent.rows) console.log(`events ${row.type}: ${row.n}`);
process.exit(0);
