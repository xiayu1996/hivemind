import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotionMediaPipeline, type NotionMediaPort } from "./media.js";

const tempDirs: string[] = [];

function evidenceFile(): string {
  const root = mkdtempSync(join(tmpdir(), "hivemind-media-"));
  tempDirs.push(root);
  const path = join(root, "shot.png");
  writeFileSync(path, Buffer.from([1, 2, 3]));
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("NotionMediaPipeline", () => {
  it("returns immediately and later attaches a successful upload", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const attached: string[] = [];
    const port: NotionMediaPort = {
      upload: async () => { await gate; return { uploadId: "upload-1" }; },
      attach: async (_target, uploadId) => { attached.push(uploadId); },
      attachPlaceholder: async () => undefined,
    };
    const pipeline = new NotionMediaPipeline(port);
    const queued = pipeline.enqueue({
      evidenceId: "ev-1", path: evidenceFile(), targetBlockId: "block-1", caption: "Checkout",
    });
    expect(queued.placeholder.kind).toBe("placeholder");
    expect(queued.placeholder).toMatchObject({ attached: false });
    expect(attached).toEqual([]);
    release();
    await expect(queued.completion).resolves.toEqual({ kind: "image", uploadId: "upload-1" });
    expect(attached).toEqual(["upload-1"]);
  });

  it("resolves upload failures to a text placeholder instead of rejecting the main flow", async () => {
    const placeholders: string[] = [];
    const pipeline = new NotionMediaPipeline({
      upload: async () => { throw new Error("Notion unavailable"); },
      attach: async () => { throw new Error("must not attach"); },
      attachPlaceholder: async (_target, text) => { placeholders.push(text); },
    });
    const queued = pipeline.enqueue({
      evidenceId: "ev-2", path: evidenceFile(), targetBlockId: "block-1", caption: "Checkout",
    });
    await expect(queued.completion).resolves.toEqual({
      kind: "placeholder",
      text: "Image unavailable; see evidence ev-2",
      attached: true,
      reason: "Notion unavailable",
    });
    expect(placeholders).toEqual(["Image unavailable; see evidence ev-2"]);
  });
});
