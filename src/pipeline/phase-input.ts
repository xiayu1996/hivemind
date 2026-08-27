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
  evidence: EvidenceRef[];
  failedScenarios: string[];
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

  if (input.artifacts.length > 0) {
    const blocks = sortBy(input.artifacts, (a) => `${a.phase} ${a.kind}`)
      .map((a) => `### ${a.phase} / ${a.kind}\n\n${a.body.trim()}`);
    parts.push(`## Output of earlier phases\n\n${blocks.join(SECTION)}`);
  }

  if (input.feedback.length > 0) {
    const rows = sortBy(input.feedback, (f) => f.id)
      .map((f) => `- ${f.author}${f.specId ? ` on ${f.specId}` : ""}: ${f.body.trim()}`);
    parts.push(`## Human feedback\n\n${rows.join("\n")}`);
  }

  if (input.failedScenarios.length > 0) {
    const rows = input.failedScenarios.toSorted().map((s) => `- ${s}`);
    parts.push(`## Scenarios still failing\n\n${rows.join("\n")}`);
  }

  if (input.evidence.length > 0) {
    const rows = sortBy(input.evidence, (e) => `${e.scenarioId} ${e.path}`)
      .map((e) => `- ${e.scenarioId}: ${e.path}${e.note ? ` (${e.note})` : ""}`);
    parts.push(`## Evidence from earlier rounds\n\n${rows.join("\n")}`);
  }

  return `${parts.join(SECTION)}\n`;
}

/** Sorts by a derived key without mutating the caller's array. */
function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, key: key(item) }))
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.item);
}
