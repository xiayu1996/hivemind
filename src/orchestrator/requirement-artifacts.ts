import { inspectBusinessLanguage } from "./decompose.js";

export interface ClarificationCandidate {
  status: "ask" | "ready";
  questions?: readonly string[];
  summary?: string;
}

export interface AskedClarification {
  kind: "ask";
  questions: readonly string[];
}

export interface ReadyClarification {
  kind: "ready";
  summary: string;
}

export interface RejectedArtifact {
  kind: "rejected";
  reasons: readonly string[];
}

export type ClarificationResult = AskedClarification | ReadyClarification | RejectedArtifact;

export interface PrdScenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

export interface PrdCandidate {
  businessGoal: string;
  nonGoals?: readonly string[];
  scenarios: readonly PrdScenario[];
  openQuestions?: readonly string[];
}

export interface AcceptedPrd {
  kind: "accepted";
  businessGoal: string;
  nonGoals: readonly string[];
  scenarios: readonly PrdScenario[];
  openQuestions: readonly string[];
}

export type PrdResult = AcceptedPrd | RejectedArtifact;

export interface RequirementEpic {
  id: string;
  title: string;
  businessGoal: string;
  body: string;
  scenarioIds: readonly string[];
}

export interface RequirementDecompositionCandidate {
  epics: readonly RequirementEpic[];
}

export interface AcceptedRequirementDecomposition {
  kind: "accepted";
  epics: readonly RequirementEpic[];
}

export type RequirementDecompositionResult = AcceptedRequirementDecomposition | RejectedArtifact;

// Uppercase because Story ids are built from the Epic id and must stay
// readable on the board: S-<epic>-01.
const epicId = /^[A-Z][A-Z0-9]{1,15}$/;

function languageReasons(field: string, text: string): string[] {
  return inspectBusinessLanguage(field, text)
    .map((issue) => `${issue.field} line ${issue.line} ${issue.reason}`);
}

/**
 * Judges one clarification round. The product manager either asks or declares
 * itself ready: a batch that also claims readiness would leave the loop unable
 * to say whether the person still owes an answer.
 */
export function evaluateClarification(
  candidate: ClarificationCandidate,
  maxQuestions: number,
): ClarificationResult {
  const reasons: string[] = [];
  const questions = (candidate.questions ?? []).map((question) => question.trim()).filter((question) => question !== "");
  const summary = candidate.summary?.trim() ?? "";

  if (candidate.status === "ready") {
    if (questions.length > 0) reasons.push("a ready verdict cannot carry questions");
    if (summary === "") reasons.push("a ready verdict must restate the requirement in business language");
    reasons.push(...languageReasons("summary", summary));
    if (reasons.length > 0) return { kind: "rejected", reasons: [...new Set(reasons)] };
    return { kind: "ready", summary };
  }

  if (questions.length === 0) reasons.push("an asking round must contain at least one question");
  if (questions.length > maxQuestions) {
    reasons.push(`an asking round must not exceed ${maxQuestions} questions`);
  }
  if (summary !== "") reasons.push("an asking round must not also declare the requirement understood");
  for (const [index, question] of questions.entries()) {
    reasons.push(...languageReasons(`question ${index + 1}`, question));
  }
  for (const question of new Set(questions)) {
    if (questions.filter((value) => value === question).length > 1) {
      reasons.push(`duplicate question: ${question}`);
    }
  }
  if (reasons.length > 0) return { kind: "rejected", reasons: [...new Set(reasons)] };
  return { kind: "ask", questions };
}

/**
 * Validates a PRD before a person is asked to approve it. Scenarios are the
 * spine: each one becomes exactly one acceptance item the same person judges
 * later, so an unusable scenario set is caught here rather than at acceptance.
 */
