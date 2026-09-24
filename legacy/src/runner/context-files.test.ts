import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFileError, loadExplicitContextBundle } from "./context-files.js";

const tempDirs: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "hivemind-context-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("loadExplicitContextBundle", () => {
  it("preserves declared precedence and records the exact effective files", async () => {
    const root = workspace();
    const global = join(root, "global.md");
    const repository = join(root, "AGENTS.md");
    writeFileSync(global, "global rule\n", "utf8");
    writeFileSync(repository, "repository rule\n", "utf8");

    const bundle = await loadExplicitContextBundle([
      { label: "hivemind-global", path: global },
      { label: "repository-AGENTS.md", path: repository },
    ]);
    expect(bundle.text.indexOf("global rule")).toBeLessThan(bundle.text.indexOf("repository rule"));
    expect(bundle.files.map((file) => file.label)).toEqual(["hivemind-global", "repository-AGENTS.md"]);
    expect(bundle.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  it("keeps model-visible text stable when host paths differ", async () => {
    const first = workspace();
    const second = workspace();
    const a = join(first, "AGENTS.md");
    const b = join(second, "AGENTS.md");
    writeFileSync(a, "same rules\n", "utf8");
    writeFileSync(b, "same rules\n", "utf8");
    const left = await loadExplicitContextBundle([{ label: "repository", path: a }]);
    const right = await loadExplicitContextBundle([{ label: "repository", path: b }]);
    expect(left.text).toBe(right.text);
  });

  it("rejects duplicate labels and missing files", async () => {
    const root = workspace();
    const file = join(root, "one.md");
    writeFileSync(file, "one\n", "utf8");
    await expect(loadExplicitContextBundle([
      { label: "same", path: file },
      { label: "same", path: file },
    ])).rejects.toThrow(ContextFileError);
    await expect(loadExplicitContextBundle([
      { label: "missing", path: join(root, "missing.md") },
    ])).rejects.toThrow(/missing\.md/);
  });
});
