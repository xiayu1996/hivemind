import { JudgeError, type NoulQuestion, type SystemOne } from "./system-one.js";

/**
 * Whether a Story is a step the team takes rather than a thing a person does,
 * for the Stories the deterministic checks in `decompose.ts` already let
 * through.
 *
 * Those checks are the floor and stay the floor. They refuse a Story whose
 * `userEntryPoint` or `verificationPath` is blank, and refuse a plan whose
 * Stories share an entry point or declare one identical footprint. What they
 * cannot see is a sentence that is present and says nothing: "the data layer
 * for the report" is a non-empty entry point and a distinct one, so six Stories
 * that each build one tier of the same screen pass every check and none of them
 * can be verified or delivered on its own.
 *
 * The question is asked so that a confident *yes* is the refusal, not a low
 * score. A judge with no opinion sits near 0.5, and a criterion that refused on
 * a low number would turn every shrug into a blocked Epic. Here indifference
 * leaves the floor's answer standing, which is today's behaviour.
 *
 * **The wording below was arrived at by measurement, and two earlier ones were
 * discarded** (2026-09-18). Asking "does it finish only part of something" put
 * a page skeleton at 0.22 -- lower than several real slices -- because a
 * skeleton genuinely is a page someone can open. Asking "would a person still
 * have nothing they could use" moved the same Stories by up to 0.54 against
 * 0.03 of run-to-run noise, and still did not separate. Only the pivot below
 * separates: not what the Story touches, but **who would have named it**. A
 * customer names the things they do; the team names the steps it takes. Over
 * fifteen wordings run twice, steps scored 0.54 to 0.91 and things a person
 * does 0.07 to 0.15, including the two that are easiest to get wrong -- signing
 * in with a company account, and a product whose own customers are developers.
 *
 * The bar is high for the reason it is high on the decomposition language
 * question: `EpicDecomposer` has two attempts, so the same invented refusal
 * twice blocks the Epic and costs a person, while a refusal the judge misses
 * costs what happens today.
 */

const CRITERIA = {
  true: "The Story is something the team needs to build before the thing a customer asked for can exist: a place to keep data, a way for one part of the system to call another, a control or standard several screens will share, a layout with nothing working in it yet. A customer would not have named it, because it is not a thing they do -- it is a step the team takes.",
  false: "The Story is a thing a customer does with the product, written down. They could have named it themselves, and they would notice if it were missing. It counts however small or plain it is, and it counts when it is a rule or a limit they experience.",
} as const;

/** Enough for a Story and its scenarios, short enough that a long plan pasted
 * into one field cannot bury the fields that decide the answer. */
const MAX_FIELD_CHARS = 800;

/** A ceiling on how many Stories one plan may ask about at once. Beyond it the
 * floor's answer stands, which is the safe direction. */
const MAX_STORIES_PER_PLAN = 16;

export const QUESTION_ID = "is_partial_slice";

/** The Story as the question sees it: only the fields a person would read. */
export interface JudgedStory {
  id: string;
  title: string;
  requirement: string;
  userEntryPoint: string;
  verificationPath: string;
  scenarios: readonly { given: string; when: string; then: string }[];
}

export interface VerticalSliceOptions {
  model: string;
  /** How sure the judge has to be before a Story is refused. */
  threshold: number;
}

export interface VerticalSliceJudgement {
  /** One reason per refused Story, to add to the ones the checks produced. */
  reasons: readonly string[];
  /** What was refused and how sure the judge was, for the friction record. */
  moved: readonly { storyId: string; probability: number }[];
  /** Stories that went unasked because the plan was already at its ceiling. */
  skipped: number;
  /** Why the judge said nothing about the Stories it said nothing about. Never
   * thrown: one failed question leaves the others standing. */
  error?: string;
}

export interface VerticalSliceJudgeSettings {
  judge?: SystemOne;
  model: string;
  threshold: number;
}

const NOTHING: VerticalSliceJudgement = { reasons: [], moved: [], skipped: 0 };

export function verticalSliceQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "`story` is one Story from a plan that splits a piece of work. Is it a step the team takes toward what a customer asked for, rather than a thing the customer does with the product?",
    criteria: CRITERIA,
  };
}

/** The fields the question sees, trimmed and truncated, so two runs of one plan
 * send the same bytes. */
function stateOf(story: JudgedStory): unknown {
  const clip = (text: string): string => text.trim().slice(0, MAX_FIELD_CHARS);
  return {
    story: {
      title: clip(story.title),
      requirement: clip(story.requirement),
      userEntryPoint: clip(story.userEntryPoint),
      verificationPath: clip(story.verificationPath),
      scenarios: story.scenarios.map((scenario) => ({
        given: clip(scenario.given),
        when: clip(scenario.when),
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
        then: clip(scenario.then),
      })),
    },
  };
}

/**
 * One Story per request, for the reason measured on the environment question
 * (2026-09-18): asked together, one answer moves with what else is in the batch
 * by an order of magnitude more than it moves between runs. Here batching would
 * be worse than elsewhere -- every Story in a plan is about the same feature,
 * so the siblings read as exactly the distractor the judge's own documentation
 * warns about, and a thin slice beside five thinner ones would score
 * differently from the same slice beside five fat ones.
 *
 * Never throws. A judge that is missing, slow or unsure adds nothing.
 */
export async function judgeVerticalSlices(
  judge: SystemOne | undefined,
  stories: readonly JudgedStory[],
  options: VerticalSliceOptions,
): Promise<VerticalSliceJudgement> {
  if (!judge) return NOTHING;
  const asked = [...stories].toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, MAX_STORIES_PER_PLAN);
  if (asked.length === 0) return NOTHING;
  const skipped = stories.length - asked.length;

  const answers = await Promise.all(asked.map(async (story) => {
    try {
      const response = await judge.ask({
        model: options.model,
        state: stateOf(story),
        questions: { [QUESTION_ID]: verticalSliceQuestion() },
      });
      return { story, probability: response.answers[QUESTION_ID]?.noul };
    } catch (error) {
      const message = error instanceof JudgeError ? `${error.kind}: ${error.message}` : (error as Error).message;
      return { story, failure: message };
    }
  }));

  const reasons: string[] = [];
  const moved: { storyId: string; probability: number }[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if ("failure" in answer && answer.failure !== undefined) {
      failures.push(answer.failure);
      continue;
    }
    const probability = "probability" in answer ? answer.probability : undefined;
    if (probability === undefined || probability < options.threshold) continue;
    reasons.push(`Story ${answer.story.id} finishes one layer rather than a slice a person can use: nothing can be opened at "${answer.story.userEntryPoint.trim()}" until a sibling Story lands. Re-split the Epic so each Story reaches a person on its own.`);
    moved.push({ storyId: answer.story.id, probability });
  }
  const unanswered = failures.length;
  return {
    reasons,
    moved,
    skipped: skipped + unanswered,
    ...(unanswered > 0 ? { error: `${unanswered} of ${asked.length} unanswered: ${[...new Set(failures)].join("; ")}` } : {}),
  };
}

/** One line for the friction record: which Stories were refused, and how sure
 * the judge was. */
export function renderRefusedSlices(moved: readonly { storyId: string; probability: number }[]): string {
  return moved.map(({ storyId, probability }) => `${probability.toFixed(2)} ${storyId}`).join("; ");
}
