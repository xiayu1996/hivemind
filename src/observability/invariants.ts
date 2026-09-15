import type { Client } from "@libsql/client";

/**
 * Statements about the pipeline that must hold, checked against the central
 * store rather than enforced in it.
 *
 * What can be a DB constraint already is one: the four stop reasons, the state
 * enumerations, the builder and verifier being different sessions. These are
 * the ones a constraint cannot express, because they relate rows in different
 * tables written at different times by different processes. A violation is a
 * finding, never a block: the point is to see a hole in the process, and a
 * checker that could stop a card would be a second, weaker gate.
 */

export interface InvariantFinding {
  invariant: string;
  cardId: string | null;
  detail: string;
}

export interface Invariant {
  name: string;
  /** What a violation means, in the terms a reader would use. */
  statement: string;
  check(client: Client): Promise<InvariantFinding[]>;
}

/** States in which SPECIFY has already run and its freeze must exist. */
const AFTER_SPECIFY = "('CODE','VERIFY','MERGE','DELIVERED')";

export const FLOW_INVARIANTS: readonly Invariant[] = [
  {
    name: "code-has-a-frozen-contract",
    statement: "a card that has reached CODE has a SPECIFY freeze to be measured against",
    check: async (client) => (await client.execute(
      `SELECT s.id FROM stories s
        WHERE s.state IN ${AFTER_SPECIFY}
          AND NOT EXISTS (
            SELECT 1 FROM story_test_contracts t
             WHERE t.card_id = s.id AND t.specify_commit IS NOT NULL)
        ORDER BY s.id`,
    )).rows.map((row) => ({
      invariant: "code-has-a-frozen-contract",
      cardId: String(row.id),
      detail: "no frozen test contract; the CODE exit has no frozen tests to diff against",
    })),
  },
  {
    name: "work-has-a-frozen-contract",
    statement: "every card past SHAPE has a Definition of Done recorded by SHAPE",
    check: async (client) => (await client.execute(
      `SELECT s.id FROM stories s
        WHERE s.state IN ('DESIGN','SPECIFY','CODE','VERIFY','MERGE','DELIVERED','REGRESSION_FIX')
          AND NOT EXISTS (
            SELECT 1 FROM phase_artifacts a
             WHERE a.card_id = s.id AND a.phase = 'SHAPE' AND a.kind = 'dod')
        ORDER BY s.id`,
    )).rows.map((row) => ({
      invariant: "work-has-a-frozen-contract",
      cardId: String(row.id),
      detail: "no Definition of Done from SHAPE; everything downstream is judged against nothing",
    })),
  },
  {
    name: "rework-invalidates-something",
    statement: "a rework a person asked for and the system applied left an invalidation behind",
    check: async (client) => (await client.execute(
      `SELECT f.card_id, f.applied_at FROM human_feedback f
        WHERE f.channel = 'rework' AND f.applied_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_log e
             WHERE e.card_id = f.card_id AND e.type = 'phase.invalidated' AND e.ts >= f.applied_at)
        ORDER BY f.card_id, f.applied_at`,
    )).rows.map((row) => ({
      invariant: "rework-invalidates-something",
      cardId: String(row.card_id),
      detail: `rework applied at ${String(row.applied_at)} invalidated no phase; the person was told work was redone and it was not`,
    })),
  },
  {
    name: "a-completed-run-produced-something",
    statement: "a phase run that reports success left an artifact behind",
    check: async (client) => (await client.execute(
      `SELECT r.run_id, r.card_id FROM phase_runs r
        WHERE r.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM phase_artifacts a WHERE a.run_id = r.run_id)
        ORDER BY r.run_id`,
    )).rows.map((row) => ({
      invariant: "a-completed-run-produced-something",
      cardId: String(row.card_id),
      detail: `run ${String(row.run_id)} completed with no artifact`,
    })),
  },
  {
    name: "delivered-scenarios-were-verified",
    statement: "a delivered card has a passing conclusion for every scenario it declared",
    check: async (client) => (await client.execute(
      `SELECT v.card_id, v.scenario_id FROM story_dod_versions v
         JOIN stories s ON s.id = v.card_id
        WHERE s.state = 'DELIVERED'
          AND NOT EXISTS (
            SELECT 1 FROM verify_scenario_results r
             WHERE r.card_id = v.card_id AND r.scenario_id = v.scenario_id
               AND r.outcome = 'passed' AND r.scenario_version = v.scenario_version)
        ORDER BY v.card_id, v.scenario_id`,
    )).rows.map((row) => ({
      invariant: "delivered-scenarios-were-verified",
      cardId: String(row.card_id),
      detail: `scenario ${String(row.scenario_id)} was delivered without a passing conclusion at its current version`,
    })),
  },
];

export async function checkInvariants(
  client: Client,
  invariants: readonly Invariant[] = FLOW_INVARIANTS,
): Promise<InvariantFinding[]> {
  const findings: InvariantFinding[] = [];
  for (const invariant of invariants) {
    // One broken check must not hide the others: an invariant that cannot run
    // is itself a finding, not a reason to report nothing.
    try {
      findings.push(...await invariant.check(client));
    } catch (error) {
      findings.push({
        invariant: invariant.name,
        cardId: null,
        detail: `check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return findings;
}
