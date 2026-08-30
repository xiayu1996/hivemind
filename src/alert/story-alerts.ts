import type { StorySnapshot } from "../orchestrator/story-execution-store.js";
import { AlertRouter } from "./index.js";

/** Delivers the mandatory out-of-band notification for a true Story stop. */
export async function alertNeedsInput(
  alerts: AlertRouter,
  story: Pick<StorySnapshot, "id" | "state" | "stopReason">,
): Promise<boolean> {
  if (story.state !== "NEEDS_INPUT") return false;
  // With no channel configured the Notion board is the only notification
  // surface; the startup warning already told the operator about this.
  if (alerts.channelCount === 0) return false;
  const result = await alerts.send({
    kind: "needs_input",
    title: "Story needs human input",
    body: story.stopReason ?? "The Story is waiting for a human decision.",
    cardId: story.id,
  });
  if (result.delivered.length === 0) {
    throw new Error(`needs-input alert failed on every channel: ${JSON.stringify(result.failed)}`);
  }
  return true;
}
