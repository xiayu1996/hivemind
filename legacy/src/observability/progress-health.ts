import type { Client } from "@libsql/client";
import { describeOrphanedCard, readOrphanedCards, type OrphanedRegressionCard } from "../regression/orphaned-cards.js";

/**
 * Whether the service is getting work done, as distinct from being up.
 *
 * A resident process answers "is it alive" by existing, and it kept existing
 * through every stall this system has had: a card parked behind a
 * misclassified browser error, a regression sweep the cycle could not reach, an
 * Epic waiting on coverage nothing was producing. None of those stop the
 * process, and none of them reach a person on their own. These are the signals
 * that separate the two, read from the database rather than from a pid.
 */

export interface ProgressThresholds {
  /** How long a card may sit in a working phase before the host is not working. */
  idleWorkingMs: number;
  /** How long a Notion write may wait in the outbox before the board is stale. */
  outboxBacklogMs: number;
  /** How long a card may wait for a person before that wait is worth naming. */
  awaitingPersonMs: number;
}

export const DEFAULT_PROGRESS_THRESHOLDS: ProgressThresholds = {
  idleWorkingMs: 30 * 60_000,
  outboxBacklogMs: 15 * 60_000,
  awaitingPersonMs: 60 * 60_000,
};

export interface WorkingCard {
  cardId: string;
  state: string;
  updatedAt: number;
  /**
   * Whether this card holds a live lease, which is what it means for it to be
   * running rather than queued. A host runs `schedule.maxConcurrentStories` at
   * a time, so a card can sit in CODE for half a day with nothing wrong: the
   * slots are taken. Reported as idle time, that is indistinguishable from the
   * stall this probe exists to find.
   */
  running: boolean;
}

export interface StoppedCard {
  cardId: string;
  stopReason: string;
  updatedAt: number;
}

export interface WaitingEpic {
  epicId: string;
  /** Scenarios registered under it with no passing run at any revision. */
  unprovenScenarios: number;
}

export interface UnmergeableEpic {
  epicId: string;
  /** Why the last attempt to bring main into the Epic branch did not work. */
  reason: string;
  at: number;
}

export interface ProgressSnapshot {
  workingCards: readonly WorkingCard[];
  stoppedCards: readonly StoppedCard[];
  waitingEpics: readonly WaitingEpic[];
  unmergeableEpics: readonly UnmergeableEpic[];
  /** Creation time of the oldest Notion write still pending, if any. */
  oldestPendingOutboxAt: number | null;
  /** Open regression cards no sweep can ever close, because their scenario has
   * left the pool. Reported, never counted: the predicate knows the card is
   * orphaned and cannot know whether it deserves closing. */
  orphanedCards: readonly OrphanedRegressionCard[];
  /** Scenarios in the registry. Zero means nothing is owed a sweep yet. */
  registeredScenarios: number;
  regressionRunsEver: number;
  lastPassingRegressionAt: number | null;
}

export type FindingSeverity = "stalled" | "waiting" | "queued" | "orphaned";

export interface ProgressFinding {
  severity: FindingSeverity;
  /** Business language: what is not moving, and who or what it waits on. */
  summary: string;
}

export interface ProgressReport {
  findings: readonly ProgressFinding[];
  /**
   * Nothing is stuck. Cards waiting on a person, cards queued behind the host's
   * concurrency limit, and orphaned regression cards are reported but not
   * counted: none of them is a thing the service could do differently.
   */
  healthy: boolean;
}

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

/**
 * Reads a snapshot into findings. Pure, so the thresholds and the wording are
 * testable without a database and without waiting for real time to pass.
 */
