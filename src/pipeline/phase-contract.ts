import { z } from "zod";
import {
  PHASE_LANE,
  PHASE_PURPOSE,
  STORY_PHASES,
  type ModelPurpose,
  type PhaseLane,
  type StoryPhase,
} from "./phase.js";

/**
 * What each phase is, declared once.
 *
 * The Story worker used to be a two-hundred-line method with the phase order,
 * the output schemas, the budget rules and the human-intervention points woven
 * into one control flow. Adding a phase meant finding nine places. The worker
 * now reads this registry: current state -> contract -> prompt -> spawn ->
 * parse -> exit -> transition, so a new phase is a row here, an exit function,
 * a transition edge and a DB CHECK.
 */

/** Artifact kinds a phase may put in the ledger. */
export const ARTIFACT_KINDS = [
  "dod",
  "open-questions",
  "assumptions",
  "design-summary",
  "declarations",
  "test-contract",
  "implementation",
  "verification",
  "delivery-report",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface PhaseArtifactOutput {
  kind: ArtifactKind;
  body: string;
}

export interface PhaseContract {
  phase: StoryPhase;
  /** Which call site pays for it; feeds `resolveAgentSpec`. */
  purpose: ModelPurpose;
  /**
   * Declared here rather than beside the runner because one declaration feeds
   * two consumers: the session file whose id becomes the provider cache key,
   * and the builder/verifier isolation the DB enforces. A new phase that
   * forgot to say which lane it is in fails to compile, instead of surfacing
   * at runtime as "VERIFY runner reused the CODE session".
   */
  lane: PhaseLane;
  produces: readonly ArtifactKind[];
  /** Turns the model's last message into ledger artifacts, or throws. */
  parse(value: unknown): PhaseArtifactOutput[];
  /**
   * `free` phases are not charged a round: their exit checks are deterministic
   * work handed back to a live session, not a verdict on the Story.
   */
  budget: "inner-loop" | "free";
  /** Whether a person may refuse this phase's output outright. */
  humanCanReject: boolean;
  /** Where a refusal sends the card. */
  rejectReturnsTo: StoryPhase | null;
  /** Whether the phase is allowed to raise questions that stop the card. */
  mayAskQuestions: boolean;
  /** Whether the phase is expected to write source into the worktree. */
  writesWorktree: boolean;
}

const dodResult = z.object({
  dod_yaml: z.string().trim().min(1),
  open_questions: z.array(z.object({
    id: z.string().trim().min(1),
    question: z.string().trim().min(1),
    suggestion: z.string().trim().min(1),
    blocking: z.boolean(),
  }).strict()).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([]),
}).strict();

const designResult = z.object({
  design_summary: z.string().trim().min(1),
  declarations: z.array(z.object({
    file: z.string().trim().min(1),
    note: z.string().trim().min(1),
  }).strict()).default([]),
}).strict();

const specifyResult = z.object({ test_contract_yaml: z.string().trim().min(1) }).strict();
const codeResult = z.object({ implementation: z.string().trim().min(1) }).strict();
const mergeResult = z.object({ delivery_report: z.string().trim().min(1) }).strict();
const verifyResult = z.object({ verification: z.string().trim().min(1) }).strict();

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const CONTRACTS: Record<StoryPhase, PhaseContract> = {
  SHAPE: {
    phase: "SHAPE",
    purpose: PHASE_PURPOSE.SHAPE,
    lane: PHASE_LANE.SHAPE,
    produces: ["dod", "open-questions", "assumptions"],
    parse(value) {
      const parsed = dodResult.parse(value);
      return [
        { kind: "dod", body: parsed.dod_yaml },
        { kind: "open-questions", body: json(parsed.open_questions) },
        { kind: "assumptions", body: json(parsed.assumptions) },
      ];
    },
    budget: "inner-loop",
    humanCanReject: true,
    rejectReturnsTo: "SHAPE",
    // The only phase with the right to ask. Every later phase reads a frozen
    // contract: a phase that could ask is a phase that can park the board, and
    // unattended delivery ends there.
    mayAskQuestions: true,
    writesWorktree: false,
  },
  DESIGN: {
    phase: "DESIGN",
    purpose: PHASE_PURPOSE.DESIGN,
    lane: PHASE_LANE.DESIGN,
    produces: ["design-summary", "declarations"],
    parse(value) {
      const parsed = designResult.parse(value);
      return [
        { kind: "design-summary", body: parsed.design_summary },
        { kind: "declarations", body: json(parsed.declarations) },
      ];
    },
    budget: "inner-loop",
    humanCanReject: true,
    rejectReturnsTo: "SHAPE",
    mayAskQuestions: false,
    // Interface declarations go into real source files so the next phase opens
    // the file rather than translating a document back into code.
    writesWorktree: true,
  },
  SPECIFY: {
    phase: "SPECIFY",
    purpose: PHASE_PURPOSE.SPECIFY,
    lane: PHASE_LANE.SPECIFY,
    produces: ["test-contract"],
    parse(value) {
      return [{ kind: "test-contract", body: specifyResult.parse(value).test_contract_yaml }];
    },
    budget: "inner-loop",
    humanCanReject: true,
    rejectReturnsTo: "SHAPE",
    mayAskQuestions: false,
    writesWorktree: true,
  },
  CODE: {
    phase: "CODE",
    purpose: PHASE_PURPOSE.CODE,
    lane: PHASE_LANE.CODE,
    produces: ["implementation"],
    parse(value) {
      return [{ kind: "implementation", body: codeResult.parse(value).implementation }];
    },
    budget: "inner-loop",
    humanCanReject: true,
    rejectReturnsTo: "SPECIFY",
    mayAskQuestions: false,
    writesWorktree: true,
  },
  VERIFY: {
    phase: "VERIFY",
    purpose: PHASE_PURPOSE.VERIFY,
    lane: PHASE_LANE.VERIFY,
    produces: ["verification"],
    parse(value) {
      return [{ kind: "verification", body: verifyResult.parse(value).verification }];
    },
    budget: "inner-loop",
    humanCanReject: false,
    rejectReturnsTo: null,
    mayAskQuestions: false,
    writesWorktree: false,
  },
  MERGE: {
    phase: "MERGE",
    purpose: PHASE_PURPOSE.MERGE,
    lane: PHASE_LANE.MERGE,
    produces: ["delivery-report"],
    parse(value) {
      return [{ kind: "delivery-report", body: mergeResult.parse(value).delivery_report }];
    },
    budget: "free",
    humanCanReject: false,
    rejectReturnsTo: null,
    mayAskQuestions: false,
    writesWorktree: false,
  },
  REGRESSION_FIX: {
    phase: "REGRESSION_FIX",
    purpose: PHASE_PURPOSE.REGRESSION_FIX,
    lane: PHASE_LANE.REGRESSION_FIX,
    produces: ["implementation"],
    parse(value) {
      return [{ kind: "implementation", body: codeResult.parse(value).implementation }];
    },
    budget: "inner-loop",
    humanCanReject: true,
    rejectReturnsTo: "SPECIFY",
    mayAskQuestions: false,
    writesWorktree: true,
  },
};

export function phaseContract(phase: StoryPhase): PhaseContract {
  return CONTRACTS[phase];
}

export const PHASE_CONTRACTS: readonly PhaseContract[] = STORY_PHASES.map((phase) => CONTRACTS[phase]);

/** Phases that write source and therefore need write tools and a tree-pin. */
export function writesWorktree(phase: StoryPhase): boolean {
  return CONTRACTS[phase].writesWorktree;
}
