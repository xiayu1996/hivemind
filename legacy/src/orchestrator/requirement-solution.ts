import { lintHumanSentence } from "../report/business-language.js";
import type { RejectedArtifact } from "./requirement-artifacts.js";

/**
 * The technical solution for one requirement: what it will be built with, and
 * what is still a person's call. It exists because no layer below it has the
 * scope to decide either — the PRD and the requirement decomposition are held
 * to business language, and a Story's DESIGN may not ask questions and sees one
 * card. A requirement that needed a new dependency could therefore only have it
 * chosen in passing by whichever card reached CODE first (design 08 section 1).
 */
export type StackChangeKind = "added" | "upgraded" | "removed";

export interface StackChange {
  kind: StackChangeKind;
  /** What is changing, as it is named in the ecosystem it comes from. */
  name: string;
  /** Why, in the words of the person who has to approve it. */
  reason: string;
  /** What else it touches. Written for whoever maintains it afterwards. */
  impact: string;
}

/** A fork the agent refuses to decide alone, with what it would pick. */
export interface OpenDecision {
  question: string;
  recommendation: string;
}

/** How the new stack proves itself, so a check exists before the code does. */
export interface QualityGate {
  name: string;
  command: readonly string[];
  /** What this gate would catch; also what a platform without one cannot claim. */
  covers: string;
}

export type InterfaceKind = "web" | "mobile" | "desktop";

export interface InterfacePage {
  name: string;
  /** The question this page answers for the person looking at it. */
  purpose: string;
}

/**
 * Which way the screens look, and which ways they were not made to look.
 *
 * It is here rather than in the drawing because it is a repository-level
 * decision made once: the token table and the reason layer are reused by every
 * later requirement, so the first requirement with screens is choosing the
 * style for all of them (design 08 section 3.3). The alternatives are what
 * makes it a choice rather than a default -- an unconstrained model converges
 * on the same system font, the same violet gradient and the same grid of
 * identical rounded cards, which is not wrong so much as nobody's decision.
 */
export interface VisualDirection {
  /** The direction taken, in one paragraph, for the person who approves it. */
  summary: string;
  /** The directions turned down, and why. A repository that already has a
   * contract says here that it is keeping it, and what it did not start. */
  alternatives: readonly { option: string; reason: string }[];
}

/**
 * Present when the requirement puts something on a screen. The contract itself
 * (tokens, component inventory, runnable page prototypes) lands in the
 * repository and is written by the next slice; what is here is the shape a
 * person approves: which platform, which pages, and which way they look.
 */
export interface InterfacePlan {
  kind: InterfaceKind;
  direction: VisualDirection;
  pages: readonly InterfacePage[];
}

export interface SolutionApproach {
  /** One paragraph for the person approving it. */
  summary: string;
  /** What was considered and turned down, and why. */
  alternatives: readonly { option: string; reason: string }[];
}

export interface SolutionCandidate {
  approach: SolutionApproach;
  stackChanges?: readonly StackChange[];
  openDecisions?: readonly OpenDecision[];
  qualityGates?: readonly QualityGate[];
  /** The direction may be absent here and is refused with a reason, rather than
   * failing to parse: a draft that forgot it is told what it forgot. */
  interface?: (Omit<InterfacePlan, "direction"> & { direction?: VisualDirection }) | null;
}

export interface AcceptedSolution {
  kind: "accepted";
  approach: SolutionApproach;
  stackChanges: readonly StackChange[];
  openDecisions: readonly OpenDecision[];
  qualityGates: readonly QualityGate[];
  interface: InterfacePlan | null;
}

export type SolutionResult = AcceptedSolution | RejectedArtifact;

export type SolutionBody = Omit<AcceptedSolution, "kind">;

const STACK_CHANGE_KINDS = new Set<string>(["added", "upgraded", "removed"]);
const INTERFACE_KINDS = new Set<string>(["web", "mobile", "desktop"]);

function humanReasons(field: string, text: string): string[] {
  return lintHumanSentence(field, text).map((finding) => finding.what);
}

/**
 * What is wrong with the visual direction, if anything.
 *
 * A direction with no alternatives is not a direction: it reads the same
 * whether the agent weighed three and picked one or drew the first thing it
 * thought of, and the person approving has nothing to approve against.
 */
function directionReasons(direction: VisualDirection | undefined): string[] {
  const reasons: string[] = [];
  const summary = direction?.summary?.trim() ?? "";
  const alternatives = (direction?.alternatives ?? []).map((entry) => ({
    option: entry.option.trim(),
    reason: entry.reason.trim(),
  }));
  if (summary === "") reasons.push("an interface must say which way its screens look");
  else reasons.push(...humanReasons("visual direction", summary));
  if (alternatives.length === 0) {
    reasons.push("a visual direction must name the directions it did not take");
  }
  for (const [index, entry] of alternatives.entries()) {
    const label = `visual direction alternative ${index + 1}`;
    if (entry.option === "") reasons.push(`${label} must name the direction considered`);
    if (entry.reason === "") reasons.push(`${label} must say why it was turned down`);
    else reasons.push(...humanReasons(`${label} reason`, entry.reason));
  }
  return reasons;
}

/**
 * Validates a solution before a person is asked to read it.
 *
 * Two rules carry the weight. A stack change must come with the alternatives
 * that lost, because an approval with nothing to compare against is a rubber
 * stamp; and it must come with the check that will hold the new stack, because
 * a stack nothing verifies is a stack whose failures reach a person instead of
 * an exit gate - the repository's own front end lived outside lint, typecheck
 * and the test runner for exactly that reason.
 */
