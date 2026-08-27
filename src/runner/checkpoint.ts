import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Checkpoint {
  file: string;
  runId: string;
  seq: number;
  sha256: string;
  bytes: number;
  createdAt: number;
  /** Lines dropped by the trailing-corruption repair, if any. */
  truncatedLines: number;
}

export interface CheckpointStoreOptions {
  dir: string;
  /** How many checkpoints to keep per run. */
  keep?: number;
  now?: () => number;
}

const META_SUFFIX = ".meta.json";

/**
 * Durable copies of a pi session.
 *
 * RPC exposes `get_messages` but has no command to load a Context back, so the
 * only thing pi can actually resume from is a session JSONL file. Checkpoints
 * therefore store the file itself, not a message array.
 *
 * Sessions are treated as a discardable cache with a known failure mode: pi has
 * an open bug where the tail of the JSONL can be left corrupt. Every checkpoint
 * is validated on write and repaired by truncating to the last intact record,
 * because corruption always sits at the end.
 */
export class CheckpointStore {
  private readonly keep: number;
  private readonly now: () => number;

  constructor(private readonly options: CheckpointStoreOptions) {
    this.keep = options.keep ?? 5;
    this.now = options.now ?? Date.now;
  }

  /**
   * Copies a session file into the store. The copy is written to a temporary
   * name and renamed, so a crash mid-write can never leave a half-written
   * checkpoint that later looks valid.
   */
  async capture(runId: string, seq: number, sessionFile: string): Promise<Checkpoint> {
    await mkdir(this.options.dir, { recursive: true });

    const raw = await readFile(sessionFile, "utf8");
    const { repaired, truncatedLines } = repairJsonl(raw);

    const name = `${runId}.${String(seq).padStart(6, "0")}.jsonl`;
    const target = join(this.options.dir, name);
    const temp = `${target}.tmp`;

    await writeFile(temp, repaired, "utf8");
    await rename(temp, target);

    const checkpoint: Checkpoint = {
      file: target,
      runId,
      seq,
      sha256: createHash("sha256").update(repaired).digest("hex"),
      bytes: Buffer.byteLength(repaired),
      createdAt: this.now(),
      truncatedLines,
    };

    await writeFile(`${target}${META_SUFFIX}`, JSON.stringify(checkpoint), "utf8");
    await this.#prune(runId);
    return checkpoint;
  }

  /** Checkpoints for a run, newest first. */
  async list(runId: string): Promise<Checkpoint[]> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return [];
    }

    const metas = names.filter((n) => n.startsWith(`${runId}.`) && n.endsWith(META_SUFFIX));
    const out: Checkpoint[] = [];
    for (const meta of metas) {
      try {
        out.push(JSON.parse(await readFile(join(this.options.dir, meta), "utf8")) as Checkpoint);
      } catch {
        // A meta file that cannot be read is treated as absent rather than fatal.
      }
    }
    return out.toSorted((a, b) => b.seq - a.seq);
  }

  /**
   * Newest checkpoint whose bytes still match its recorded digest.
   *
   * Falling back to an older checkpoint costs replayed work; resuming from a
   * silently altered one costs a corrupted session, so integrity wins.
   */
  async latestIntact(runId: string): Promise<Checkpoint | null> {
    for (const checkpoint of await this.list(runId)) {
      if (await this.#verify(checkpoint)) return checkpoint;
    }
    return null;
  }

  async #verify(checkpoint: Checkpoint): Promise<boolean> {
    try {
      const content = await readFile(checkpoint.file, "utf8");
      return createHash("sha256").update(content).digest("hex") === checkpoint.sha256;
    } catch {
      return false;
    }
  }

  async #prune(runId: string): Promise<void> {
    const all = await this.list(runId);
    for (const checkpoint of all.slice(this.keep)) {
      await rm(checkpoint.file, { force: true });
      await rm(`${checkpoint.file}${META_SUFFIX}`, { force: true });
    }
  }
}

export interface RepairResult {
  repaired: string;
  truncatedLines: number;
}

/**
 * Drops unparseable trailing records.
 *
 * Only the tail is repaired: pi's corruption shows up when a write is cut short,
 * so a bad record in the middle means something else is wrong and truncating
 * there would silently discard good history. In that case the content is
 * returned unchanged and the caller can fall back to an older checkpoint.
 */
export function repairJsonl(raw: string): RepairResult {
  const lines = raw.split("\n");
  const trailingBlank = lines.at(-1) === "" ? 1 : 0;
  const records = trailingBlank ? lines.slice(0, -1) : lines;

  let lastGood = records.length - 1;
  while (lastGood >= 0 && !isJson(records[lastGood]!)) lastGood--;

  const truncatedLines = records.length - 1 - lastGood;
  if (truncatedLines === 0) return { repaired: raw, truncatedLines: 0 };

  // Corruption before the tail is not the known failure mode; leave it alone.
  for (let i = 0; i <= lastGood; i++) {
    if (!isJson(records[i]!)) return { repaired: raw, truncatedLines: 0 };
  }

  return { repaired: `${records.slice(0, lastGood + 1).join("\n")}\n`, truncatedLines };
}

function isJson(line: string): boolean {
  if (line.trim().length === 0) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
