import { z } from "zod";
import { inspectBusinessLanguage } from "./decompose.js";
import text from "./human-question-text.json" with { type: "json" };

export interface QuestionOption {
  label: string;
  recommended?: boolean;
}

/**
 * A question the agent needs a person to answer. Options are what make it
 * answerable in one word: the person picks a letter, and the free-text
 * fallback is always there because the agent's options may all be wrong.
 */
export interface HumanQuestion {
  question: string;
  context?: string;
  options: readonly QuestionOption[];
}

/** What a model may emit: the structured form, or a bare sentence when no
 * sensible options exist. Both normalize to HumanQuestion. */
export type HumanQuestionInput =
  | string
  | {
    question: string;
    context?: string | undefined;
    options?: readonly { label: string; recommended?: boolean | undefined }[] | undefined;
  };

export const MAX_OPTIONS = 6;

export const humanQuestionInputSchema: z.ZodType<HumanQuestionInput> = z.union([
  z.string(),
  z.object({
    question: z.string(),
    context: z.string().optional(),
    options: z.array(z.object({
      label: z.string(),
      recommended: z.boolean().optional(),
    }).strict()).optional(),
  }).strict(),
]);

export function normalizeQuestion(input: HumanQuestionInput): HumanQuestion {
  if (typeof input === "string") return { question: input.trim(), options: [] };
  const context = input.context?.trim();
  const options: QuestionOption[] = [];
  for (const option of input.options ?? []) {
    const label = option.label.trim();
    if (label === "") continue;
    options.push(option.recommended ? { label, recommended: true } : { label });
  }
  return { question: input.question.trim(), ...(context ? { context } : {}), options };
}

/** Why a question cannot be shown to a person as it stands. */
export function inspectQuestion(field: string, question: HumanQuestion): string[] {
  const reasons: string[] = [];
  if (question.question === "") reasons.push(`${field} is empty`);
  if (question.options.length === 1) reasons.push(`${field} offers a single option; offer at least two or none`);
  if (question.options.length > MAX_OPTIONS) reasons.push(`${field} offers more than ${MAX_OPTIONS} options`);
  if (question.options.filter((option) => option.recommended).length > 1) {
    reasons.push(`${field} recommends more than one option`);
  }
  const labels = question.options.map((option) => option.label);
  for (const label of new Set(labels)) {
    if (labels.filter((value) => value === label).length > 1) reasons.push(`${field} repeats option: ${label}`);
  }
  const texts = [question.question, ...(question.context ? [question.context] : []), ...labels];
  for (const value of texts) {
    for (const issue of inspectBusinessLanguage(field, value)) {
      reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
    }
  }
  return reasons;
}

export function optionLetter(index: number): string {
  return String.fromCodePoint(65 + index);
}

/** The lines a person reads for one question: the question, its context, the
 * lettered options and the free-text fallback. No options, no fallback line. */
export function questionLines(question: HumanQuestion): string[] {
  const lines = [question.question];
  if (question.context) lines.push(`${text.contextPrefix}${question.context}`);
  if (question.options.length > 0) {
    for (const [index, option] of question.options.entries()) {
      lines.push(`${optionLetter(index)}. ${option.label}${option.recommended ? text.recommendedSuffix : ""}`);
    }
    lines.push(text.otherOption);
  }
  return lines;
}

export function questionText(question: HumanQuestion): string {
  return questionLines(question).join("\n");
}

/** A numbered batch as one comment body: indentation keeps each question's
 * options visually under it once several are listed. */
export function numberedQuestions(questions: readonly HumanQuestion[]): string[] {
  return questions.flatMap((question, index) => {
    const [first, ...rest] = questionLines(question);
    return [`${index + 1}. ${first}`, ...rest.map((line) => `   ${line}`)];
  });
}

/** How to reply, matched to what was asked. */
export function replyHint(questions: readonly HumanQuestion[]): string {
  if (questions.every((question) => question.options.length === 0)) return text.openReplyHint;
  return questions.length === 1 ? text.singleReplyHint : text.batchReplyHint;
}

export interface ResolvedChoice {
  questionIndex: number;
  optionIndex: number;
  label: string;
}

const marks = (values: readonly string[]): string => values.map((value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|");
// An option letter stands alone: end of text, whitespace or punctuation after
// it. "A/B" or "A4" is a word.
const optionEnd = String.raw`(?=$|[\s.,;:)\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF09])`;
// "1A", "1. A", "Q2: B", "<question marker> 3 <choice marker> c". Digits are
// always the question, letters always the option, so neither can be mistaken
// for the other.
const numberedChoice = new RegExp(
  String.raw`(?:^|[\s,;\uFF0C\uFF1B])(?:${marks(text.questionMarkers)})?\s*(\d{1,2})\s*[.:\uFF1A\u3001)\uFF09-]?\s*(?:${marks(text.choiceMarkers)})?\s*([A-Za-z])${optionEnd}`,
  "gi",
);
// A single question may be answered with the bare letter at the start of the reply.
const leadingChoice = new RegExp(String.raw`^\s*(?:${marks(text.choiceMarkers)})?\s*([A-Za-z])${optionEnd}`, "i");

/**
 * Reads the option letters out of a reply. Anything that does not fit the
 * grammar is left alone: the reply itself is always kept verbatim, this only
 * adds what the letters stood for.
 */
export function resolveChoices(questions: readonly HumanQuestion[], reply: string): ResolvedChoice[] {
  const resolved = new Map<number, ResolvedChoice>();
  const claim = (questionIndex: number, letter: string): void => {
    const question = questions[questionIndex];
    const optionIndex = letter.toUpperCase().codePointAt(0)! - 65;
    const option = question?.options[optionIndex];
    if (!option || resolved.has(questionIndex)) return;
    resolved.set(questionIndex, { questionIndex, optionIndex, label: option.label });
  };
  for (const match of reply.matchAll(numberedChoice)) claim(Number(match[1]) - 1, match[2]!);
  if (resolved.size === 0 && questions.length === 1) {
    const match = leadingChoice.exec(reply);
    if (match) claim(0, match[1]!);
  }
  return [...resolved.values()].toSorted((a, b) => a.questionIndex - b.questionIndex);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

/** The reply as written, followed by what its letters meant when they meant
 * something. Nothing is rewritten: a paraphrase would quietly become the
 * requirement, and nobody could tell it from what the person typed. */
export function annotateReply(questions: readonly HumanQuestion[], reply: string): string {
  const choices = resolveChoices(questions, reply);
  if (choices.length === 0) return reply;
  const parts = choices.map((choice) => fill(
    questions.length > 1 ? text.questionChoiceTemplate : text.singleChoiceTemplate,
    { question: String(choice.questionIndex + 1), letter: optionLetter(choice.optionIndex), label: choice.label },
  ));
  return `${reply}\n${fill(text.choiceNoteTemplate, { choices: parts.join(text.choiceSeparator) })}`;
}

/** Questions as persisted in JSON. Older rows hold bare strings. */
export function parseQuestions(value: unknown, label: string): HumanQuestion[] {
  if (typeof value !== "string") throw new Error(`${label} is not JSON text`);
  const parsed = z.array(humanQuestionInputSchema).safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error(`${label} is not an array of questions`);
  return parsed.data.map(normalizeQuestion);
}
