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
  scenarios: readonly DecompositionScenario[];
  dependsOn: readonly string[];
  predictedFootprint: readonly string[];
}

export interface DecompositionCandidate {
  epicId: string;
  businessGoal: string;
  stories: readonly DecompositionStory[];
  blockingQuestion?: string;
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

export interface RejectedDecomposition {
  kind: "rejected";
  epicId: string;
  reasons: readonly string[];
}

export interface BlockingQuestion {
  kind: "blocking_question";
  epicId: string;
  question: string;
}

export type DecompositionResult = AcceptedDecomposition | RejectedDecomposition | BlockingQuestion;

const storyId = /^S-[A-Z0-9]+-\d{2}$/;
const scenarioId = /^S-[A-Z0-9]+-\d{2}-[a-z0-9]+$/;
const footprint = /^(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/;
// Words that only ever describe construction. Deliberately narrower than it
// looks: "code" belongs to a promotion code, "class" to a class of customers
// and "实现" to realising a business outcome, so blacklisting those bounces
// requirements that were written correctly. English "test" is not listed, so
// its Chinese counterpart is not either.
const implementationLanguage = /\b(?:api|component|database|function|implementation|module|npm|react|schema|sql|typescript)\b|\b(?:src|lib|app)\/[\w./-]+|```|(?:at\s+\S+\s*\([^)]*:\d+:\d+\))|(?:代码|函数|组件|数据库|模块|文件路径)/i;

/** Finds internal construction language in the lines that are shown to people. */
export function inspectBusinessLanguage(field: string, text: string): LanguageIssue[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!implementationLanguage.test(line)) return [];
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

function validateStory(story: DecompositionStory, index: number, allStoryIds: ReadonlySet<string>): string[] {
  const prefix = `Story ${story.id || index + 1}`;
  const reasons: string[] = [];
  if (!storyId.test(story.id)) reasons.push(`${prefix} has an invalid Story id`);
  if (story.title.trim() === "") reasons.push(`${prefix} must have a business title`);
  for (const issue of inspectBusinessLanguage(`${prefix} title`, story.title)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (story.requirement.trim() === "") reasons.push(`${prefix} must have a business requirement`);
  for (const issue of inspectBusinessLanguage(`${prefix} requirement`, story.requirement)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (story.scenarios.length === 0) reasons.push(`${prefix} must have at least one independently verifiable scenario`);
  for (const scenario of story.scenarios) {
    if (!scenarioId.test(scenario.id) || !scenario.id.startsWith(`${story.id}-`)) {
      reasons.push(`${prefix} has an invalid scenario id: ${scenario.id}`);
    }
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
    for (const [field, value] of Object.entries({ given: scenario.given, when: scenario.when, then: scenario.then })) {
      if (value.trim() === "") reasons.push(`${prefix} scenario ${scenario.id} must have ${field}`);
      for (const issue of inspectBusinessLanguage(`${prefix} scenario ${scenario.id} ${field}`, value)) {
        reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
      }
    }
  }
  if (story.predictedFootprint.length === 0) reasons.push(`${prefix} must declare a directory or module footprint`);
  for (const entry of story.predictedFootprint) {
    if (!footprint.test(entry)) reasons.push(`${prefix} footprint must name a directory or module, not a file: ${entry}`);
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
export function evaluateDecomposition(candidate: DecompositionCandidate): DecompositionResult {
  if (candidate.blockingQuestion?.trim()) {
    if (candidate.stories.length > 0) {
      return { kind: "rejected", epicId: candidate.epicId, reasons: ["blocking question cannot include partial Stories"] };
    }
    return { kind: "blocking_question", epicId: candidate.epicId, question: candidate.blockingQuestion.trim() };
  }

  const reasons: string[] = [];
  if (candidate.businessGoal.trim() === "") reasons.push("Epic must state the business outcome to achieve");
  for (const issue of inspectBusinessLanguage("business goal", candidate.businessGoal)) {
    reasons.push(`${issue.field} line ${issue.line} ${issue.reason}`);
  }
  if (candidate.stories.length === 0) reasons.push("Epic must contain at least one Story");

  const ids = candidate.stories.map((story) => story.id);
  const allStoryIds = new Set(ids);
  for (const id of allStoryIds) {
    if (ids.filter((value) => value === id).length > 1) reasons.push(`duplicate Story id: ${id}`);
  }
  const scenarioIds = new Set<string>();
  for (const [index, story] of candidate.stories.entries()) {
    reasons.push(...validateStory(story, index, allStoryIds));
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
