import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Phase } from "./phase-input.js";
import type { PmPhase } from "./phase.js";

export type { PmPhase };

const PHASE_FILES: Record<Phase, string> = {
  DECOMPOSE: "decompose.md",
  SHAPE: "shape.md",
  DESIGN: "design.md",
  SPECIFY: "specify.md",
  CODE: "code.md",
  VERIFY: "verify.md",
  MERGE: "merge.md",
  REGRESSION_FIX: "regression-fix.md",
};

const PM_FILES: Record<PmPhase, string> = {
  CLARIFY: "clarify.md",
  PRD: "prd.md",
  SOLUTION: "solution.md",
  REQUIREMENT_DECOMPOSE: "decompose.md",
  // The UI acceptance lane is a product manager reading a delivered screen, so
  // it inherits the PM baseline (business language, no implementation talk)
  // rather than the engineering phases' one. It is not a state-machine phase:
  // it runs inside VERIFY and has no state of its own.
  UI_REVIEW: "ui-review.md",
};

export interface PromptLayers {
  baseline: string;
  phase: string;
  combined: string;
}

export class PromptLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptLoadError";
  }
}

async function loadFile(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") throw new Error("file is empty");
    return text;
  } catch (cause) {
    throw new PromptLoadError(`cannot load prompt asset ${path}: ${(cause as Error).message}`, { cause });
  }
}

/** Loads the shared discipline first, then the role-specific phase contract. */
export async function loadPromptLayers(promptRoot: string, phase: Phase): Promise<PromptLayers> {
  const [baseline, phaseText] = await Promise.all([
    loadFile(join(promptRoot, "baseline.md")),
    loadFile(join(promptRoot, "phases", PHASE_FILES[phase])),
  ]);
  const combined = `${baseline.trim()}\n\n${phaseText.trim()}\n`;
  return { baseline, phase: phaseText, combined };
}

/** Loads the product manager's own discipline, then the phase contract. */
export async function loadPmPromptLayers(promptRoot: string, phase: PmPhase): Promise<PromptLayers> {
  const [baseline, phaseText] = await Promise.all([
    loadFile(join(promptRoot, "pm", "baseline.md")),
    loadFile(join(promptRoot, "pm", PM_FILES[phase])),
  ]);
  const combined = `${baseline.trim()}\n\n${phaseText.trim()}\n`;
  return { baseline, phase: phaseText, combined };
}
