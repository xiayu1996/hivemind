import { inspectQuestion, normalizeQuestion, type HumanQuestion, type HumanQuestionInput } from "./human-question.js";

export interface DecompositionScenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface DecompositionStory {
  id: string;
  title: string;
  requirement: string;
  /** Where a person sees this Story's outcome: the screen, report or message
   * they open. A slice with no entry point of its own is a layer, not a Story. */
  userEntryPoint: string;
  /** How this Story is verified on its own, without waiting for a sibling. */
  verificationPath: string;
  scenarios: readonly DecompositionScenario[];
  dependsOn: readonly string[];
  predictedFootprint: readonly string[];
}

export interface DecompositionCandidate {
  epicId: string;
  businessGoal: string;
  stories: readonly DecompositionStory[];
  blockingQuestion?: HumanQuestionInput;
}

export interface LanguageIssue {
  field: string;
  line: number;
  reason: string;
}

export interface AcceptedDecomposition {
  kind: "accepted";
  epicId: string;
  businessGoal: string;
  stories: readonly DecompositionStory[];
}

export interface DecompositionLimits {
  /** Stories per Epic. A longer list is almost always a horizontal cut of one
   * feature; re-splitting is cheaper than carrying it through the pipeline. */
  maxStories?: number;
}

export interface RejectedDecomposition {
  kind: "rejected";
  epicId: string;
  reasons: readonly string[];
}

export interface BlockingQuestion {
  kind: "blocking_question";
  epicId: string;
  question: HumanQuestion;
}

export type DecompositionResult = AcceptedDecomposition | RejectedDecomposition | BlockingQuestion;

