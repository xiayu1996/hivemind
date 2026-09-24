import type { Client } from "@libsql/client";

/**
 * One card's whole life, as one readable document.
 *
 * A card that went eight rounds leaves its record spread over a dozen tables
 * and a directory of files; answering "what actually happened here" by hand
 * means joining them in your head. This joins them once, from the central
 * store, and produces the same text every time it is run for the same card.
 *
 * It is generated on demand and never during delivery. Producing it at merge
 * would put a reporting failure in front of a card that is otherwise finished,
 * which is exactly the coupling ring 0 exists to prevent.
 */

export interface DossierRun {
  runId: string;
  phase: string;
  round: number;
  status: string;
  failure: string | null;
  startedAt: number;
  artifacts: Array<{ kind: string; body: string }>;
  costUsd: number;
}

export interface DossierQuestion {
  key: string;
  question: string;
  suggestion: string;
  blocking: boolean;
  answer: string | null;
}

export interface DossierScenarioResult {
  scenarioId: string;
  round: number;
  outcome: string;
  carried: boolean;
}

export interface DossierRejection {
  phase: string | null;
  round: number | null;
  reason: string;
}

export interface CardDossier {
  cardId: string;
  title: string;
  state: string;
  phase: string | null;
  stopReason: string | null;
  innerLoopRounds: number;
  mrUrl: string | null;
  runs: DossierRun[];
  questions: DossierQuestion[];
  scenarioResults: DossierScenarioResult[];
  rejections: DossierRejection[];
  costUsd: number;
}

/** How long a quoted artifact may run before it is cut; a dossier is for
 * reading, and a full CODE body would bury everything around it. */
const QUOTE_LIMIT = 600;

function quote(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= QUOTE_LIMIT ? trimmed : `${trimmed.slice(0, QUOTE_LIMIT)}\n… (${trimmed.length} chars)`;
}

/** Pure and deterministic: the same card renders byte for byte the same text,
 * so two readings can be diffed against each other. */
