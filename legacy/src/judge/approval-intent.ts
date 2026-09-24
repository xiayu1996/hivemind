import { JudgeError, type NoulQuestion, type SystemOne } from "./system-one.js";

/**
 * Whether a comment left on a page that is waiting for approval is that
 * approval, for the comments the whitelist in `intent-interpreter.ts` did not
 * recognise.
 *
 * That whitelist compares the whole trimmed comment against four strings, so
 * "批准。" with a full stop, "确认，可以往下走" and "行，就这么干" are all read as
 * "you asked for changes" and the draft is rewritten for nothing. The judge is
 * asked only about the comments the whitelist did not match, and only a
 * confident yes turns one into an approval.
 *
 * The direction is the opposite of the environment question and for the same
 * kind of reason -- the two mistakes cost very different things:
 *
 *   missed approval  -> one wasted redraft, and the person says it again
 *   invented approval -> unapproved content goes on to be built, and what the
 *                        person actually asked for is lost
 *
 * So the floor is "this is not an approval", the judge may only move a comment
 * off it, and the bar is high. A comment that both agrees and asks for
 * something is not an approval: the request wins, which the criteria say in as
 * many words.
 */

/** What is waiting on the page. Reads into the question, so it is the word a
 * person would use rather than an internal state name. */
export type ApprovalSubject = "PRD" | "solution" | "decomposition plan";

const CRITERIA = (subject: ApprovalSubject) => ({
  true: `The comment accepts the ${subject} as it currently stands and asks for nothing to be changed. Agreement in any wording counts, including a short one.`,
  false: `The comment asks for any change, however small; or raises a question, an objection or a condition; or says nothing about whether the ${subject} is accepted. A comment that agrees and also asks for something is not an approval.`,
});

/** Long enough for a paragraph of review, short enough that a pasted document
 * cannot bury the sentence that decides the answer. */
const MAX_COMMENT_CHARS = 2000;

/** A ceiling on how many comments one poll may ask about at once. Beyond it the
 * whitelist answers, which is the safe direction. */
const MAX_COMMENTS_PER_POLL = 16;

export const QUESTION_ID = "is_approval";

export interface ApprovalJudgementOptions {
  model: string;
  /** How sure the judge has to be before a comment becomes an approval. */
  threshold: number;
}

export interface ApprovalJudgement {
  /** Comment bodies the judge read as approving what is on the page. */
  approving: ReadonlySet<string>;
  /** What moved and how sure the judge was, for the friction record. */
  moved: readonly { body: string; probability: number }[];
  /** Comments that went unasked because the poll was already at its ceiling. */
  skipped: number;
  /** Why the judge said nothing about the ones it said nothing about. Never
   * thrown: one failed question leaves the others standing. */
  error?: string;
}

/**
 * What a call site needs to ask the question. `judge` is optional on purpose:
 * leaving it out is how a deployment without the credential keeps the
 * whitelist as its whole answer. What moved is recorded against the
 * requirement or Epic it moved, by the caller that knows which one that is.
 */
export interface ApprovalJudgeSettings {
  judge?: SystemOne;
  model: string;
  threshold: number;
}

const NOTHING: ApprovalJudgement = { approving: new Set(), moved: [], skipped: 0 };

export function approvalQuestion(subject: ApprovalSubject): NoulQuestion {
  return {
    type: "noul",
    instructions:
      `The text at \`comment\` is a comment a person left on a page showing a proposed ${subject} that is waiting for their approval. Does it approve the ${subject} exactly as it currently stands?`,
    criteria: CRITERIA(subject),
  };
}

/**
 * One comment per request, for the reason measured on the environment question
 * (2026-09-18): asked together, one answer moves with what else is in the
 * batch by an order of magnitude more than it moves between runs. Here that
 * would make one person's approval depend on what else they happened to write
 * on other cards in the same poll.
 *
 * Never throws. A judge that is missing, slow or unsure leaves every comment
 * exactly where the whitelist put it.
 */
export async function judgeApprovals(
  judge: SystemOne | undefined,
  bodies: readonly string[],
  subject: ApprovalSubject,
  options: ApprovalJudgementOptions,
): Promise<ApprovalJudgement> {
  if (!judge) return NOTHING;
  const candidates = [...new Set(bodies.map((body) => body.trim()).filter((body) => body !== ""))].toSorted();
  if (candidates.length === 0) return NOTHING;
  const asked = candidates.slice(0, MAX_COMMENTS_PER_POLL);
  const skipped = candidates.length - asked.length;

  const answers = await Promise.all(asked.map(async (body) => {
    try {
      const response = await judge.ask({
        model: options.model,
        state: { comment: body.slice(0, MAX_COMMENT_CHARS) },
        questions: { [QUESTION_ID]: approvalQuestion(subject) },
      });
      return { body, probability: response.answers[QUESTION_ID]?.noul };
    } catch (error) {
      const message = error instanceof JudgeError ? `${error.kind}: ${error.message}` : (error as Error).message;
      return { body, failure: message };
    }
  }));

  const approving = new Set<string>();
  const moved: { body: string; probability: number }[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if ("failure" in answer && answer.failure !== undefined) {
      failures.push(answer.failure);
      continue;
    }
    const probability = "probability" in answer ? answer.probability : undefined;
    if (probability === undefined || probability < options.threshold) continue;
    approving.add(answer.body);
    moved.push({ body: answer.body, probability });
  }
  const unanswered = failures.length;
  return {
    approving,
    moved,
    skipped: skipped + unanswered,
    ...(unanswered > 0 ? { error: `${unanswered} of ${asked.length} unanswered: ${[...new Set(failures)].join("; ")}` } : {}),
  };
}

/** One line for the friction record: what the whitelist missed, and how sure
 * the judge was that it was an approval. */
export function renderMovedApprovals(moved: readonly { body: string; probability: number }[]): string {
  return moved
    .map(({ body, probability }) => `${probability.toFixed(2)} ${body.slice(0, 160)}`)
    .join("; ");
}
