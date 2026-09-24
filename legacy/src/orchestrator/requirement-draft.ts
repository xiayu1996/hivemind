import type { RequirementPagePublisher } from "./clarify-loop.js";
import type { RequirementStore } from "./requirement-store.js";

/**
 * The retry the PRD and the solution share.
 *
 * Both write an artifact a person will read, judge it by a deterministic
 * contract, and hand the refusals to the next attempt so it starts from what
 * was wrong rather than from the same blank page. Two copies of that loop meant
 * two places to change a budget that is one decision, and the budget itself was
 * a constant in each file.
 *
 * It does not save, publish or move the requirement: what an accepted draft
 * means differs between the two (a PRD always waits for a person, a solution
 * only waits when it decided something worth deciding), and that difference is
 * the thing worth keeping separate.
 */
export type DraftAttempt<T> =
  | { kind: "accepted"; value: T }
  | { kind: "unusable"; reasons: string[] };

export async function draftUntilUsable<T>(input: {
  attempts: number;
  /** Runs one attempt, told why the earlier ones were refused. */
  run(previousRejections: readonly string[]): Promise<{ kind: "accepted"; value: T } | { kind: "rejected"; reasons: readonly string[] }>;
}): Promise<DraftAttempt<T>> {
  const reasons: string[] = [];
  for (let attempt = 0; attempt < input.attempts; attempt++) {
    const result = await input.run([...reasons]);
    if (result.kind === "accepted") return { kind: "accepted", value: result.value };
    reasons.push(...result.reasons);
  }
  return { kind: "unusable", reasons };
}

/**
 * Stops the requirement on a draft its own contract kept refusing.
 *
 * A stop is a person's turn, so the page is republished with it: a requirement
 * that stopped silently is indistinguishable from one that is still working.
 */
export async function stopOnUnusableDraft(input: {
  store: RequirementStore;
  publisher: RequirementPagePublisher;
  requirementId: string;
  state: "PRD_CONFIRM" | "SOLUTION";
  what: string;
  reasons: readonly string[];
}): Promise<string> {
  const reason = `${input.what} was unusable: ${input.reasons.join("; ")}`;
  await input.store.stopForHumanInput(
    input.requirementId, input.state, `requirement:${input.requirementId}`, reason,
  );
  await input.publisher.publish(input.requirementId);
  return reason;
}

/** Every write a requirement layer run makes is attributed to the requirement,
 * not to a phase run: this layer has no phase runs of its own. */
export function requirementRunId(requirementId: string): string {
  return `requirement:${requirementId}`;
}