export function assessProgress(
  snapshot: ProgressSnapshot,
  now: number,
  thresholds: ProgressThresholds = DEFAULT_PROGRESS_THRESHOLDS,
): ProgressReport {
  const findings: ProgressFinding[] = [];

  // A card in a working phase that has not moved. The phase itself can be long
  // - a model turn takes minutes - so this is about a card that stopped
  // changing, not about one that is slow.
  //
  // Holding a slot is what makes idle time a fault. A card without a live
  // lease while another card has one is queued behind the host's concurrency
  // limit, which is the configured behaviour and not a stall; a card without
  // one while nothing at all is running is the dispatch failure this probe is
  // for, and it is named as that rather than as slowness.
  const anyRunning = snapshot.workingCards.some((card) => card.running);
  for (const card of snapshot.workingCards) {
    const age = now - card.updatedAt;
    if (age < thresholds.idleWorkingMs) continue;
    if (card.running) {
      findings.push({
        severity: "stalled",
        summary: `${card.cardId} has held a slot in ${card.state} for ${minutes(age)} minutes without changing. The host is running but this card is not moving.`,
      });
      continue;
    }
    findings.push(anyRunning
      ? {
        severity: "queued",
        summary: `${card.cardId} has waited ${minutes(age)} minutes in ${card.state} for a free slot on this host.`,
      }
      : {
        severity: "stalled",
        summary: `${card.cardId} has been in ${card.state} for ${minutes(age)} minutes and nothing at all is running on this host. Nothing is picking it up.`,
      });
  }

  // Waiting on a person is a designed stop, not a fault. It is still reported,
  // because a stop nobody was told about is indistinguishable from a stall.
  for (const card of snapshot.stoppedCards) {
    const age = now - card.updatedAt;
    if (age >= thresholds.awaitingPersonMs) {
      findings.push({
        severity: "waiting",
        summary: `${card.cardId} has been waiting ${minutes(age)} minutes for a person (${card.stopReason}).`,
      });
    }
  }

  // An Epic held at its own gate is correct behaviour once, and a stall if the
  // thing that would satisfy it never runs.
  for (const epic of snapshot.waitingEpics) {
    findings.push({
      severity: "waiting",
      summary: `Epic ${epic.epicId} cannot open its review request: ${epic.unprovenScenarios} of its scenarios have never passed a regression run.`,
    });
  }

  // A review request that cannot be merged is not waiting on a person: the
  // person cannot act until somebody brings main into the branch, and the last
  // attempt to do that failed.
  for (const epic of snapshot.unmergeableEpics) {
    findings.push({
      severity: "stalled",
      summary: `Epic ${epic.epicId} cannot take main into its branch: ${epic.reason}. Its review request cannot be merged until that is resolved.`,
    });
  }

  // Only meaningful once something is registered: a board with no scenarios
  // owes no evidence, and calling that a stall teaches whoever reads this
  // report to skim it.
  if (snapshot.registeredScenarios > 0) {
    if (snapshot.regressionRunsEver === 0) {
      findings.push({
        severity: "stalled",
        summary: "No regression run has ever been recorded, so every Epic gate is waiting on evidence nothing is producing.",
      });
    } else if (snapshot.lastPassingRegressionAt === null) {
      findings.push({
        severity: "stalled",
        summary: "Regression sweeps have run but none has ever passed, so no Epic can be shown to integrate.",
      });
    }
  }

  // A card no sweep can close does not stop anything on its own -- the Epic
  // gate reaches cards through the registry, so an orphan does not hold a
  // review request either -- but nothing else mentions it, and the Story it
  // owns re-enters the regression loop against it until the reopen budget is
  // gone. Naming it is the whole fix; closing it is a person's judgement.
  for (const card of snapshot.orphanedCards) {
    findings.push({ severity: "orphaned", summary: describeOrphanedCard(card) });
  }

  if (snapshot.oldestPendingOutboxAt !== null) {
    const age = now - snapshot.oldestPendingOutboxAt;
    if (age >= thresholds.outboxBacklogMs) {
      findings.push({
        severity: "stalled",
        summary: `The oldest unsent Notion write is ${minutes(age)} minutes old, so the board no longer shows what the system is doing.`,
      });
    }
  }

  return { findings, healthy: !findings.some((finding) => finding.severity === "stalled") };
}

/**
 * When a card last did something, as distinct from when its row was last
 * written.
 *
 * `stories.updated_at` answers the second question. The board poller reads
 * every active page each cycle and writes the requirement text back whether or
 * not it changed, so every card's row is touched every couple of minutes and
 * the idle check below could never fire: S-R237511TD-02 sat in CODE for four
 * hours and forty-five minutes without a single run while this probe reported
 * nothing. The event log holds what the card actually did, indexed by
 * (card_id, ts), and a card with no events yet falls back to its row.
 */
const MOVED_AT = `COALESCE(
      (SELECT MAX(e.ts) FROM event_log e WHERE e.card_id = s.id),
      s.updated_at
    ) AS moved_at`;