export function renderCardDossier(dossier: CardDossier): string {
  const lines: string[] = [];
  lines.push(`# ${dossier.cardId} — ${dossier.title}`, "");
  lines.push(`state: ${dossier.state}${dossier.phase ? ` (${dossier.phase})` : ""}`);
  lines.push(`inner loop rounds: ${dossier.innerLoopRounds}`);
  lines.push(`spend: $${dossier.costUsd.toFixed(4)}`);
  if (dossier.stopReason) lines.push(`stopped for: ${dossier.stopReason}`);
  if (dossier.mrUrl) lines.push(`review request: ${dossier.mrUrl}`);

  if (dossier.questions.length > 0) {
    lines.push("", "## Questions asked before the work started", "");
    for (const question of dossier.questions) {
      lines.push(`- [${question.blocking ? "blocking" : "open"}] ${question.key}: ${question.question}`);
      lines.push(`  proposed: ${question.suggestion}`);
      lines.push(`  answer: ${question.answer ?? "(none yet)"}`);
    }
  }

  lines.push("", "## What each phase did", "");
  for (const run of dossier.runs) {
    lines.push(`### ${run.phase} round ${run.round} — ${run.status}${run.failure ? `: ${run.failure}` : ""}`);
    lines.push(`run ${run.runId} · $${run.costUsd.toFixed(4)}`);
    for (const artifact of run.artifacts) {
      lines.push("", `**${artifact.kind}**`, "", quote(artifact.body));
    }
    lines.push("");
  }

  if (dossier.scenarioResults.length > 0) {
    lines.push("## Scenario conclusions", "");
    for (const result of dossier.scenarioResults) {
      lines.push(`- round ${result.round} ${result.scenarioId}: ${result.outcome}${result.carried ? " (carried forward)" : ""}`);
    }
    lines.push("");
  }

  if (dossier.rejections.length > 0) {
    lines.push("## Sent back", "");
    for (const rejection of dossier.rejections) {
      lines.push(`- ${rejection.phase ?? "card"}${rejection.round === null ? "" : ` round ${rejection.round}`}: ${rejection.reason}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function loadCardDossier(client: Client, cardId: string): Promise<CardDossier | null> {
  const story = (await client.execute({
    sql: `SELECT id, title, state, phase, stop_reason, inner_loop_rounds, mr_url FROM stories WHERE id = ?`,
    args: [cardId],
  })).rows[0];
  if (!story) return null;

  const [runRows, artifactRows, questionRows, scenarioRows, rejectionRows, costRows] = await Promise.all([
    client.execute({
      sql: `SELECT run_id, phase, round, status, failure, started_at FROM phase_runs
             WHERE card_id = ? ORDER BY started_at, run_id`,
      args: [cardId],
    }),
    client.execute({
      sql: `SELECT run_id, kind, body FROM phase_artifacts WHERE card_id = ? ORDER BY run_id, kind`,
      args: [cardId],
    }),
    client.execute({
      sql: `SELECT question_key, question, suggestion, blocking, answer FROM open_questions
             WHERE card_id = ? ORDER BY question_key`,
      args: [cardId],
    }),
    client.execute({
      sql: `SELECT scenario_id, round, outcome, carried_from FROM verify_scenario_results
             WHERE card_id = ? ORDER BY round, scenario_id, id`,
      args: [cardId],
    }),
    client.execute({
      sql: `SELECT phase, data FROM event_log
             WHERE card_id = ? AND type = 'phase.invalidated' ORDER BY ts, id`,
      args: [cardId],
    }),
    client.execute({
      sql: `SELECT run_id, SUM(cost_usd) AS usd FROM cost_entries WHERE card_id = ? GROUP BY run_id`,
      args: [cardId],
    }),
  ]);

  const costByRun = new Map(costRows.rows.map((row) => [String(row.run_id), Number(row.usd)]));
  const artifactsByRun = new Map<string, Array<{ kind: string; body: string }>>();
  for (const row of artifactRows.rows) {
    const runId = String(row.run_id);
    const list = artifactsByRun.get(runId) ?? [];
    list.push({ kind: String(row.kind), body: String(row.body) });
    artifactsByRun.set(runId, list);
  }

  const runs: DossierRun[] = runRows.rows.map((row) => ({
    runId: String(row.run_id),
    phase: String(row.phase),
    round: Number(row.round),
    status: String(row.status),
    failure: row.failure === null ? null : String(row.failure),
    startedAt: Number(row.started_at),
    artifacts: artifactsByRun.get(String(row.run_id)) ?? [],
    costUsd: costByRun.get(String(row.run_id)) ?? 0,
  }));

  return {
    cardId,
    title: String(story.title),
    state: String(story.state),
    phase: story.phase === null ? null : String(story.phase),
    stopReason: story.stop_reason === null ? null : String(story.stop_reason),
    innerLoopRounds: Number(story.inner_loop_rounds),
    mrUrl: story.mr_url === null ? null : String(story.mr_url),
    runs,
    questions: questionRows.rows.map((row) => ({
      key: String(row.question_key),
      question: String(row.question),
      suggestion: String(row.suggestion),
      blocking: Number(row.blocking) === 1,
      answer: row.answer === null ? null : String(row.answer),
    })),
    scenarioResults: scenarioRows.rows.map((row) => ({
      scenarioId: String(row.scenario_id),
      round: Number(row.round),
      outcome: String(row.outcome),
      carried: row.carried_from !== null,
    })),
    rejections: rejectionRows.rows.map((row) => {
      const data = JSON.parse(String(row.data)) as { round?: unknown; reason?: unknown };
      return {
        phase: row.phase === null ? null : String(row.phase),
        round: typeof data.round === "number" ? data.round : null,
        reason: typeof data.reason === "string" ? data.reason : "(no reason recorded)",
      };
    }),
    costUsd: [...costByRun.values()].reduce((sum, value) => sum + value, 0),
  };
}
