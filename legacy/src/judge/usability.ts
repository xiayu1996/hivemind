import { SEMANTIC_ITEMS, type ChecklistFinding, type SemanticItem } from "../pipeline/ui-checklist.js";
import { JudgeError, type NoulQuestion, type SystemOne } from "./system-one.js";

/**
 * The three usability items no rule decides (design 08 section 3.2, S1 to S3).
 *
 * Each one has "nothing seen" as its floor, and the judge can only move an item
 * off that floor -- never onto it. A judge that is off, unreachable, slow or
 * unsure therefore leaves the prototype exactly as the mechanical half left it,
 * which is what makes this safe to run on a gate that can refuse.
 *
 * The direction is the opposite of the environment question's, and the
 * threshold is its own key for that reason: a finding invented here costs a
 * redrawing round out of a small budget, while one missed costs a screen that
 * is a little less clear than it could be -- and a person still reads that
 * screen before anything is built on it.
 *
 * The input is the page's markup with comments and scripts removed, plus the
 * accessibility tree taken from the rendered page. Deliberately not a
 * screenshot: these three questions are about words, and the words are in the
 * text.
 */

/** Written in English, like every other judge question: it answers the words it
 * is given, and the criteria are where the boundary cases live. */
const QUESTIONS: Readonly<Record<SemanticItem, NoulQuestion>> = {
  S1: {
    type: "noul",
    instructions:
      "`page` is the markup of one prototype screen and `snapshot` is its accessibility tree. The screen has empty, loading, error and waiting states. Does at least one of those states show a message that fails to say both what has happened and what the person should do next?",
    criteria: {
      true: "A state message is present but says only that something happened or went wrong, without naming the situation or the next step: \"Error\", \"Something went wrong\", \"No data\", \"Loading...\" with nothing else, or a message whose only actionable part is a generic \"try again\".",
      false: "Every state message names the situation and either tells the person what to do or offers the control that does it, or the screen has no state messages at all.",
    },
  },
  S2: {
    type: "noul",
    instructions:
      "`page` is the markup of one prototype screen and `snapshot` is its accessibility tree. Does the screen show a form validation message that does not tell the person how to make the value acceptable?",
    criteria: {
      true: "A validation message states only that the input is wrong: \"Invalid\", \"This field is required and is incorrect\", \"Please check your input\", or a rule the person cannot act on without guessing the format.",
      false: "Every validation message names the rule the value must satisfy, or the screen has no validation messages.",
    },
  },
  S3: {
    type: "noul",
    instructions:
      "`page` is the markup of one prototype screen and `snapshot` is its accessibility tree. Is there a form control whose label does not describe that control?",
    criteria: {
      true: "A label names the section it sits in rather than the field, repeats a heading, is a placeholder standing in for a label, or describes a different control than the one it is attached to.",
      false: "Every form control has a label describing what goes into that control, or the screen has no form controls.",
    },
  },
};

/** Long enough for a prototype page, short enough that one long page cannot
 * push the question itself out of the model's attention. */
const MAX_PAGE_CHARS = 24000;
const MAX_SNAPSHOT_CHARS = 8000;

/** What a caller needs to ask. `judge` is optional at every call site on
 * purpose: leaving it out is how a deployment without the credential keeps the
 * mechanical half as its whole answer. */
export interface UsabilityJudgeSettings {
  judge?: SystemOne;
  model: string;
  threshold: number;
}

export interface UsabilityPage {
  /** Path relative to the contract root. */
  file: string;
  /** The page with comments and scripts already stripped. */
  page: string;
  /** Its accessibility tree, as the inspector read it. */
  snapshot: string;
}

export interface UsabilityJudgement {
  findings: readonly ChecklistFinding[];
  /** Every answer, including the ones that added nothing, so the value of
   * asking is read off the friction record rather than guessed at. */
  asked: readonly { file: string; item: SemanticItem; probability: number }[];
  /** Why the judge said nothing about what it said nothing about. Never thrown:
   * one failed question leaves the others standing, and the floor stands under
   * all of them. */
  error?: string;
}

const NOTHING: UsabilityJudgement = { findings: [], asked: [] };

export function usabilityQuestion(item: SemanticItem): NoulQuestion {
  return QUESTIONS[item];
}

/**
 * Asks the three questions about each page, one question per request.
 *
 * One per request rather than three in a call, for the reason measured on the
 * environment question: asked together, one answer moves with what else is in
 * the batch by far more than the same question moves when repeated on its own.
 * Batching would make S3's verdict depend on how bad S1 happened to be on the
 * same page, which is both unjustifiable and invisible.
 */
export async function judgeUsability(
  pages: readonly UsabilityPage[],
  options: UsabilityJudgeSettings,
): Promise<UsabilityJudgement> {
  const judge = options.judge;
  if (!judge || pages.length === 0) return NOTHING;

  const questions = pages.flatMap((page) => SEMANTIC_ITEMS.map((item) => ({ page, item })));
  const answers = await Promise.all(questions.map(async ({ page, item }) => {
    try {
      const response = await judge.ask({
        model: options.model,
        state: {
          page: page.page.slice(0, MAX_PAGE_CHARS),
          snapshot: page.snapshot.slice(0, MAX_SNAPSHOT_CHARS),
        },
        questions: { [item]: QUESTIONS[item] },
      });
      return { file: page.file, item, probability: response.answers[item]?.noul };
    } catch (error) {
      const message = error instanceof JudgeError ? `${error.kind}: ${error.message}` : (error as Error).message;
      return { file: page.file, item, failure: message };
    }
  }));

  const findings: ChecklistFinding[] = [];
  const asked: { file: string; item: SemanticItem; probability: number }[] = [];
  const failures: string[] = [];
  for (const answer of answers) {
    if ("failure" in answer && answer.failure !== undefined) {
      failures.push(answer.failure);
      continue;
    }
    const probability = "probability" in answer ? answer.probability : undefined;
    if (probability === undefined) continue;
    asked.push({ file: answer.file, item: answer.item, probability });
    if (probability < options.threshold) continue;
    findings.push({ item: answer.item, file: answer.file, what: WHAT[answer.item] });
  }
  return {
    findings: findings.toSorted((left, right) =>
      left.file === right.file
        ? (left.item < right.item ? -1 : 1)
        : (left.file < right.file ? -1 : 1)
    ),
    asked,
    ...(failures.length > 0
      ? { error: `${failures.length} of ${questions.length} unanswered: ${[...new Set(failures)].join("; ")}` }
      : {}),
  };
}

/** What the drawing is told to fix. Fixed text per item rather than the judge's
 * own words, because the judge answers a probability and nothing else -- and a
 * finding whose wording changed every round would never repeat. */
const WHAT: Readonly<Record<SemanticItem, string>> = {
  S1: "四态里至少一条文案没说清发生了什么、接下来该做什么",
  S2: "有校验提示只说了不对，没说怎么改对",
  S3: "有控件的标签描述的不是它旁边那个控件",
};
