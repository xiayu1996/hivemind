/**
 * The single declaration of every phase an agent can be spawned under, and of
 * every call site that spends tokens.
 *
 * This module imports nothing on purpose. It used to be five enumerations that
 * only a person kept aligned -- the pipeline's `Phase`, the guard's own list,
 * the Story state machine's, the product manager's, and the model purposes --
 * so adding a phase meant finding nine places and missing one was silent.
 * Everything downstream now derives from the constants here, and the mappings
 * below are total records: a new member that nobody classified fails to
 * compile rather than falling back to a default nobody chose.
 */

/** Phases of the Story pipeline, in the order the transition table allows. */
export const STORY_PHASES = [
  "SHAPE",
  "DESIGN",
  "SPECIFY",
  "CODE",
  "VERIFY",
  "MERGE",
  "REGRESSION_FIX",
] as const;
export type StoryPhase = (typeof STORY_PHASES)[number];

/** Story phases plus the Epic-level decomposition that produces them. */
export const PIPELINE_PHASES = [...STORY_PHASES, "DECOMPOSE"] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

/** The product manager's phases. They run above the Epic pipeline, share none
 * of its phase prompts, and have no state of their own in the Story machine. */
export const PM_PHASES = ["CLARIFY", "PRD", "SOLUTION", "REQUIREMENT_DECOMPOSE", "UI_REVIEW"] as const;
export type PmPhase = (typeof PM_PHASES)[number];

/** Spawn contexts that are not phases of either machine but still need a guard
 * profile: the browser leg of verification, and the two post-delivery readers. */
export const AUXILIARY_PHASES = ["E2E", "DISTILL", "REPORT"] as const;

export const AGENT_PHASES = [...PIPELINE_PHASES, ...PM_PHASES, ...AUXILIARY_PHASES] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

/**
 * Which lane a phase belongs to. The builder and the verifier must never share
 * a session -- the DB enforces it with a CHECK and the verify executor checks
 * it again at runtime -- so the split is declared once, here, and consumed by
 * both the session-file naming that feeds the provider cache key and the
 * blind-verification isolation.
 */
export type PhaseLane = "build" | "verify";

const STORY_PHASE_SET: ReadonlySet<string> = new Set(STORY_PHASES);
const PM_PHASE_SET: ReadonlySet<string> = new Set(PM_PHASES);

export function isStoryPhase(value: string): value is StoryPhase {
  return STORY_PHASE_SET.has(value);
}

export function isPmPhase(value: string): value is PmPhase {
  return PM_PHASE_SET.has(value);
}

/** Every call site that spends tokens. A new one must be declared here and
 * given a tier in config; there is no default tier for an unknown purpose. */
export const MODEL_PURPOSES = [
  "product_manager",
  "decompose",
  "shape",
  "design",
  "specify",
  "code",
  "verify",
  "ui_review",
  "merge",
  "capacity_probe",
  "triage",
  "distiller",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const MODEL_TIERS = ["brain", "standard", "cheap"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Which purpose pays for each phase. Total by construction: a phase added
 * above without a purpose here is a compile error, which is the whole point of
 * collapsing the enumerations.
 */
export const PHASE_PURPOSE: Record<AgentPhase, ModelPurpose> = {
  SHAPE: "shape",
  DESIGN: "design",
  SPECIFY: "specify",
  CODE: "code",
  VERIFY: "verify",
  MERGE: "merge",
  REGRESSION_FIX: "code",
  DECOMPOSE: "decompose",
  CLARIFY: "product_manager",
  PRD: "product_manager",
  // The solution reads the repository and weighs what to build it with, which
  // is the decomposition tier's job, not the conversational one's.
  SOLUTION: "decompose",
  REQUIREMENT_DECOMPOSE: "decompose",
  UI_REVIEW: "ui_review",
  E2E: "verify",
  DISTILL: "distiller",
  REPORT: "merge",
};

/**
 * Which lane each phase runs in. REGRESSION_FIX builds, so it shares the
 * builder lane; the screen review reads a delivered build the same way blind
 * verification does, so it shares the verifier's.
 */
export const PHASE_LANE: Record<AgentPhase, PhaseLane> = {
  SHAPE: "build",
  DESIGN: "build",
  SPECIFY: "build",
  CODE: "build",
  VERIFY: "verify",
  MERGE: "build",
  REGRESSION_FIX: "build",
  DECOMPOSE: "build",
  CLARIFY: "build",
  PRD: "build",
  SOLUTION: "build",
  REQUIREMENT_DECOMPOSE: "build",
  UI_REVIEW: "verify",
  E2E: "verify",
  DISTILL: "build",
  REPORT: "build",
};
