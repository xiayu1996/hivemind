import type { Client } from "@libsql/client";
import {
  judgeBusinessLanguage,
  renderRefusedLines,
  type BusinessLanguageJudgeSettings,
  type JudgedLine,
} from "../judge/business-language.js";
import { evaluateDecomposition, type DecompositionCandidate, type DecompositionLimits } from "./decompose.js";
import {
  judgeVerticalSlices,
  renderRefusedSlices,
  type VerticalSliceJudgeSettings,
} from "../judge/vertical-slice.js";
import { blockerAnswers, blockingQuestionStatement, withBlockerAnswers } from "./epic-blocker.js";
import type { HumanQuestion } from "./human-question.js";
import type { PlanApprovalStore } from "./plan-approval.js";
import { epicTransitionStatement, type EpicState } from "./state-machine.js";

export interface DecomposeRequest {
  epicId: string;
  title: string;
  requirement: string;
  /** Why earlier attempts were refused, so the next one does not repeat them. */
  previousRejections: readonly string[];
}

export interface DecomposePort {
  run(input: DecomposeRequest): Promise<DecompositionCandidate>;
}

export interface EpicIntake {
  id: string;
  notionPageId: string;
  title: string;
  requirement: string;
}

export type DecomposeOutcome =
  | { kind: "presented"; stories: number }
  | { kind: "rejected"; reasons: readonly string[] }
  | { kind: "blocking_question"; question: HumanQuestion };

/**
 * What the judge adds to the deterministic checks, and where the count of its
 * additions goes. Every field is optional: a deployment without the credential
 * leaves them all out and the checks are the whole answer.
 */
export interface DecomposeJudgement {
  /** Refuses construction language the seventeen-word table cannot see. */
  language?: BusinessLanguageJudgeSettings | undefined;
  /** Refuses a Story that is a step the team takes rather than a thing a person does. */
  slice?: VerticalSliceJudgeSettings | undefined;
  /** How often the checks missed, so the questions earn their place on
   * measurement rather than on the arguments that made them. */
  recordFriction?: (input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>;
}

const MAX_ATTEMPTS = 2;

/**
 * Produces the decomposition the approval gate waits for. Nothing else in the
 * system creates one, so an Epic without this never leaves intake.
 */
export class EpicDecomposer {
  constructor(
    private readonly client: Client,
    private readonly approvals: PlanApprovalStore,
    private readonly port: DecomposePort,
    private readonly now: () => number = Date.now,
    /** The Story-count ceiling, from `decompose.maxStoriesPerEpic`. */
    private readonly limits: DecompositionLimits = {},
    private readonly judged: DecomposeJudgement = {},
  ) {}

  async decompose(epic: EpicIntake): Promise<DecomposeOutcome> {
    await this.enterDecompose(epic.id);
    const rejections: string[] = [];
    // A question asked on an earlier pass and answered since is part of the
    // requirement now; without it the same question would stop this pass too.
    const requirement = withBlockerAnswers(epic.requirement, await blockerAnswers(this.client, epic.id));

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await this.port.run({
        epicId: epic.id,
        title: epic.title,
        requirement,
        previousRejections: [...rejections],
      });
      const evaluated = evaluateDecomposition(candidate, this.limits);

      if (evaluated.kind === "blocking_question") {
        // The one stop the decomposition is allowed to take: a missing fact that
        // would change the split. Guessing past it produces plausible Stories
        // for the wrong requirement.
        await this.block(epic.id, `blocking question: ${evaluated.question.question}`, evaluated.question);
        // The board is where the person will read it; a stop only in the log
        // is a stop nobody answers.
        await this.client.execute(blockingQuestionStatement(epic.id, evaluated.question, this.now()));
        return { kind: "blocking_question", question: evaluated.question };
      }
      if (evaluated.kind === "accepted") {
        // Only what the word table let through is put to the judge, and only a
        // refusal is added. It runs here rather than inside
        // `evaluateDecomposition` because that function is pure and synchronous
        // and everything else in the system depends on it staying that way.
        const refused = [
          ...await this.judgeLanguage(epic.id, candidate),
          ...await this.judgeSlices(epic.id, candidate),
        ];
        if (refused.length > 0) {
          rejections.push(...refused);
          continue;
        }
        await this.approvals.present({
          epicId: epic.id,
          notionPageId: epic.notionPageId,
          title: epic.title,
          plan: candidate,
        });
        return { kind: "presented", stories: evaluated.stories.length };
      }
      rejections.push(...evaluated.reasons);
    }

