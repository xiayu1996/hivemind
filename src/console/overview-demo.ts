import type { Client, InStatement } from "@libsql/client";
import demo from "./overview-demo.json" with { type: "json" };

/**
 * The demonstration dataset the standalone console starts with when it is
 * pointed at no database.
 *
 * The real console always reads the central store; this exists so the screen
 * can be opened and reviewed with every section carrying content -- a running
 * requirement and two running tasks, three waiting items of different kinds,
 * two live failures beside one recovered, completions on both sides of the
 * seven-day boundary, and a requirement over its cost ceiling that keeps
 * working. Nothing here is written unless the entry point was given no
 * database, so it can never overwrite anything a person owns.
 */
export async function seedOverviewDemo(client: Client, nowMs: number): Promise<void> {
  const at = (offsetMs: number): number => nowMs + offsetMs;
  const statements: InStatement[] = [];

  for (const requirement of demo.requirements) {
    statements.push({
      sql: `INSERT INTO requirements
              (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        requirement.id,
        `demo-page-${requirement.id}`,
        requirement.title,
        requirement.state,
        demo.originalRequest,
        at(requirement.createdOffsetMs),
        at(requirement.updatedOffsetMs),
      ],
    });
  }

  for (const round of demo.clarifyRounds) {
    const answered = "answeredOffsetMs" in round;
    statements.push(answered
      ? {
        sql: `INSERT INTO requirement_clarify_rounds
                (requirement_id, round, questions, asked_at, answered_at, answers)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          round.requirementId,
          round.round,
          round.questions,
          at(round.askedOffsetMs),
          at(round.answeredOffsetMs as number),
          round.answers as string,
        ],
      }
      : {
        sql: `INSERT INTO requirement_clarify_rounds
                (requirement_id, round, questions, asked_at, answered_at, answers)
              VALUES (?, ?, ?, ?, NULL, NULL)`,
        args: [round.requirementId, round.round, round.questions, at(round.askedOffsetMs)],
      });
  }

  for (const prd of demo.prds) {
    statements.push({
      sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [prd.requirementId, prd.revision, prd.body, prd.status, at(prd.createdOffsetMs)],
    });
  }

  for (const story of demo.stories) {
    statements.push({
      sql: `INSERT INTO stories
              (id, notion_page_id, title, requirement, state, phase, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        story.id,
        `demo-page-${story.id}`,
        story.title,
        demo.originalRequest,
        story.state,
        story.phase,
        at(story.createdOffsetMs),
        at(story.updatedOffsetMs),
      ],
    });
  }

  for (const event of demo.failureEvents) {
    statements.push({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES (?, 0, ?, NULL, 'requirement.transition', ?, ?)`,
      args: [event.runId, event.cardId, at(event.offsetMs), event.data],
    });
  }

  for (const run of demo.phaseRuns) {
    statements.push({
      sql: `INSERT INTO phase_runs
              (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        run.runId,
        run.cardId,
        run.phase,
        run.round,
        "0".repeat(64),
        run.status,
        run.failure,
        at(run.startedOffsetMs),
        at(run.endedOffsetMs),
      ],
    });
  }

  for (const cost of demo.costs) {
    statements.push({
      sql: `INSERT INTO cost_entries (run_id, card_id, phase, provider, model_id, cost_usd, ts)
            VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      args: [cost.runId, cost.cardId, cost.provider, cost.modelId, cost.costUsd, at(cost.offsetMs)],
    });
  }

  statements.push({
    sql: `INSERT INTO config_entries (scope_id, key, value_json, updated_by, updated_at)
          VALUES ('global', 'cost.perCardUsdCeiling', ?, 'demo', ?)`,
    args: [JSON.stringify(demo.ceilingUsd), nowMs],
  });

  await client.batch(statements, "write");
}
