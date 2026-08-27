import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, repairJsonl } from "./checkpoint.js";

let dir: string;
let sessions: string;
let clock = 1_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hm-ckpt-"));
  sessions = await mkdtemp(join(tmpdir(), "hm-sess-"));
  clock = 1_000;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(sessions, { recursive: true, force: true });
});

const store = (keep?: number) =>
  new CheckpointStore(keep === undefined
    ? { dir, now: () => clock++ }
    : { dir, keep, now: () => clock++ });

const record = (i: number) => JSON.stringify({ type: "message", i });

async function session(lines: string[], name = "s.jsonl"): Promise<string> {
  const file = join(sessions, name);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

describe("repairJsonl", () => {
  it("leaves an intact file untouched", () => {
    const raw = `${record(1)}\n${record(2)}\n`;
    expect(repairJsonl(raw)).toEqual({ repaired: raw, truncatedLines: 0 });
  });

  it("truncates a torn trailing record", () => {
    const raw = `${record(1)}\n${record(2)}\n{"type":"mess`;
    const { repaired, truncatedLines } = repairJsonl(raw);
    expect(truncatedLines).toBe(1);
    expect(repaired).toBe(`${record(1)}\n${record(2)}\n`);
  });

  it("truncates several torn trailing records", () => {
    const raw = `${record(1)}\n{"a\n{"b`;
    expect(repairJsonl(raw).truncatedLines).toBe(2);
  });

  it("refuses to repair corruption in the middle, since that is a different fault", () => {
    const raw = `${record(1)}\nNOT JSON\n${record(3)}\n`;
    expect(repairJsonl(raw)).toEqual({ repaired: raw, truncatedLines: 0 });
  });

  it("handles an empty file", () => {
    expect(repairJsonl("")).toEqual({ repaired: "", truncatedLines: 0 });
  });
});

describe("capture", () => {
  it("stores the session file itself, because RPC cannot load a message array back", async () => {
    const file = await session([record(1), record(2)]);
    const checkpoint = await store().capture("run-1", 1, file);

    expect(await readFile(checkpoint.file, "utf8")).toBe(await readFile(file, "utf8"));
    expect(checkpoint.bytes).toBeGreaterThan(0);
    expect(checkpoint.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("repairs a torn tail while capturing and reports what it dropped", async () => {
    const file = join(sessions, "torn.jsonl");
    await writeFile(file, `${record(1)}\n${record(2)}\n{"torn`, "utf8");

    const checkpoint = await store().capture("run-1", 1, file);
    expect(checkpoint.truncatedLines).toBe(1);

    const content = await readFile(checkpoint.file, "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("leaves no temporary file behind", async () => {
    const file = await session([record(1)]);
    const checkpoint = await store().capture("run-1", 1, file);
    await expect(readFile(`${checkpoint.file}.tmp`, "utf8")).rejects.toThrow();
  });
});

describe("recovery", () => {
  it("returns the newest checkpoint", async () => {
    const file = await session([record(1)]);
    const s = store();
    await s.capture("run-1", 1, file);
    await s.capture("run-1", 2, file);

    expect((await s.latestIntact("run-1"))!.seq).toBe(2);
  });

  it("falls back to an older checkpoint when the newest was altered", async () => {
    const file = await session([record(1)]);
    const s = store();
    await s.capture("run-1", 1, file);
    const newest = await s.capture("run-1", 2, file);

    await writeFile(newest.file, `${record(99)}\n`, "utf8");

    const recovered = await s.latestIntact("run-1");
    expect(recovered!.seq).toBe(1);
  });

  it("returns null when every checkpoint is unusable", async () => {
    const file = await session([record(1)]);
    const s = store();
    const only = await s.capture("run-1", 1, file);
    await rm(only.file);
    expect(await s.latestIntact("run-1")).toBeNull();
  });

  it("returns null for a run with no checkpoints", async () => {
    expect(await store().latestIntact("never-ran")).toBeNull();
  });

  it("keeps runs isolated from each other", async () => {
    const file = await session([record(1)]);
    const s = store();
    await s.capture("run-a", 1, file);
    await s.capture("run-b", 7, file);

    expect((await s.latestIntact("run-a"))!.seq).toBe(1);
    expect((await s.latestIntact("run-b"))!.seq).toBe(7);
  });
});

describe("retention", () => {
  it("keeps only the configured number of checkpoints per run", async () => {
    const file = await session([record(1)]);
    const s = store(2);
    for (let seq = 1; seq <= 5; seq++) await s.capture("run-1", seq, file);

    const kept = await s.list("run-1");
    expect(kept.map((c) => c.seq)).toEqual([5, 4]);
  });
});
