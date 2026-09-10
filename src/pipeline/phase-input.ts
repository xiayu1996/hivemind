export type Phase = "DESIGN" | "CODE" | "VERIFY" | "MERGE" | "DECOMPOSE" | "REGRESSION_FIX";

export interface SpecRow {
  id: string;
  status: string;
  text: string;
}

export interface PhaseArtifact {
  /** Producing phase, e.g. "DESIGN". */
  phase: string;
  kind: string;
  body: string;
}

export interface FeedbackItem {
  id: string;
  author: string;
  specId?: string;
  body: string;
}

export interface ScenarioFailure {
  scenarioId: string;
  reason: string;
  /** Which lane refused it: the tests, or the person looking at the screen. */
  source: "tests" | "screen";
}

export interface EvidenceRef {
  scenarioId: string;
  path: string;
  note?: string;
}

export interface PhaseInput {
  cardId: string;
  phase: Phase;
  round: number;
  title: string;
  requirement: string;
  repo?: string;
  branch?: string;
  specs: SpecRow[];
  artifacts: PhaseArtifact[];
  feedback: FeedbackItem[];
  previousRejections: PhaseRejection[];
  evidence: EvidenceRef[];
  failedScenarios: string[];
  /** Why each scenario was refused, verbatim from the lane that refused it. */
  scenarioFailures?: ScenarioFailure[];
}

export interface PhaseRejection {
  phase: string;
  reason: string;
}

const SECTION = "\n\n";

/**
 * Builds the complete prompt for a phase from central state alone.
 *
 * Phases do not fork or resume each other's sessions. Every phase run receives
 * its whole context as text, which is what makes a run idempotent, movable to
 * another machine, and replayable on a different provider: cross-host rebuild,
 * failover and crash recovery all ride on this one mechanism.
 *
 * The output must be byte-identical for identical input. A phase re-entry that
 * produced a different prompt would make failures irreproducible and would break
 * provider-side prefix caching, so nothing here may read the clock, the
 * filesystem or a random source, and every collection is sorted by a stable key.
 */
export function assemblePhasePrompt(input: PhaseInput): string {
  const parts: string[] = [];

  parts.push(`# Task ${input.cardId} - ${input.title}`);
  parts.push(`Phase: ${input.phase}\nRound: ${input.round}`);

  const location = [
    input.repo ? `Repository: ${input.repo}` : null,
    input.branch ? `Branch: ${input.branch}` : null,
  ].filter((line) => line !== null);
  if (location.length > 0) parts.push(location.join("\n"));

  parts.push(`## Requirement\n\n${input.requirement.trim()}`);

  if (input.specs.length > 0) {
    const rows = sortBy(input.specs, (s) => s.id).map((s) => `- ${s.id} [${s.status}] ${s.text}`);
    parts.push(`## Specification\n\n${rows.join("\n")}`);
  }

  // Everything this round is answerable for comes before the history, and
  // carries a tag. A round that read 18KB of its own earlier artifacts before
  // reaching the one line a person wrote is the shape every wasted round on
  // S-E3OVERVIEW-01 had (measured with scripts/inspect-round.ts, 2026-09-10).
  const todo = roundTasks(input);
  if (todo.length > 0) {
    parts.push("## What this round must do\n\n" +
      "Each item below is a reason this round exists. Do the work each one asks for; " +
      "an answer from a person is a decision, not a suggestion, and a scenario refused " +
      "by the screen lane is refused for what the person saw, not for what a test asserts. " +
      "In your final artifact write one line per tag — `addressed <tag>: <what you changed>` — " +
      "naming the change; the exit checks refuse the phase while a tag is unaccounted for.\n\n" +
      todo.map((task) => `- ${task.tag} ${task.text}`).join("\n"));
  }

  if (input.evidence.length > 0) {
    const rows = sortBy(input.evidence, (e) => `${e.scenarioId} ${e.path}`)
      .map((e) => `- ${e.scenarioId}: ${e.path}${e.note ? ` (${e.note})` : ""}`);
    parts.push(`## Evidence from earlier rounds\n\n${rows.join("\n")}`);
  }

  if (input.artifacts.length > 0) {
    const blocks = sortBy(input.artifacts, (a) => `${a.phase} ${a.kind}`)
      .map((a) => `### ${a.phase} / ${a.kind}\n\n${a.body.trim()}`);
    parts.push(`## Output of earlier phases\n\n${blocks.join(SECTION)}`);
  }

  return `${parts.join(SECTION)}\n`;
}

export interface RoundTask {
  tag: string;
  text: string;
}

/**
 * What the round is answerable for, tagged so both the prompt and the exit
 * checks can name the same item. Ordering is by tag, which is derived from
 * stable ids, so the prompt stays byte-identical for identical input.
 */
export function roundTasks(input: PhaseInput): RoundTask[] {
  const tasks: RoundTask[] = [];
  for (const item of sortBy(input.feedback, (f) => f.id)) {
    tasks.push({
      tag: `[answer:${item.id}]`,
      text: `${item.author} answered${item.specId ? ` on ${item.specId}` : ""}: ${item.body.trim()}`,
    });
  }
  for (const rejection of sortBy(input.previousRejections, (r) => `${r.phase} ${r.reason}`)) {
    tasks.push({
      tag: `[rejected:${rejection.phase}]`,
      text: `${rejection.phase} refused the last attempt: ${rejection.reason.trim()}`
        + " Do not repeat the rejected approach.",
    });
  }
  const reasons = new Map<string, ScenarioFailure[]>();
  for (const failure of input.scenarioFailures ?? []) {
    reasons.set(failure.scenarioId, [...(reasons.get(failure.scenarioId) ?? []), failure]);
  }
  for (const scenarioId of input.failedScenarios.toSorted()) {
    const why = (reasons.get(scenarioId) ?? [])
      .map((failure) => `${failure.source === "screen" ? "the person looking at the screen" : "the tests"}: ${failure.reason.trim()}`)
      .join(" ");
    tasks.push({
      tag: `[scenario:${scenarioId}]`,
      text: `still failing. ${why || "No reason was recorded; treat the scenario as unverified and prove it."}`,
    });
  }
  return tasks;
}

/** Sorts by a derived key without mutating the caller's array. */
function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, key: key(item) }))
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.item);
}
