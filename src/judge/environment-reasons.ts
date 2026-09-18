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
 * pasted into a reason cannot crowd out the other reasons in the same call. */
const MAX_REASON_CHARS = 1200;

/** One call, one round trip. A round with more distinct unmatched reasons than
 * this keeps the floor's answer for the rest, which is the safe direction. */
const MAX_REASONS_PER_CALL = 16;

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
  /** Reasons that went unasked because the call was already full. */
  skipped: number;
  /** Why the judge said nothing, when it said nothing. Never thrown. */
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

function questionId(index: number): string {
  return `reason_${index}`;
}

/** Deduplicated and sorted so the same round produces the same request: the
 * provider's cache is keyed on the bytes, and so is anyone reading two runs
 * side by side. */
export function unmatchedReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter((reason) => !isEnvironmentFailure(reason)))].toSorted();
}

export function environmentQuestions(reasons: readonly string[]): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  for (const [index] of reasons.entries()) {
    questions[questionId(index)] = {
      type: "noul",
      instructions:
        `The text at \`reasons[${index}]\` is the reason one verification scenario was rejected. Does it describe the machine the check ran on, rather than a defect in the code being checked?`,
      criteria: CRITERIA,
    };
  }
  return questions;
}

/**
 * Never throws and never returns the floor's own answers. A judge that is
 * missing, slow, broken or unsure costs the caller its opinion and nothing
 * else, which is why `judge` is allowed to be undefined at every call site.
 */
export async function judgeEnvironmentReasons(
  judge: SystemOne | undefined,
  reasons: readonly string[],
  options: EnvironmentJudgementOptions,
): Promise<EnvironmentJudgement> {
  if (!judge) return NOTHING;
  const candidates = unmatchedReasons(reasons);
  if (candidates.length === 0) return NOTHING;
  const asked = candidates.slice(0, MAX_REASONS_PER_CALL);
  const skipped = candidates.length - asked.length;

  let answers;
  try {
    ({ answers } = await judge.ask({
      model: options.model,
      state: { reasons: asked.map((reason) => reason.slice(0, MAX_REASON_CHARS)) },
      questions: environmentQuestions(asked),
    }));
  } catch (error) {
    const message = error instanceof JudgeError ? `${error.kind}: ${error.message}` : (error as Error).message;
    return { ...NOTHING, skipped: candidates.length, error: message };
  }

  const environmental = new Set<string>();
  const moved: { reason: string; probability: number }[] = [];
  for (const [index, reason] of asked.entries()) {
    const probability = answers[questionId(index)]?.noul;
    if (probability === undefined || probability < options.threshold) continue;
    environmental.add(reason);
    moved.push({ reason, probability });
  }
  return { environmental, moved, skipped };
}

/** One line for the friction record: what moved, and how sure the judge was.
 * Reasons are truncated because this is read on a card page, not in a log. */
export function renderMovedReasons(moved: readonly { reason: string; probability: number }[]): string {
  return moved
    .map(({ reason, probability }) => `${probability.toFixed(2)} ${reason.slice(0, 160)}`)
    .join("; ");
}
