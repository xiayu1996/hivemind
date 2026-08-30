import { randomUUID } from "node:crypto";
import { openDb } from "../src/persistence/client.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";

const handle = openDb(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
const store = new StoryExecutionStore(handle.client);
const cardId = process.argv[2] ?? "S-M2-01";

const story = await store.getStory(cardId);
console.log("state:", story.state, "phase:", story.phase);
const runId = `${cardId.toLowerCase()}-design-1-${randomUUID()}`;
try {
  await store.beginPhase({ runId, cardId, phase: "DESIGN", round: 1, prompt: `probe ${runId}` });
  console.log("beginPhase ok, runId:", runId);
} catch (cause) {
  console.log("beginPhase FAILED:", (cause as Error).message);
  process.exit(1);
}
try {
  await store.completePhase({
    runId,
    sessionId: "probe-session",
    artifacts: [{ kind: "design-summary", body: "probe" }, { kind: "dod", body: "story_id: probe" }],
  });
  console.log("completePhase ok");
} catch (cause) {
  console.log("completePhase FAILED:", (cause as Error).message);
}
process.exit(0);
