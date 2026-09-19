import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { finishLaneCapture, laneCapturePath } from "./lane-capture.js";
import { PACKED_SUFFIX, readPackedText } from "./packed-file.js";

describe("a lane capture", () => {
  it("gives two invocations of one lane two files under the same evidence root", () => {
    const first = laneCapturePath("/evidence/epic-A", "sweep", Date.parse("2026-09-19T05:34:00Z"));
    const second = laneCapturePath("/evidence/epic-A", "sweep", Date.parse("2026-09-19T22:48:00Z"));
    expect(first).not.toEqual(second);
    expect(dirname(first)).toEqual(dirname(second));
    // No colons: the name has to survive a filesystem that forbids them.
    expect(first).not.toContain(":");
  });

  it("packs what the lane sent and still reads it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "hm-lane-"));
    const path = laneCapturePath(root, "sweep", Date.parse("2026-09-19T05:34:00Z"));
    await mkdir(dirname(path), { recursive: true });
    const written = `${JSON.stringify({ messages: ["x".repeat(2_048)] })}\n`;
    await writeFile(path, written, "utf8");

    await finishLaneCapture(path);

    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readPackedText(path)).toEqual(written);
    expect(await readFile(`${path}${PACKED_SUFFIX}`)).toBeTruthy();
  });

  it("accepts a lane that sent nothing and so wrote no file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hm-lane-silent-"));
    await expect(finishLaneCapture(laneCapturePath(root, "sweep", 0))).resolves.toBeUndefined();
  });
});
