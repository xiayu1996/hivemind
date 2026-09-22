import type { Client } from "@libsql/client";
import {
  type CurrentRoundBlocker,
  type CurrentRoundResultItem,
  type CurrentRoundSummary,
  type CurrentWorkDetailReadResult,
  type CurrentWorkReadPort,
  type HistoricalRoundReference,
  type RequirementTaskEntry,
  type RunningOverviewEntry,
  type RunningOverviewReadResult,
} from "./current-work-contracts.js";

/**
 * The ledger reads behind the running overview and the two detail screens.
 *
 * Everything here is a projection over rows the executor already writes: the
 * requirement's own decision chain (`requirement_clarify_rounds`,
 * `requirement_prds`, `requirement_solutions`, `requirement_prototypes`), the
 * rounds a card actually ran (`phase_runs`), the acceptance items each round
 * concluded (`verify_scenario_results`) and what it cost (`cost_entries`,
 * `requirement_cost_entries`). No read writes, and no read invents a value it
 * could not find: a round whose predecessor did not complete has no result,
 * and the screen says so rather than showing zero dollars and an empty win.
 */

/** Requirement states in which the system is still doing the work. Waiting on
 * a person is a different situation with its own screen. */
const RUNNING_REQUIREMENT_STATES = [
  "CLARIFY",
  "PRD_CONFIRM",
  "SOLUTION",
  "DECOMPOSING",
  "EXECUTING",
  "ACCEPTANCE",
] as const;

/** Story states in which work is moving. A parked card needs a person and a
 * delivered one is finished, so neither belongs on the running rail. */
const RUNNING_STORY_STATES = [
  "QUEUED",
  "SHAPE",
  "DESIGN",
  "SPECIFY",
  "CODE",
  "VERIFY",
  "MERGE",
  "REGRESSION_FIX",
] as const;

/** The phases a task moves through, in the words the screen uses. */
const STORY_PHASE_LABELS: Record<string, string> = {
  QUEUED: "排队中",
  SHAPE: "明确需求",
  DESIGN: "设计",
  SPECIFY: "写测试",
  CODE: "编写改动",
  VERIFY: "验证",
  MERGE: "合入",
  REGRESSION_FIX: "回归修复",
};

/**
 * The requirement's own work cycle. It is not a stored column: a requirement
 * moves through these milestones as its PRD, its solution and its prototype
 * come into being, and the current one is the last the ledger shows.
 */
const CLARIFY = "澄清需求";
const SOLUTION = "确定方案";
const PROTOTYPE = "绘制原型";
const EXECUTING = "拆解执行中";
const ACCEPTANCE = "待验收";

