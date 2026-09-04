import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Phase } from "./phase-input.js";

const PHASE_FILES: Record<Phase, string> = {
  DECOMPOSE: "decompose.md",
  DESIGN: "design.md",
  CODE: "code.md",
  VERIFY: "verify.md",
  MERGE: "merge.md",
  REGRESSION_FIX: "regression-fix.md",
};

/** The product manager's phases run above the Epic pipeline and share none of
 * its phase prompts, so they carry their own layer pair. */
export type PmPhase = "CLARIFY" | "PRD" | "REQUIREMENT_DECOMPOSE";

const PM_FILES: Record<PmPhase, string> = {
  CLARIFY: "clarify.md",
  PRD: "prd.md",
  REQUIREMENT_DECOMPOSE: "decompose.md",
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