const storyId = /^S-[A-Z0-9]+-\d{2}$/;
const scenarioId = /^S-[A-Z0-9]+-\d{2}-[a-z0-9]+$/;
const footprint = /^(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/;

/**
 * What a footprint entry has to look like, written out wherever one is refused.
 *
 * The same lesson as the id shapes below. R237511RC wrote `src/console 角色配置
 * 读取与版本对比` -- a directory with the reason it was chosen appended -- and
 * was told the entry "must name a directory or module, not a file" four
 * attempts running. It had named a directory, so the refusal described a
 * mistake it had not made and there was nothing for it to act on.
 */
const FOOTPRINT_SHAPE =
  "a footprint entry is the path alone, lowercase, like src/orchestrator: no file name, no extension and no description after it";

/**
 * The id shapes, written out wherever one is refused.
 *
 * A rejection that names only the rule it broke is one the next attempt cannot
 * act on. Two Epics in a row were blocked here: one invented `<EPIC>-S01` twice
 * running because "has an invalid Story id" never said what a valid one looks
 * like, and one carried the PRD's own scenario ids into its Stories because
 * nothing said those are a different namespace. Both shapes are stated in the
 * phase prompt as well; this is the layer that survives the model ignoring it.
 */
/** The Story-id stem this Epic's ids are built on, or null when the Epic id
 * cannot make one this file would accept. An example that is itself invalid is
 * worse than none, because the next attempt copies it. */
export function storyIdStem(epicId: string): string | null {
  const stem = epicId.replace(/^E-/, "");
  return /^[A-Z0-9]+$/.test(stem) ? stem : null;
}

export function storyIdShape(epicId: string): string {
  const stem = storyIdStem(epicId) ?? "<EPIC>";
  return `Story ids are S-${stem}-01, S-${stem}-02 and so on, numbered in listing order`;
}

export function scenarioIdShape(storyIdValue: string): string {
  return `scenario ids are the Story id followed by a lowercase suffix, like ${storyIdValue}-a`
    + ", and are this Epic's own: a PRD scenario id is not one";
}
// Words that only ever describe construction. Deliberately narrower than it
// looks: "code" belongs to a promotion code, "class" to a class of customers
// and "实现" to realising a business outcome, so blacklisting those bounces
// requirements that were written correctly. English "test" is not listed, so
// its Chinese counterpart is not either.
const CONSTRUCTION_TERMS = /\b(?:api|component|database|function|implementation|module|npm|react|schema|sql|typescript)\b|代码|函数|组件|数据库|模块|文件路径/gi;

// Shapes that are never a person's words, whatever the product is about: a
// path into the tree, a fenced block, a stack frame. Unlike a term, these
// cannot be excused by the requirement -- a customer does not write a stack
// frame into what they asked for.
const CONSTRUCTION_ARTIFACTS = /\b(?:src|lib|app)\/[\w./-]+|```|(?:at\s+\S+\s*\([^)]*:\d+:\d+\))/i;

/**
 * The construction words that belong to this product rather than to its
 * plumbing, taken from the requirement a person wrote or approved.
 *
 * A word table cannot tell "把这段逻辑抽成一个组件" from "运营在组件库里挑一个
 *组件放到页面上", and it used to refuse both. The second is a product whose
 * subject matter is technical, and refusing it is not a nuisance: the
 * decomposer gets two attempts, the model has nowhere to go because the word
 * *is* the requirement, and the Epic blocks on a requirement that was written
 * correctly.
 *
 * The requirement settles it. A term the person used is the product's own
 * vocabulary and a Story may use it back; a term that appears nowhere upstream
 * and turns up in a Story is the model reaching for implementation language,
 * which is what the table is for. Nothing here is a judgement call, and the
 * authority is text a human wrote.
 */
export function domainVocabulary(requirement: string): ReadonlySet<string> {
  return new Set((requirement.match(CONSTRUCTION_TERMS) ?? []).map((term) => term.toLocaleLowerCase()));
}

/** Finds internal construction language in the lines that are shown to people. */
export function inspectBusinessLanguage(
  field: string,
  text: string,
  vocabulary: ReadonlySet<string> = new Set(),
): LanguageIssue[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const foreign = (line.match(CONSTRUCTION_TERMS) ?? [])
      .filter((term) => !vocabulary.has(term.toLocaleLowerCase()));
    if (foreign.length === 0 && !CONSTRUCTION_ARTIFACTS.test(line)) return [];
    return [{ field, line: index + 1, reason: "contains implementation language; rewrite it as a customer or business outcome" }];
  });
}

function normalizeStory(story: DecompositionStory): DecompositionStory {
  return {
    ...story,
    scenarios: story.scenarios.map((scenario) => ({ ...scenario })),
    dependsOn: [...story.dependsOn].toSorted(),
    predictedFootprint: [...story.predictedFootprint].toSorted(),
  };
}

function validateStory(
  story: DecompositionStory,
  index: number,
  allStoryIds: ReadonlySet<string>,
  vocabulary: ReadonlySet<string>,
  epicId: string,
): string[] {
  const prefix = `Story ${story.id || index + 1}`;
  const reasons: string[] = [];
  const idValid = storyId.test(story.id);
  if (!idValid) reasons.push(`${prefix} has an invalid Story id "${story.id}": ${storyIdShape(epicId)}`);
  if (story.title.trim() === "") reasons.push(`${prefix} must have a business title`);
  for (const issue of inspectBusinessLanguage(`${prefix} title`, story.title, vocabulary)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (story.requirement.trim() === "") reasons.push(`${prefix} must have a business requirement`);
  for (const issue of inspectBusinessLanguage(`${prefix} requirement`, story.requirement, vocabulary)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (story.scenarios.length === 0) reasons.push(`${prefix} must have at least one independently verifiable scenario`);
  for (const scenario of story.scenarios) {
    // Only when the Story id itself is sound. Every scenario id is built on it,
    // so one wrong Story id otherwise turns into a refusal per scenario and
    // buries the reason the split was actually rejected under its own echo.
    if (idValid && (!scenarioId.test(scenario.id) || !scenario.id.startsWith(`${story.id}-`))) {
      reasons.push(`${prefix} has an invalid scenario id "${scenario.id}": ${scenarioIdShape(story.id)}`);
    }
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
    for (const [field, value] of Object.entries({ given: scenario.given, when: scenario.when, then: scenario.then })) {
      if (value.trim() === "") reasons.push(`${prefix} scenario ${scenario.id} must have ${field}`);
      for (const issue of inspectBusinessLanguage(`${prefix} scenario ${scenario.id} ${field}`, value, vocabulary)) {
        reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
      }
    }
  }
  // A vertical slice cuts through every layer and lands somewhere a person can
  // look. Both fields are the check that it does: without them the plausible
  // failure is six Stories that each build one layer of the same screen, which
  // is what the 2026-09-05 Epic did and why none of its cards could be verified
  // or delivered on its own.
  if (story.userEntryPoint.trim() === "") {
    reasons.push(`${prefix} must name the user-visible entry point where its outcome can be seen`);
  }
  for (const issue of inspectBusinessLanguage(`${prefix} user entry point`, story.userEntryPoint, vocabulary)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (story.verificationPath.trim() === "") {
    reasons.push(`${prefix} must state how it is verified on its own, without a sibling Story`);
  }
  for (const issue of inspectBusinessLanguage(`${prefix} verification path`, story.verificationPath, vocabulary)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (story.predictedFootprint.length === 0) reasons.push(`${prefix} must declare a footprint: ${FOOTPRINT_SHAPE}`);
  for (const entry of story.predictedFootprint) {
    if (!footprint.test(entry)) reasons.push(`${prefix} footprint entry ${JSON.stringify(entry)} is not usable: ${FOOTPRINT_SHAPE}`);
  }
  for (const dependency of story.dependsOn) {
    if (!allStoryIds.has(dependency)) reasons.push(`${prefix} references unknown dependency ${dependency}`);
    if (dependency === story.id) reasons.push(`${prefix} cannot depend on itself`);
  }
  return reasons;
}

/**
 * Validates an all-or-nothing DECOMPOSE artifact. Input order is retained because
 * it is the approved dependency order; only set-like fields are canonicalized.
 */
export const DEFAULT_MAX_STORIES = 4;

/** Two Stories that show their outcome in the same place are one Story cut
 * horizontally, whatever their titles say. */
function horizontalCuts(stories: readonly DecompositionStory[]): string[] {
  const reasons: string[] = [];
  const byEntryPoint = new Map<string, string[]>();
  for (const story of stories) {
    const key = story.userEntryPoint.trim().toLowerCase();
    if (key === "") continue;
    byEntryPoint.set(key, [...(byEntryPoint.get(key) ?? []), story.id]);
  }
  for (const [entryPoint, ids] of byEntryPoint) {
    if (ids.length > 1) {
      reasons.push(`Stories ${ids.join(", ")} share the user-visible entry point "${entryPoint}": that is one Story cut into layers, re-split it so each slice is independently usable`);
    }
  }
  const footprints = new Set(stories.map((story) => [...story.predictedFootprint].toSorted().join("|")));
  if (stories.length > 1 && footprints.size === 1) {
    reasons.push("every Story declares the same footprint, so the Epic was cut by layer rather than by outcome; re-split it");
  }
  return reasons;
}

export function evaluateDecomposition(
  candidate: DecompositionCandidate,
  limits: DecompositionLimits = {},
  /** Construction words the requirement itself uses, from `domainVocabulary`.
   * Empty means every one of them is the model's own and is refused. */
  vocabulary: ReadonlySet<string> = new Set(),
): DecompositionResult {
  const question = candidate.blockingQuestion === undefined ? null : normalizeQuestion(candidate.blockingQuestion);
  if (question && question.question !== "") {
    if (candidate.stories.length > 0) {
      return { kind: "rejected", epicId: candidate.epicId, reasons: ["blocking question cannot include partial Stories"] };
    }
    const reasons = inspectQuestion("blocking question", question);
    if (reasons.length > 0) return { kind: "rejected", epicId: candidate.epicId, reasons: [...new Set(reasons)] };
    return { kind: "blocking_question", epicId: candidate.epicId, question };
  }

  const reasons: string[] = [];
  if (candidate.businessGoal.trim() === "") reasons.push("Epic must state the business outcome to achieve");
  for (const issue of inspectBusinessLanguage("business goal", candidate.businessGoal, vocabulary)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (candidate.stories.length === 0) reasons.push("Epic must contain at least one Story");
  const maxStories = limits.maxStories ?? DEFAULT_MAX_STORIES;
  if (candidate.stories.length > maxStories) {
    reasons.push(`Epic contains ${candidate.stories.length} Stories, more than the ${maxStories} allowed: split the Epic or merge the slices that are not independently usable`);
  }
  reasons.push(...horizontalCuts(candidate.stories));

  const ids = candidate.stories.map((story) => story.id);
  const allStoryIds = new Set(ids);
  for (const id of allStoryIds) {
    if (ids.filter((value) => value === id).length > 1) reasons.push(`duplicate Story id: ${id}`);
  }
  const scenarioIds = new Set<string>();
  for (const [index, story] of candidate.stories.entries()) {
    reasons.push(...validateStory(story, index, allStoryIds, vocabulary, candidate.epicId));
    for (const scenario of story.scenarios) {
      if (scenarioIds.has(scenario.id)) reasons.push(`duplicate scenario id: ${scenario.id}`);
      scenarioIds.add(scenario.id);
    }
    for (const dependency of story.dependsOn) {
      const dependencyIndex = ids.indexOf(dependency);
      if (dependencyIndex > index) reasons.push(`Story ${story.id} dependency ${dependency} must appear before it`);
    }
  }
  if (reasons.length > 0) return { kind: "rejected", epicId: candidate.epicId, reasons: [...new Set(reasons)] };
  return {
    kind: "accepted",
    epicId: candidate.epicId,
    businessGoal: candidate.businessGoal,
    stories: candidate.stories.map(normalizeStory),
  };
}
