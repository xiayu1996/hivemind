// Operator recovery for a parked Story: restores the state captured at the
// true stop and clears the phase reentry budget, then leaves dispatch to the
// orchestrator. Every transition still goes through the store's legality
// checks and event log.
import { randomUUID } from "node:crypto";
import { openDb } from "../src/persistence/client.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const cardId = argument("--card-id");
  if (!cardId) throw new Error("--card-id is required");
  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const handle = openDb(dbUrl);
  const store = new StoryExecutionStore(handle.client);

  const story = await store.getStory(cardId);
  if (story.state !== "NEEDS_INPUT") throw new Error(`Story ${cardId} is ${story.state}, not NEEDS_INPUT`);
  const restored = story.resumeState;
  if (!restored || restored === "NEEDS_INPUT") throw new Error(`Story ${cardId} has no restorable state`);
  // Same mapping as the comment-driven resume: re-entering VERIFY means the
  // code round runs again, so the verifier judges a fresh implementation.
  const target = restored === "VERIFY" ? "CODE" : restored;

  await store.transition(cardId, "NEEDS_INPUT", target, "human", `${cardId.toLowerCase()}-resume-${randomUUID()}`);
  await handle.client.execute({
    sql: "UPDATE stories SET phase_reentries = 0, updated_at = ? WHERE id = ?",
    args: [Date.now(), cardId],
  });
  console.log(`Story ${cardId} restored to ${target} with a fresh reentry budget`);
  handle.close();
}

main().catch((error: unknown) => {
  console.error(`RESUME FAILED: ${(error as Error).message}`);
  process.exit(1);
});
