import type { Waiting } from "../store/store.ts";

/** What one call of a step asks the requirement driver to do next. */
export type StepOutcome =
  /** The step is complete: move on to the next applicable step. */
  | { kind: "next" }
  /** Progress was made but the step is not complete: call it again. */
  | { kind: "again" }
  /** Continue at another step of the recipe (a review sending work back to the build). */
  | { kind: "goto"; stepId: string }
  /** Nothing more can happen until a person answers or a model is usable again. */
  | { kind: "wait"; waiting: Waiting; note: string }
  | { kind: "stop"; reason: "no_progress" | "budget"; detail: string }
  /** Delivered. */
  | { kind: "done"; report: string; link: string };
