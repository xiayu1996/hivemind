// Operator tool: applies one legal Story transition through the store.
import { randomUUID } from "node:crypto";
import { openDb } from "../src/persistence/client.js";
import type { StoryState } from "../src/orchestrator/state-machine.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";

const from = process.argv[2] as StoryState | undefined;
const cardId = process.argv[3];
const to = process.argv[4] as StoryState | undefined;
if (!from || !cardId || !to) throw new Error("usage: transition-story.ts <from> <card-id> <to>");

const handle = openDb(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
const store = new StoryExecutionStore(handle.client);
const story = await store.getStory(cardId);
if (story.state !== from) throw new Error(`Story ${cardId} is ${story.state}, expected ${from}`);
await store.transition(cardId, from, to, "human", `${cardId.toLowerCase()}-op-${randomUUID()}`);
console.log(`Story ${cardId}: ${from} -> ${to}`);
handle.close();
process.exit(0);
