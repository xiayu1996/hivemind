import { join } from "node:path";
import { packFile } from "./packed-file.js";

/**
 * Where a lane that builds no canonical log keeps the requests it sent.
 *
 * A phase run folds its capture into its run log and deletes it. The sweep,
 * decompose, requirement and prototype lanes have no such reader, so the
 * capture is their only record of what the model was sent -- and naming it
 * after the evidence root alone made every invocation append to one file that
 * nothing ever finished, so nothing could pack it and nothing could delete it.
 * One file per invocation is finished the moment its process exits.
 */
export function laneCapturePath(evidenceRoot: string, lane: string, startedAt: number): string {
  const stamp = new Date(startedAt).toISOString().replaceAll(":", "-");
  return join(evidenceRoot, "captures", `${lane}-${stamp}.jsonl`);
}

/**
 * Packs a capture whose writer has exited.
 *
 * A lane that sent nothing leaves no file, which is not a failure: the
 * extension only creates one on the first provider request.
 */
export async function finishLaneCapture(path: string): Promise<void> {
  try {
    await packFile(path);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
  }
}
