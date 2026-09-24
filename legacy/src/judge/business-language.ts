import type { LanguageIssue } from "../orchestrator/decompose.js";
import { inspectBusinessLanguage } from "../orchestrator/decompose.js";
import { JudgeError, type NoulQuestion, type SystemOne } from "./system-one.js";

/**
 * Whether a line a person will read on a project page is about how the system
 * is built, for the lines the word table in `decompose.ts` did not catch.
 *
 * That table is seventeen words and stays the floor: a line it matches is
 * refused today and is never asked about, so the judge can only add a refusal,
 * never clear one. The table catches a word, not a meaning, so it misses every
 * sentence that describes construction without naming one of the seventeen --
 * "引入缓存层以降低响应延迟" scores zero hits and reaches the board as though it
 * said what a person can do.
 *
 * The bar is high for the same reason it is high on the approval question, and
 * the opposite of the environment one. A refusal the judge invents is not free:
 * `EpicDecomposer` has two attempts, and the same wrong refusal twice blocks
 * the Epic and costs a person. A refusal it misses costs what happens today --
 * one line on a page that reads like construction. So the judge only refuses
 * what it is sure about.
 *
 * The criteria say in as many words that a product whose subject matter is
 * technical is still about the person. That matters more since the table began
 * excusing the words the requirement itself uses: those lines now reach this
 * question instead of being refused outright, so it is the layer that has to
 * get them right.
 */

const CRITERIA = {
  true: "The sentence is about construction: code, functions, components, modules, classes, databases, schemas, tables, queries, APIs, endpoints, libraries, frameworks, caches, queues, threads, file paths, build steps, tests, or deployment. It is also about construction when it names an internal technique chosen for an internal effect -- adding a layer, a cache, an index, a job, a retry -- even where it goes on to state the benefit.",
  false: "The sentence is about a person and what they can do, see, get or decide: an outcome, a rule they are subject to, a step they take, or something that appears on a screen. It stays about the person when the product's own subject matter is technical -- an integration, an interface other developers call, an import or export format -- as long as it says what someone can do with that thing rather than how it is built. A sentence that is merely vague, incomplete or badly written is not about construction.",
} as const;

/** Long enough for a requirement sentence and its tail, short enough that a
 * pasted block cannot bury the clause that decides the answer. */
const MAX_LINE_CHARS = 600;

/** A ceiling on how many lines one decomposition may ask about at once. A plan
 * with more than this keeps the table's answer for the rest, which is the safe
 * direction. */
const MAX_LINES_PER_DECOMPOSITION = 64;

export const QUESTION_ID = "is_implementation";

export interface BusinessLanguageOptions {
  model: string;
  /** How sure the judge has to be before a line is refused. */
  threshold: number;
  /** Construction words the requirement itself uses. The table lets these
   * through, so the judge has to be asked about them rather than skip them as
   * already refused -- and its criteria say a product whose subject matter is
   * technical is still about the person. */
  vocabulary?: ReadonlySet<string> | undefined;
}

/** One line of a plan, with the field name a person would recognise it by. */
export interface JudgedLine {
  field: string;
  line: number;
  text: string;
}

export interface BusinessLanguageJudgement {
  /** Refusals to add to the ones the table already produced. */
  issues: readonly LanguageIssue[];
  /** What was refused and how sure the judge was, for the friction record. */
  moved: readonly { text: string; probability: number }[];
  /** Lines that went unasked because the plan was already at its ceiling. */
  skipped: number;
  /** Why the judge said nothing about the lines it said nothing about. Never
   * thrown: one failed question leaves the others standing. */
  error?: string;
}

export interface BusinessLanguageJudgeSettings {
  judge?: SystemOne;
  model: string;
  threshold: number;
}

const NOTHING: BusinessLanguageJudgement = { issues: [], moved: [], skipped: 0 };

export function businessLanguageQuestion(): NoulQuestion {
  return {
    type: "noul",
    instructions:
      "The text at `sentence` is one line of a plan that a person will read on their project page. Does it describe how the system is built internally, rather than what a person can do or get?",
    criteria: CRITERIA,
  };
}

/**
 * The lines the table did not already refuse, deduplicated and sorted so the
 * same plan asks the same questions: a sentence repeated across three Stories
 * is one question, and two runs of one plan produce the same requests in the
 * same order.
 */
export function unjudgedLines(
  lines: readonly JudgedLine[],
  vocabulary: ReadonlySet<string> = new Set(),
): JudgedLine[] {
  const seen = new Set<string>();
  const kept: JudgedLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (text === "" || seen.has(text)) continue;
    if (inspectBusinessLanguage(line.field, text, vocabulary).length > 0) continue;
    seen.add(text);
    kept.push({ ...line, text });
  }
  return kept.toSorted((left, right) => (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
}

/**
 * One line per request, for the reason measured on the environment question
 * (2026-09-18): asked together, one answer moves with what else is in the batch
 * by an order of magnitude more than it moves between runs. Here that would
 * make one Story's refusal depend on how the other Stories in the same plan
 * happened to be worded.
 *
 * Never throws. A judge that is missing, slow or unsure adds nothing, and the
 * table's refusals are the whole answer -- which is today's behaviour.
 */
export async function judgeBusinessLanguage(
  judge: SystemOne | undefined,
  lines: readonly JudgedLine[],
  options: BusinessLanguageOptions,
): Promise<BusinessLanguageJudgement> {
  if (!judge) return NOTHING;
  const candidates = unjudgedLines(lines, options.vocabulary);
  if (candidates.length === 0) return NOTHING;
  const asked = candidates.slice(0, MAX_LINES_PER_DECOMPOSITION);
  const skipped = candidates.length - asked.length;

  const answers = await Promise.all(asked.map(async (line) => {
    try {
      const response = await judge.ask({
        model: options.model,
        state: { sentence: line.text.slice(0, MAX_LINE_CHARS) },
        questions: { [QUESTION_ID]: businessLanguageQuestion() },
      });
      return { line, probability: response.answers[QUESTION_ID]?.noul };
    } catch (error) {
      const message = error instanceof JudgeError ? `${error.kind}: ${error.message}` : (error as Error).message;
      return { line, failure: message };
    }
  }));

  const issues: LanguageIssue[] = [];
  const moved: { text: string; probability: number }[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if ("failure" in answer && answer.failure !== undefined) {
      failures.push(answer.failure);
      continue;
    }
    const probability = "probability" in answer ? answer.probability : undefined;
    if (probability === undefined || probability < options.threshold) continue;
    issues.push({
      field: answer.line.field,
      line: answer.line.line,
      reason: "describes how the system is built; rewrite it as what a person can do or get",
    });
    moved.push({ text: answer.line.text, probability });
  }
  const unanswered = failures.length;
  return {
    issues,
    moved,
    skipped: skipped + unanswered,
    ...(unanswered > 0 ? { error: `${unanswered} of ${asked.length} unanswered: ${[...new Set(failures)].join("; ")}` } : {}),
  };
}

/** One line for the friction record: what was refused, and how sure the judge
 * was. Truncated because this is read on a card page, not in a log. */
export function renderRefusedLines(moved: readonly { text: string; probability: number }[]): string {
  return moved
    .map(({ text, probability }) => `${probability.toFixed(2)} ${text.slice(0, 160)}`)
    .join("; ");
}