export function evaluatePrd(requirementId: string, candidate: PrdCandidate): PrdResult {
  const reasons: string[] = [];
  const businessGoal = candidate.businessGoal.trim();
  const nonGoals = (candidate.nonGoals ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "");
  const openQuestions = (candidate.openQuestions ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "");

  if (businessGoal === "") reasons.push("PRD must state the business outcome to achieve");
  reasons.push(...languageReasons("business goal", businessGoal));
  for (const [index, entry] of nonGoals.entries()) reasons.push(...languageReasons(`non-goal ${index + 1}`, entry));
  for (const [index, entry] of openQuestions.entries()) {
    reasons.push(...languageReasons(`open question ${index + 1}`, entry));
  }
  if (candidate.scenarios.length === 0) reasons.push("PRD must contain at least one acceptable scenario");

  const seen = new Set<string>();
  const scenarioId = new RegExp(`^${requirementId.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}-[a-z0-9]+$`);
  for (const scenario of candidate.scenarios) {
    const id = scenario.id.trim();
    if (!scenarioId.test(id)) reasons.push(`scenario id must start with ${requirementId}-: ${scenario.id}`);
    if (seen.has(id)) reasons.push(`duplicate scenario id: ${id}`);
    seen.add(id);
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
    for (const [field, value] of Object.entries({ given: scenario.given, when: scenario.when, then: scenario.then })) {
      if (value.trim() === "") reasons.push(`scenario ${id} must have ${field}`);
      reasons.push(...languageReasons(`scenario ${id} ${field}`, value));
    }
  }

  if (reasons.length > 0) return { kind: "rejected", reasons: [...new Set(reasons)] };
  return {
    kind: "accepted",
    businessGoal,
    nonGoals,
    openQuestions,
    scenarios: candidate.scenarios.map((scenario) => ({
      id: scenario.id.trim(),
      given: scenario.given,
      when: scenario.when,
      // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
      then: scenario.then,
    })),
  };
}

/**
 * Validates the split of a confirmed PRD into delivery batches. Every scenario
 * lands in exactly one Epic: an uncovered scenario is work nobody picked up,
 * and a duplicated one gets built twice and judged once.
 */
export function evaluateRequirementDecomposition(
  prdScenarioIds: readonly string[],
  candidate: RequirementDecompositionCandidate,
): RequirementDecompositionResult {
  const reasons: string[] = [];
  if (candidate.epics.length === 0) reasons.push("a confirmed PRD must produce at least one Epic");

  const seenIds = new Set<string>();
  const covered = new Map<string, number>();
  for (const epic of candidate.epics) {
    const id = epic.id.trim();
    const label = `Epic ${id || "?"}`;
    if (!epicId.test(id)) reasons.push(`${label} has an id that cannot carry Story ids`);
    if (seenIds.has(id)) reasons.push(`duplicate Epic id: ${id}`);
    seenIds.add(id);
    if (epic.title.trim() === "") reasons.push(`${label} must have a business title`);
    if (epic.businessGoal.trim() === "") reasons.push(`${label} must state the business outcome to achieve`);
    // The Epic body is all a downstream agent will see: it never gets the PRD
    // or the clarification history back.
    if (epic.body.trim() === "") reasons.push(`${label} must carry a self-sufficient requirement body`);
    for (const [field, value] of Object.entries({ title: epic.title, businessGoal: epic.businessGoal, body: epic.body })) {
      reasons.push(...languageReasons(`${label} ${field}`, value));
    }
    if (epic.scenarioIds.length === 0) reasons.push(`${label} must carry at least one PRD scenario`);
    for (const scenarioId of epic.scenarioIds) {
      if (!prdScenarioIds.includes(scenarioId)) reasons.push(`${label} references an unknown scenario: ${scenarioId}`);
      covered.set(scenarioId, (covered.get(scenarioId) ?? 0) + 1);
    }
  }

  for (const scenarioId of prdScenarioIds) {
    const count = covered.get(scenarioId) ?? 0;
    if (count === 0) reasons.push(`no Epic covers scenario ${scenarioId}`);
    if (count > 1) reasons.push(`scenario ${scenarioId} is covered by more than one Epic`);
  }

  if (reasons.length > 0) return { kind: "rejected", reasons: [...new Set(reasons)] };
  return {
    kind: "accepted",
    epics: candidate.epics.map((epic) => ({
      id: epic.id.trim(),
      title: epic.title.trim(),
      businessGoal: epic.businessGoal.trim(),
      body: epic.body.trim(),
      scenarioIds: [...epic.scenarioIds],
    })),
  };
}
