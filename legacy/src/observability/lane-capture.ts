import { readdir } from "node:fs/promises";
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

/**
 * Packs every capture left flat under a tree whose runs have all ended.
 *
 * A run that died never reaches `writeEvidence`, so its capture is never
 * folded into a canonical log and stays as the only record of what it sent --
 * flat, and a capture is one conversation repeated at growing lengths. Called
 * once a card has no live run, which is the moment every file under it is
 * finished.
 */
export async function packFinishedCaptures(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  let packed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith("-requests.jsonl")) continue;
    // Absent by the time we get here means another pass took it; not an error.
    await packFile(join(entry.parentPath, entry.name)).then(() => { packed++; }).catch(() => undefined);
  }
  return packed;
}