export async function readProgressSnapshot(client: Client, now: number = Date.now()): Promise<ProgressSnapshot> {
  // A lease that has not expired is what "running" means here. Released
  // leases keep their row with an expiry in the past, so the comparison is
  // against the clock rather than against the row existing.
  const leased = new Set((await client.execute({
    sql: "SELECT card_id FROM leases WHERE expires_at > ?",
    args: [now],
  })).rows.map((row) => String(row.card_id)));

  const working = (await client.execute(
    `SELECT s.id, s.state, ${MOVED_AT} FROM stories s
      WHERE s.state IN ('DESIGN','CODE','VERIFY','MERGE','REGRESSION_FIX') ORDER BY moved_at`,
  )).rows.map((row) => ({
    cardId: String(row.id),
    state: String(row.state),
    updatedAt: Number(row.moved_at),
    running: leased.has(String(row.id)),
  }));

  const stopped = (await client.execute(
    `SELECT s.id, s.stop_reason, ${MOVED_AT} FROM stories s
      WHERE s.state IN ('NEEDS_INPUT','HUMAN_PARKED') AND s.stop_reason IS NOT NULL ORDER BY moved_at`,
  )).rows.map((row) => ({
    cardId: String(row.id),
    stopReason: String(row.stop_reason),
    updatedAt: Number(row.moved_at),
  }));

  // An Epic every Story has delivered is one whose review request is due; the
  // gate holds it until its scenarios have passed somewhere.
  const waitingEpics = (await client.execute(
    `SELECT e.id AS epic_id, COUNT(r.scenario_id) AS unproven
       FROM epics e
       JOIN scenario_registry r ON r.epic_id = e.id
      WHERE e.state = 'EXECUTING'
        AND e.mr_url IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.epic_id = e.id AND s.state <> 'DELIVERED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM regression_runs u
           WHERE u.scenario_id = r.scenario_id AND u.outcome = 'passed'
        )
      GROUP BY e.id
      ORDER BY e.id`,
  )).rows.map((row) => ({
    epicId: String(row.epic_id),
    unprovenScenarios: Number(row.unproven),
  }));

  // The latest refresh outcome per Epic that is still open, and only when that
  // outcome is a failure: a conflict recorded and then resolved is history.
  const unmergeableEpics = (await client.execute(
    `SELECT e.id AS epic_id, f.failure_reason, f.ts
       FROM epics e
       JOIN epic_branch_refresh_events f ON f.id = (
         SELECT id FROM epic_branch_refresh_events
          WHERE epic_id = e.id AND outcome IN ('succeeded','failed')
          ORDER BY ts DESC, id DESC LIMIT 1
       )
      WHERE e.state IN ('EXECUTING','EPIC_ACCEPT') AND f.outcome = 'failed'
      ORDER BY e.id`,
  )).rows.map((row) => ({
    epicId: String(row.epic_id),
    reason: String(row.failure_reason ?? "the reason was not recorded"),
    at: Number(row.ts),
  }));

  const oldestPending = (await client.execute(
    "SELECT MIN(created_at) AS oldest FROM notion_outbox WHERE state = 'pending'",
  )).rows[0]?.oldest;

  const orphanedCards = await readOrphanedCards(client);

  const registered = Number((await client.execute(
    "SELECT COUNT(*) AS count FROM scenario_registry",
  )).rows[0]?.count ?? 0);

  const runs = Number((await client.execute(
    "SELECT COUNT(*) AS count FROM regression_runs",
  )).rows[0]?.count ?? 0);

  const lastPass = (await client.execute(
    "SELECT MAX(ts) AS ts FROM regression_runs WHERE outcome = 'passed'",
  )).rows[0]?.ts;

  return {
    workingCards: working,
    stoppedCards: stopped,
    waitingEpics,
    unmergeableEpics,
    oldestPendingOutboxAt: typeof oldestPending === "number" ? oldestPending : null,
    orphanedCards,
    registeredScenarios: registered,
    regressionRunsEver: runs,
    lastPassingRegressionAt: typeof lastPass === "number" ? lastPass : null,
  };
}

/** One screen: what is stuck, what is waiting, and nothing else. */
export function renderProgressReport(report: ProgressReport): string {
  if (report.findings.length === 0) return "Everything is moving: no card, Epic or board write is stuck.";
  const stalled = report.findings.filter((finding) => finding.severity === "stalled");
  const waiting = report.findings.filter((finding) => finding.severity === "waiting");
  const queued = report.findings.filter((finding) => finding.severity === "queued");
  const orphaned = report.findings.filter((finding) => finding.severity === "orphaned");
  const lines: string[] = [];
  if (stalled.length > 0) {
    lines.push("Stuck:", ...stalled.map((finding) => `  ${finding.summary}`));
  }
  if (queued.length > 0) {
    lines.push("Queued behind the host's concurrency limit:", ...queued.map((finding) => `  ${finding.summary}`));
  }
  if (waiting.length > 0) {
    lines.push("Waiting on a person or on evidence:", ...waiting.map((finding) => `  ${finding.summary}`));
  }
  if (orphaned.length > 0) {
    lines.push("Regression cards no sweep can close:", ...orphaned.map((finding) => `  ${finding.summary}`));
  }
  return lines.join("\n");
}