    await this.block(epic.id, `decomposition rejected: ${rejections.join("; ")}`);
    return { kind: "rejected", reasons: rejections };
  }

  /**
   * The lines a person will read, put to the judge one at a time. The word
   * table has already refused what it recognises, and those lines are not
   * asked about: it is the floor, so every refusal it makes today it still
   * makes. A judge that is missing, slow or unsure adds nothing, which is
   * today's behaviour.
   *
   * The refusals join `previousRejections`, so the next attempt is told what
   * was wrong in the same breath as the table's own reasons. They are never
   * persisted, so no prompt is ever rebuilt from a judged answer.
   */
  private async judgeLanguage(epicId: string, candidate: DecompositionCandidate): Promise<string[]> {
    const settings = this.judged.language;
    if (!settings?.judge) return [];
    const lines: JudgedLine[] = [{ field: "business goal", line: 1, text: candidate.businessGoal }];
    for (const story of candidate.stories) {
      const prefix = `Story ${story.id}`;
      lines.push(
        { field: `${prefix} title`, line: 1, text: story.title },
        { field: `${prefix} requirement`, line: 1, text: story.requirement },
        { field: `${prefix} user entry point`, line: 1, text: story.userEntryPoint },
        { field: `${prefix} verification path`, line: 1, text: story.verificationPath },
      );
      for (const scenario of story.scenarios) {
        const field = `${prefix} scenario ${scenario.id}`;
        lines.push(
          { field: `${field} given`, line: 1, text: scenario.given },
          { field: `${field} when`, line: 1, text: scenario.when },
          { field: `${field} then`, line: 1, text: scenario.then },
        );
      }
    }
    const judgement = await judgeBusinessLanguage(settings.judge, lines, {
      model: settings.model,
      threshold: settings.threshold,
    });
    if (judgement.moved.length > 0) {
      await this.judged.recordFriction?.({
        cardId: epicId,
        runId: `epic:${epicId}`,
        kind: "decompose_language_judged",
        detail: renderRefusedLines(judgement.moved),
      });
    }
    return judgement.issues.map((issue) => `${issue.field} line ${issue.line} ${issue.reason}`);
  }

  /**
   * Each Story put to the judge on its own. The non-empty checks and the
   * shared-entry-point check have already refused what they can see; this asks
   * the one thing they cannot, which is whether the sentence they found means
   * anything. Nothing is subtracted, and a missing judge adds nothing.
   */
  private async judgeSlices(epicId: string, candidate: DecompositionCandidate): Promise<string[]> {
    const settings = this.judged.slice;
    if (!settings?.judge) return [];
    const judgement = await judgeVerticalSlices(settings.judge, candidate.stories, {
      model: settings.model,
      threshold: settings.threshold,
    });
    if (judgement.moved.length > 0) {
      await this.judged.recordFriction?.({
        cardId: epicId,
        runId: `epic:${epicId}`,
        kind: "decompose_slice_judged",
        detail: renderRefusedSlices(judgement.moved),
      });
    }
    return [...judgement.reasons];
  }

  private async enterDecompose(epicId: string): Promise<void> {
    const state = await this.stateOf(epicId);
    if (state === "DECOMPOSE") return;
    await this.transition(epicId, state, "DECOMPOSE");
  }

  private async block(epicId: string, reason: string, question?: HumanQuestion): Promise<void> {
    const state = await this.stateOf(epicId);
    await this.transition(epicId, state, "BLOCKED", reason, question);
  }

  private async stateOf(epicId: string): Promise<EpicState> {
    const row = (await this.client.execute({
      sql: "SELECT state FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!row) throw new Error(`Epic ${epicId} does not exist`);
    return String(row.state) as EpicState;
  }

  private async transition(
    epicId: string,
    from: EpicState,
    to: EpicState,
    reason?: string,
    question?: HumanQuestion,
  ): Promise<void> {
    const time = this.now();
    const runId = `epic:${epicId}`;
    const [update] = await this.client.batch([
      epicTransitionStatement({ epicId, from, to, at: time }),
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, 'DECOMPOSE', 'epic.transition', ?, ?)`,
        args: [runId, runId, time, JSON.stringify({ from, to, ...(reason ? { reason } : {}), ...(question ? { question } : {}) })],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`Epic ${epicId} left ${from} while it was being decomposed`);
    }
  }
}