function placeholders(values: readonly string[]): { sql: string; args: string[] } {
  return { sql: values.map(() => "?").join(", "), args: [...values] };
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function storyPhaseLabel(phase: string, state: string): string {
  return STORY_PHASE_LABELS[phase] ?? STORY_PHASE_LABELS[state] ?? phase;
}

/** The milestone a requirement is in, and the round number it is. */
function requirementMilestone(state: string, hasPrototype: boolean): { round: number; phase: string } {
  if (state === "CLARIFY" || state === "PRD_CONFIRM") return { round: 1, phase: CLARIFY };
  if (state === "SOLUTION") {
    return hasPrototype ? { round: 3, phase: PROTOTYPE } : { round: 2, phase: SOLUTION };
  }
  if (state === "ACCEPTANCE" || state === "DONE") return { round: 5, phase: ACCEPTANCE };
  return { round: 4, phase: EXECUTING };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A body that will not parse is a body without the fields this screen
    // reads. Reporting the requirement as unreadable would hide every other
    // fact on the page behind one malformed revision.
    return {};
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function approachSummary(body: Record<string, unknown>): string | null {
  const approach = body.approach;
  if (typeof approach !== "object" || approach === null) return null;
  const summary = (approach as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.trim() !== "" ? summary.trim() : null;
}

function openDecisionQuestions(body: Record<string, unknown>): string[] {
  const decisions = body.openDecisions;
  if (!Array.isArray(decisions)) return [];
  return decisions.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() === "" ? [] : [entry.trim()];
    if (typeof entry !== "object" || entry === null) return [];
    const question = (entry as Record<string, unknown>).question;
    return typeof question === "string" && question.trim() !== "" ? [question.trim()] : [];
  });
}

/** A requirement's decision chain, folded away from its raw rows. */
interface RequirementArtifacts {
  solution: {
    body: Record<string, unknown>;
    createdAt: number;
    revisions: number;
  } | null;
  prototype: {
    body: Record<string, unknown>;
    createdAt: number;
    revisions: number;
  } | null;
  openQuestions: readonly string[];
}

/** One card's round, folded from the phase runs it wrote. */
interface CardRound {
  round: number;
  phase: string;
  startedAt: number;
}

function cardRounds(rows: readonly Record<string, unknown>[]): CardRound[] {
  const byRound = new Map<number, CardRound>();
  for (const row of rows) {
    const round = number(row.round);
    const startedAt = number(row.started_at);
    const current = byRound.get(round);
    if (current === undefined) {
      byRound.set(round, { round, phase: text(row.phase), startedAt });
      continue;
    }
    if (startedAt < current.startedAt) current.startedAt = startedAt;
    // The newest phase run names the phase the round reached.
    current.phase = text(row.phase);
  }
  return [...byRound.values()].toSorted((left, right) => left.round - right.round);
}

/** Reads the central ledger for the running overview and the detail screens. */
export class LibsqlCurrentWorkReadPort implements CurrentWorkReadPort {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async readRunningOverview(): Promise<RunningOverviewReadResult> {
    try {
      const requirementStates = placeholders(RUNNING_REQUIREMENT_STATES);
      const storyStates = placeholders(RUNNING_STORY_STATES);
      const [requirementRows, prototypeRows, storyRows] = await Promise.all([
        this.client.execute({
          sql: `SELECT id, title, state FROM requirements WHERE state IN (${requirementStates.sql})`,
          args: requirementStates.args,
        }),
        this.client.execute("SELECT DISTINCT requirement_id FROM requirement_prototypes"),
        this.client.execute({
          sql: `SELECT s.id, s.title, s.state, s.phase, e.requirement_id
                  FROM stories s JOIN epics e ON e.id = s.epic_id
                 WHERE s.state IN (${storyStates.sql})`,
          args: storyStates.args,
        }),
      ]);
      const withPrototype = new Set(prototypeRows.rows.map((row) => text(row.requirement_id)));

      const entries: RunningOverviewEntry[] = [
        ...requirementRows.rows.map((row) => ({
          kind: "requirement" as const,
          requirementId: text(row.id),
          title: text(row.title),
          state: "running" as const,
          phase: requirementMilestone(text(row.state), withPrototype.has(text(row.id))).phase,
        })),
        ...storyRows.rows.map((row) => ({
          kind: "task" as const,
          cardId: text(row.id),
          requirementId: text(row.requirement_id),
          title: text(row.title),
          state: "running" as const,
          phase: storyPhaseLabel(text(row.phase), text(row.state)),
        })),
      ].toSorted((left, right) => {
        const rank = left.kind === right.kind ? 0 : left.kind === "requirement" ? -1 : 1;
        if (rank !== 0) return rank;
        if (left.title !== right.title) return left.title < right.title ? -1 : 1;
        const leftId = left.kind === "requirement" ? left.requirementId : left.cardId;
        const rightId = right.kind === "requirement" ? right.requirementId : right.cardId;
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });

      return { kind: "ok", snapshot: { entries, generatedAt: this.now() } };
    } catch (cause) {
      return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async readRequirementDetail(requirementId: string): Promise<CurrentWorkDetailReadResult> {
    try {
      const requirementResult = await this.client.execute({
        sql: "SELECT id, title, state, created_at FROM requirements WHERE id = ?",
        args: [requirementId],
      });
      const row = requirementResult.rows[0];
      if (!row) return { kind: "not_found" };

      const id = text(row.id);
      const artifacts = await this.#requirementArtifacts(id);
      const milestone = requirementMilestone(text(row.state), artifacts.prototype !== null);
      const currentRound = await this.#requirementRoundSummary(id, number(row.created_at), artifacts, milestone.round, milestone.phase);

      return {
        kind: "ok",
        detail: {
          kind: "requirement",
          requirementId: id,
          title: text(row.title),
          state: "running",
          currentRound,
          historicalRounds: this.#requirementHistory(milestone.round, artifacts),
          tasks: await this.#runningTasksOf(id),
          generatedAt: this.now(),
        },
      };
    } catch (cause) {
      return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async readTaskDetail(cardId: string): Promise<CurrentWorkDetailReadResult> {
    try {
      const storyResult = await this.client.execute({
        sql: `SELECT s.id, s.title, s.state, s.phase, e.requirement_id, e.title AS requirement_title
                FROM stories s LEFT JOIN epics e ON e.id = s.epic_id
               WHERE s.id = ?`,
        args: [cardId],
      });
      const row = storyResult.rows[0];
      if (!row) return { kind: "not_found" };

      const storyId = text(row.id);
      const [runRows, resultRows, costRows] = await Promise.all([
        this.client.execute({
          sql: "SELECT round, phase, started_at FROM phase_runs WHERE card_id = ? ORDER BY round, started_at",
          args: [storyId],
        }),
        this.client.execute({
          sql: `SELECT v.round AS round, v.scenario_id AS scenario_id, v.outcome AS outcome,
                       COALESCE(s.text, v.scenario_id) AS text
                  FROM verify_scenario_results v
                  LEFT JOIN story_specs s ON s.story_id = v.card_id AND s.spec_id = v.scenario_id
                 WHERE v.card_id = ? AND v.carried_from IS NULL
                 ORDER BY v.round, COALESCE(s.seq, v.id), v.id`,
          args: [storyId],
        }),
        this.client.execute({
          sql: `SELECT r.round AS round, SUM(c.cost_usd) AS usd
                  FROM cost_entries c JOIN phase_runs r ON r.run_id = c.run_id
                 WHERE r.card_id = ? GROUP BY r.round`,
          args: [storyId],
        }),
      ]);

      const rounds = cardRounds(runRows.rows as Record<string, unknown>[]);
      const current = rounds.at(-1);
      const phase = storyPhaseLabel(text(row.phase), text(row.state));

      const summary: CurrentRoundSummary = current === undefined
        ? { round: 1, phase, results: [], blockers: [], costUsd: 0, startedAt: this.now() }
        : this.#taskRoundSummary(current, phase, resultRows.rows as Record<string, unknown>[], costRows.rows as Record<string, unknown>[]);

      return {
        kind: "ok",
        detail: {
          kind: "task",
          cardId: storyId,
          title: text(row.title),
          state: "running",
          currentRound: summary,
          historicalRounds: rounds
            .filter((round) => round.round !== summary.round)
            .map((round) => ({
              round: round.round,
              phase: storyPhaseLabel(round.phase, round.phase),
              trigger: round.round === 1 ? "first_run" as const : "rework" as const,
            })),
          parentRequirement: { requirementId: text(row.requirement_id), title: text(row.requirement_title) },
          generatedAt: this.now(),
        },
      };
    } catch (cause) {
      return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** This round's own acceptance items: the passed ones are what the round
   * achieved and the failed ones are what it is stuck on. */
  #taskRoundSummary(
    round: CardRound,
    phase: string,
    resultRows: readonly Record<string, unknown>[],
    costRows: readonly Record<string, unknown>[],
  ): CurrentRoundSummary {
    const results: CurrentRoundResultItem[] = [];
    const blockers: CurrentRoundBlocker[] = [];
    for (const row of resultRows) {
      if (number(row.round) !== round.round) continue;
      const item = { id: text(row.scenario_id), text: text(row.text) };
      if (text(row.outcome) === "failed") blockers.push({ blockerId: item.id, text: item.text });
      else results.push({ resultId: item.id, text: item.text });
    }
    const cost = costRows.find((row) => number(row.round) === round.round);
    return {
      round: round.round,
      phase,
      results,
      blockers,
      costUsd: number(cost?.usd),
      startedAt: round.startedAt,
    };
  }

  #requirementHistory(round: number, artifacts: RequirementArtifacts): HistoricalRoundReference[] {
    const phases = [CLARIFY, SOLUTION, PROTOTYPE, EXECUTING, ACCEPTANCE];
    const history: HistoricalRoundReference[] = [];
    for (let index = 1; index < round; index += 1) {
      const trigger: HistoricalRoundReference["trigger"] =
        index === 2 && (artifacts.solution?.revisions ?? 0) > 1
          ? "rework"
          : index === 3 && (artifacts.prototype?.revisions ?? 0) > 1
            ? "rework"
            : "first_run";
      history.push({ round: index, phase: phases[index - 1] ?? "", trigger });
    }
    return history;
  }

  async #requirementRoundSummary(
    requirementId: string,
    createdAt: number,
    artifacts: RequirementArtifacts,
    round: number,
    phase: string,
  ): Promise<CurrentRoundSummary> {
    const results: CurrentRoundResultItem[] = [];
    // What the current round has already achieved is the outcome its
    // predecessor left behind. A milestone whose predecessor did not complete
    // has no result yet, and the screen says that instead of showing an empty
    // win.
    if (round === 2) {
      results.push({ resultId: "clarify-complete", text: "需求说明已确认" });
    } else if (round >= 3 && artifacts.solution !== null) {
      const summary = approachSummary(artifacts.solution.body);
      if (summary !== null) results.push({ resultId: "solution-approach", text: summary });
    }

    const blockers: CurrentRoundBlocker[] = round === 2 && artifacts.solution !== null
      ? openDecisionQuestions(artifacts.solution.body).map((question, index) => ({
          blockerId: `open-decision-${index + 1}`,
          text: question,
        }))
      : round === 1
        ? artifacts.openQuestions.map((question, index) => ({ blockerId: `open-question-${index + 1}`, text: question }))
        : artifacts.prototype !== null
          ? stringList(artifacts.prototype.body.concerns).map((concern, index) => ({
              blockerId: `prototype-concern-${index + 1}`,
              text: concern,
            }))
          : [];

    const cost = await this.client.execute({
      sql: `SELECT SUM(amount_usd) AS usd FROM requirement_cost_entries
             WHERE requirement_id = ? AND round_id = ?`,
      args: [requirementId, String(round)],
    });

    const startedAt = round >= 3 && artifacts.prototype !== null
      ? artifacts.prototype.createdAt
      : round >= 2 && artifacts.solution !== null
        ? artifacts.solution.createdAt
        : createdAt;

    return { round, phase, results, blockers, costUsd: number(cost.rows[0]?.usd), startedAt };
  }

  async #requirementArtifacts(requirementId: string): Promise<RequirementArtifacts> {
    const [solutionRows, prototypeRows, questionRows] = await Promise.all([
      this.client.execute({
        sql: `SELECT revision, body, created_at FROM requirement_solutions
               WHERE requirement_id = ? ORDER BY revision`,
        args: [requirementId],
      }),
      this.client.execute({
        sql: `SELECT revision, body, created_at FROM requirement_prototypes
               WHERE requirement_id = ? ORDER BY revision`,
        args: [requirementId],
      }),
      this.client.execute({
        sql: `SELECT question FROM open_questions
               WHERE card_id = ? AND blocking = 1 AND answer IS NULL ORDER BY created_at, id`,
        args: [requirementId],
      }),
    ]);

    const latest = (rows: readonly Record<string, unknown>[]): Record<string, unknown> | undefined =>
      [...rows].toSorted((left, right) => number(left.revision) - number(right.revision)).at(-1);
    const highestRevision = (rows: readonly Record<string, unknown>[]): number =>
      rows.reduce((highest, row) => Math.max(highest, number(row.revision)), 0);

    const solutions = solutionRows.rows as Record<string, unknown>[];
    const prototypes = prototypeRows.rows as Record<string, unknown>[];
    const solution = latest(solutions);
    const prototype = latest(prototypes);

    return {
      solution: solution === undefined
        ? null
        : { body: objectBody(solution.body), createdAt: number(solution.created_at), revisions: highestRevision(solutions) },
      prototype: prototype === undefined
        ? null
        : { body: objectBody(prototype.body), createdAt: number(prototype.created_at), revisions: highestRevision(prototypes) },
      openQuestions: (questionRows.rows as Record<string, unknown>[]).map((row) => text(row.question)),
    };
  }

  async #runningTasksOf(requirementId: string): Promise<RequirementTaskEntry[]> {
    const storyStates = placeholders(RUNNING_STORY_STATES);
    const rows = await this.client.execute({
      sql: `SELECT s.id, s.title, e.requirement_id
              FROM stories s JOIN epics e ON e.id = s.epic_id
             WHERE e.requirement_id = ? AND s.state IN (${storyStates.sql})`,
      args: [requirementId, ...storyStates.args],
    });
    return (rows.rows as Record<string, unknown>[])
      .map((row) => ({
        kind: "task" as const,
        cardId: text(row.id),
        requirementId: text(row.requirement_id),
        title: text(row.title),
        state: "running" as const,
      }))
      .toSorted((left, right) => (left.title === right.title
        ? left.cardId.localeCompare(right.cardId)
        : left.title < right.title ? -1 : 1));
  }
}
