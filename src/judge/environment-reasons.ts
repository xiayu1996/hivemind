import { isEnvironmentFailure } from "../pipeline/failure-classification.js";
import { JudgeError, type NoulQuestion, type SystemOne } from "./system-one.js";

/**
 * Which rejection reasons are about the box rather than the code, for the ones
 * the pattern table in `failure-classification.ts` did not recognise.
 *
 * That table is the floor and stays the floor: a reason it matches is never
 * asked about, so every split it decides today it still decides. The judge is
 * asked only about what fell through, and only a confident yes moves a reason
 * across. The asymmetry is the whole design -- the two mistakes do not cost the
 * same. Reading a real defect as the environment means the round is not counted
 * and the card never converges; reading an environment failure as the code
 * costs one round, which is what happens today every time the table misses.
 *
 * The table has been extended by hand five times, each time after a real card
 * was stopped by a miss (see the case numbers in its comments). It judges a
 * sentence written in prose by a model, not a format a machine emits, which is
 * why it cannot be finished by adding one more pattern.
 */

/** Written for the model, so it is written in English and spells out the
 * boundary cases: it answers the words it is given rather than the intent. */
const CRITERIA = {
  true: "The reason is about the machine the check ran on: a server or port that was not listening, a connection refused, reset or timed out, a DNS or TLS failure, a browser that would not launch, a missing tool or dependency, a 5xx raised by scaffolding the checker itself started, a page or route served by a build other than the one under test, or evidence the checker failed to leave for itself.",
  false: "The reason is about the code being checked: an assertion that did not hold, an element or text missing from a page the code renders, wrong data, wrong wording, wrong behaviour, or a test that failed on its own terms.",
} as const;

/** Long enough for the sentence and its tail, short enough that a stack trace
 * pasted into a reason cannot dominate the question it belongs to. */
const MAX_REASON_CHARS = 1200;

/** A ceiling on how many requests one round may open at once. A round with more
 * distinct unmatched reasons than this keeps the floor's answer for the rest,
 * which is the safe direction. */
const MAX_REASONS_PER_ROUND = 16;

export interface EnvironmentJudgementOptions {
  model: string;
  /** How sure the judge has to be before a reason moves off the floor. */
  threshold: number;
}

export interface EnvironmentJudgement {
  /** Reason strings to hand to `splitScenarioFailures` as also environmental. */
  environmental: ReadonlySet<string>;
  /** What moved and how sure the judge was, for the friction record. */
  moved: readonly { reason: string; probability: number }[];
  /** Reasons that went unasked because the round was already at its ceiling. */
  skipped: number;
  /** Why the judge said nothing about the reasons it said nothing about. Never
   * thrown: one failed question leaves the others standing. */
  error?: string;
}

/**
 * What a call site needs to ask the question. `judge` is optional at every one
 * of them on purpose: leaving it out is how a deployment without the credential
 * keeps the pattern table as its whole answer.
 */
export interface EnvironmentJudgeSettings {
  judge?: SystemOne;
  model: string;
  threshold: number;
  /** Called with every judgement, including the ones that moved nothing, so
   * the value of asking can be read off the friction record rather than guessed. */
  onJudged?: (judgement: EnvironmentJudgement) => Promise<void> | void;
}

const NOTHING: EnvironmentJudgement = { environmental: new Set(), moved: [], skipped: 0 };

/** The single question id every request uses; there is one question per request. */
export const QUESTION_ID = "is_environment";

/** Deduplicated and sorted so the same round asks the same questions: a reason
 * repeated across five scenarios is one question, and two runs of one round
 * produce the same requests in the same order. */
export function unmatchedReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter((reason) => !isEnvironmentFailure(reason)))].toSorted();
}

export function environmentQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "The text at `reason` is why one verification scenario was rejected. Does it describe the machine the check ran on, rather than a defect in the code being checked?",
    criteria: CRITERIA,
  };
}

/**
 * One reason per request, on purpose, even though the API would take them all
 * at once.
 *
 * Measured 2026-09-18: asked together, one reason's answer moves with what else
 * is in the batch. The same refusal about a stand-in service scored 0.59 beside
 * two code failures, 0.81 beside five, and 0.88 when four other environment
 * failures were in the same call -- a 0.29 spread, against a run-to-run spread
 * of 0.02 on a fixed batch. The judge's own documentation says as much: answers
 * to separate questions carry no structural invariant between them, and
 * unrelated context reads as a distractor.
 *
 * Batching would therefore make one reason's verdict depend on which other
 * scenarios happened to fail in the same round, which is both unjustifiable and
 * invisible. One question per request makes the answer a function of the reason
 * alone. It costs one request per distinct reason; they go out together, fifteen
 * took 2.2 seconds, and the tokens are a rounding error against the round that
 * produced them.
 */
export async function judgeEnvironmentReasons(
  judge: SystemOne | undefined,
  reasons: readonly string[],
  options: EnvironmentJudgementOptions,
): Promise<EnvironmentJudgement> {
  if (!judge) return NOTHING;
  const candidates = unmatchedReasons(reasons);
  if (candidates.length === 0) return NOTHING;
  const asked = candidates.slice(0, MAX_REASONS_PER_ROUND);
  const skipped = candidates.length - asked.length;

  const answers = await Promise.all(asked.map(async (reason) => {
    try {
      const response = await judge.ask({
        model: options.model,
        state: { reason: reason.slice(0, MAX_REASON_CHARS) },
        questions: { [QUESTION_ID]: environmentQuestion() },
      });
      return { reason, probability: response.answers[QUESTION_ID]?.noul };
    } catch (error) {
      const message = error instanceof JudgeError ? `${error.kind}: ${error.message}` : (error as Error).message;
      return { reason, failure: message };
    }
  }));

  const environmental = new Set<string>();
  const moved: { reason: string; probability: number }[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if ("failure" in answer && answer.failure !== undefined) {
      failures.push(answer.failure);
      continue;
    }
    const probability = "probability" in answer ? answer.probability : undefined;
    if (probability === undefined || probability < options.threshold) continue;
    environmental.add(answer.reason);
    moved.push({ reason: answer.reason, probability });
  }
  const unanswered = failures.length;
  return {
    environmental,
    moved,
    skipped: skipped + unanswered,
    ...(unanswered > 0 ? { error: `${unanswered} of ${asked.length} unanswered: ${[...new Set(failures)].join("; ")}` } : {}),
  };
}

/** One line for the friction record: what moved, and how sure the judge was.
 * Reasons are truncated because this is read on a card page, not in a log. */
export function renderMovedReasons(moved: readonly { reason: string; probability: number }[]): string {
  return moved
    .map(({ reason, probability }) => `${probability.toFixed(2)} ${reason.slice(0, 160)}`)
    .join("; ");
}
