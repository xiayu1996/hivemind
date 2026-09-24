import { businessLanguageQuestion, QUESTION_ID } from "./business-language.js";
import { lintHumanSentence, type BusinessLanguageFinding } from "../report/business-language.js";
import type { SystemOne } from "./system-one.js";

/**
 * The semantic half of the readability gates: whether a sentence a person will
 * read is about how the system was built, for the sentences `lintHumanSentence`
 * let through.
 *
 * That linter judges the proportion of Chinese characters and six patterns --
 * a code block, a path, a shell command, a stack frame, a source line. It
 * catches a technical sentence that looks technical. It cannot catch one
 * written entirely in Chinese prose: "本次改动把缓存层抽出来，复用到三个调用点"
 * is 100% Chinese, carries no path and no code, and is exactly the kind of
 * sentence the rule exists to keep out of a design summary.
 *
 * It asks the same question as the decomposition gate, deliberately: it is the
 * same question, already calibrated and already held to a captured fixture. Its
 * threshold is its own because the costs are not the same. Here the gate
 * declares `exhausted: "ship"` -- neither the design summary nor the delivery
 * report can stop a Story -- so a finding the judge invents costs one rewrite
 * and then ships anyway, while over in the decomposer the same mistake blocks
 * an Epic. That is why this bar sits lower than that one.
 *
 * This is the only judged question in the system with no veto anywhere, which
 * is the whole reason it may run on prose at all: a criterion about how a
 * sentence reads could never converge if something depended on it.
 */

/** Sentence terminators in both languages the reports are written in. The
 * fragments are what the judge sees, so they are the unit a finding names. */
const SENTENCE_BREAK = /(?<=[。！？!?；;\n])/;

/** A fragment shorter than this is a heading, a label or a list bullet, not a
 * sentence anyone would call implementation language. */
const MIN_SENTENCE_CHARS = 8;

/** Long enough for a sentence, short enough that an unterminated paragraph
 * cannot become one enormous question. */
const MAX_SENTENCE_CHARS = 400;

/** A ceiling on how many sentences one artifact may ask about at once. */
const MAX_SENTENCES_PER_ARTIFACT = 24;

export interface HumanSentenceOptions {
  model: string;
  /** How sure the judge has to be before a sentence is called out. */
  threshold: number;
  /** The field name the deterministic linter judges each fragment under. */
  field: string;
  /** How a finding describes itself, in the language that gate's rewrite
   * request is written in. */
  what: string;
}

export interface HumanSentenceJudgeSettings {
  judge?: SystemOne;
  model: string;
  threshold: number;
}

/** The sentences the deterministic linter did not already object to,
 * deduplicated and sorted so one artifact asks one set of questions. */
export function unjudgedSentences(field: string, body: string): string[] {
  const fragments = body.split(SENTENCE_BREAK).map((fragment) => fragment.trim());
  const kept = fragments.filter((fragment) =>
    fragment.length >= MIN_SENTENCE_CHARS && lintHumanSentence(field, fragment).length === 0);
  return [...new Set(kept)].toSorted();
}

/**
 * One sentence per request, for the reason measured on the environment
 * question (2026-09-18). Never throws: a judge that is missing, slow or unsure
 * adds no findings, and the linter's are the whole answer.
 */
export async function judgeHumanSentences(
  judge: SystemOne | undefined,
  body: string,
  options: HumanSentenceOptions,
): Promise<BusinessLanguageFinding[]> {
  if (!judge) return [];
  const asked = unjudgedSentences(options.field, body).slice(0, MAX_SENTENCES_PER_ARTIFACT);
  if (asked.length === 0) return [];

  const answers = await Promise.all(asked.map(async (sentence) => {
    try {
      const response = await judge.ask({
        model: options.model,
        state: { sentence: sentence.slice(0, MAX_SENTENCE_CHARS) },
        questions: { [QUESTION_ID]: businessLanguageQuestion() },
      });
      return { sentence, probability: response.answers[QUESTION_ID]?.noul };
    } catch {
      // One unanswered sentence is one missing finding on a gate that ships
      // either way; there is nothing to report and nothing to fail.
      return { sentence, probability: undefined };
    }
  }));

  return answers
    .filter((answer) => answer.probability !== undefined && answer.probability >= options.threshold)
    .map((answer) => ({ what: options.what, excerpt: answer.sentence.slice(0, 120) }));
}
