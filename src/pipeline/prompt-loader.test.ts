import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptLoadError, loadPmPromptLayers, loadPromptLayers } from "./prompt-loader.js";
import type { PmPhase } from "./prompt-loader.js";
import type { Phase } from "./phase-input.js";

const tempDirs: string[] = [];
const PROMPTS = join(process.cwd(), "prompts");
const PHASES: Phase[] = ["DECOMPOSE", "DESIGN", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX"];
const PM_PHASES: PmPhase[] = ["CLARIFY", "PRD", "REQUIREMENT_DECOMPOSE"];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("loadPromptLayers", () => {
  it("loads the shared baseline before the phase layer", async () => {
    const layers = await loadPromptLayers(PROMPTS, "VERIFY");
    expect(layers.baseline.startsWith("# ")).toBe(true);
    expect(layers.phase.startsWith("# VERIFY\n")).toBe(true);
    expect(layers.combined.indexOf(layers.baseline.trim())).toBeLessThan(
      layers.combined.indexOf(layers.phase.trim()),
    );
    expect(layers.combined.endsWith("\n")).toBe(true);
    expect(layers.combined.endsWith("\n\n")).toBe(false);
  });

  it("has an independent phase asset for every M1 phase", async () => {
    for (const phase of PHASES) {
      const layers = await loadPromptLayers(PROMPTS, phase);
      expect(layers.phase.length, phase).toBeGreaterThan(100);
    }
  });

  it("does not prescribe repository-specific verification commands", async () => {
    for (const phase of PHASES) {
      const { combined } = await loadPromptLayers(PROMPTS, phase);
      expect(combined, phase).not.toMatch(/(?:npm|pnpm|yarn|mvn|gradle|pytest|cargo)\s+(?:run\s+)?test/i);
    }
  });

  it("keeps the product manager on its own baseline, not the delivery one", async () => {
    const delivery = await loadPromptLayers(PROMPTS, "CODE");
    for (const phase of PM_PHASES) {
      const layers = await loadPmPromptLayers(PROMPTS, phase);
      expect(layers.phase.length, phase).toBeGreaterThan(100);
      expect(layers.baseline, phase).not.toBe(delivery.baseline);
      expect(layers.combined, phase).not.toMatch(/(?:npm|pnpm|yarn|mvn|gradle|pytest|cargo)\s+(?:run\s+)?test/i);
    }
  });

  it("names a missing asset instead of silently dropping a layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-prompts-"));
    tempDirs.push(root);
    writeFileSync(join(root, "baseline.md"), "baseline\n", "utf8");
    await expect(loadPromptLayers(root, "CODE")).rejects.toThrow(PromptLoadError);
    await expect(loadPromptLayers(root, "CODE")).rejects.toThrow(/code\.md/);
  });
});