export function evaluateSolution(candidate: SolutionCandidate): SolutionResult {
  const reasons: string[] = [];
  const summary = candidate.approach?.summary?.trim() ?? "";
  const alternatives = (candidate.approach?.alternatives ?? []).map((entry) => ({
    option: entry.option.trim(),
    reason: entry.reason.trim(),
  })).filter((entry) => entry.option !== "" || entry.reason !== "");
  const stackChanges = (candidate.stackChanges ?? []).map((change) => ({
    kind: change.kind,
    name: change.name.trim(),
    reason: change.reason.trim(),
    impact: change.impact.trim(),
  }));
  const openDecisions = (candidate.openDecisions ?? []).map((decision) => ({
    question: decision.question.trim(),
    recommendation: decision.recommendation.trim(),
  })).filter((decision) => decision.question !== "" || decision.recommendation !== "");
  const qualityGates = (candidate.qualityGates ?? []).map((gate) => ({
    name: gate.name.trim(),
    command: gate.command.map((argument) => argument.trim()).filter((argument) => argument !== ""),
    covers: gate.covers.trim(),
  }));
  const plan = candidate.interface ?? null;

  if (summary === "") reasons.push("the solution must say in one paragraph what will be built with");
  else reasons.push(...humanReasons("approach summary", summary));

  for (const [index, entry] of alternatives.entries()) {
    const label = `alternative ${index + 1}`;
    if (entry.option === "") reasons.push(`${label} must name what was considered`);
    if (entry.reason === "") reasons.push(`${label} must say why it was turned down`);
    else reasons.push(...humanReasons(`${label} reason`, entry.reason));
  }

  for (const [index, change] of stackChanges.entries()) {
    const label = `stack change ${index + 1}`;
    if (!STACK_CHANGE_KINDS.has(change.kind)) reasons.push(`${label} must be added, upgraded or removed`);
    if (change.name === "") reasons.push(`${label} must name what changes`);
    if (change.reason === "") reasons.push(`${label} must say why it is needed`);
    else reasons.push(...humanReasons(`${label} reason`, change.reason));
    if (change.impact === "") reasons.push(`${label} must say what else it touches`);
  }
  if (stackChanges.length > 0 && alternatives.length === 0) {
    reasons.push("a solution that changes the stack must list the alternatives it turned down");
  }
  if (stackChanges.length > 0 && qualityGates.length === 0) {
    reasons.push("a solution that changes the stack must say which check will hold the new stack");
  }

  for (const [index, decision] of openDecisions.entries()) {
    const label = `open decision ${index + 1}`;
    if (decision.question === "") reasons.push(`${label} must state the question`);
    else reasons.push(...humanReasons(`${label} question`, decision.question));
    if (decision.recommendation === "") reasons.push(`${label} must carry the option it recommends`);
    else reasons.push(...humanReasons(`${label} recommendation`, decision.recommendation));
  }

  for (const [index, gate] of qualityGates.entries()) {
    const label = `quality gate ${index + 1}`;
    if (gate.name === "") reasons.push(`${label} must have a name`);
    if (gate.command.length === 0) reasons.push(`${label} must carry the command that runs it`);
    if (gate.covers === "") reasons.push(`${label} must say what it would catch`);
  }

  if (plan !== null) {
    if (!INTERFACE_KINDS.has(plan.kind)) reasons.push("an interface must be web, mobile or desktop");
    reasons.push(...directionReasons(plan.direction));
    if (plan.pages.length === 0) reasons.push("an interface must list the pages it is made of");
    for (const [index, page] of plan.pages.entries()) {
      const label = `page ${index + 1}`;
      if (page.name.trim() === "") reasons.push(`${label} must have a name`);
      else reasons.push(...humanReasons(`${label} name`, page.name));
      if (page.purpose.trim() === "") reasons.push(`${label} must say which question it answers`);
      else reasons.push(...humanReasons(`${label} purpose`, page.purpose));
    }
    // A platform this installation cannot drive a browser on has no way to show
    // that its screens work, and a delivery nobody can verify is worse than one
    // nobody started. The gate is what the person is being asked to accept.
    if (plan.kind !== "web" && qualityGates.length === 0) {
      reasons.push(`an interface on ${plan.kind} must say how this installation proves its screens work`);
    }
  }

  if (reasons.length > 0) return { kind: "rejected", reasons: [...new Set(reasons)] };
  return {
    kind: "accepted",
    approach: { summary, alternatives },
    stackChanges,
    openDecisions,
    qualityGates,
    interface: plan === null ? null : {
      kind: plan.kind,
      direction: {
        summary: plan.direction?.summary.trim() ?? "",
        alternatives: (plan.direction?.alternatives ?? []).map((entry) => ({
          option: entry.option.trim(),
          reason: entry.reason.trim(),
        })),
      },
      pages: plan.pages.map((page) => ({ name: page.name.trim(), purpose: page.purpose.trim() })),
    },
  };
}

/**
 * Whether this solution has to be read by a person before anything is built on
 * it. Decided from the body rather than from the agent saying so: the two
 * expensive mistakes are a stack the repository now carries forever and an
 * interface every later card copies, and an open question that auto-approves is
 * a question nobody answers.
 */
export function solutionNeedsApproval(solution: SolutionBody): boolean {
  return solution.stackChanges.length > 0
    || solution.openDecisions.length > 0
    || solution.interface !== null;
}

/** Why it is waiting, in the words the page and the log both use. */
export function approvalReasons(solution: SolutionBody): string[] {
  const reasons: string[] = [];
  if (solution.stackChanges.length > 0) reasons.push("stack_changes");
  if (solution.openDecisions.length > 0) reasons.push("open_decisions");
  if (solution.interface !== null) reasons.push("interface");
  return reasons;
}
