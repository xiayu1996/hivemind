import type { Client } from "@libsql/client";
import {
  judgeBusinessLanguage,
  renderRefusedLines,
  type BusinessLanguageJudgeSettings,
  type JudgedLine,
} from "../judge/business-language.js";
import {
  DEFAULT_MAX_STORIES,
  domainVocabulary,
  evaluateDecomposition,
  type DecompositionCandidate,
  type DecompositionLimits,
} from "./decompose.js";
import {
  judgeVerticalSlices,
  renderRefusedSlices,
  type VerticalSliceJudgeSettings,
} from "../judge/vertical-slice.js";
import {
  blockerAnswers,
  blockingQuestionStatement,
  planRevisionFeedback,
  withBlockerAnswers,
  withPlanRevisions,
} from "./epic-blocker.js";
import type { HumanQuestion } from "./human-question.js";
import type { PlanApprovalStore } from "./plan-approval.js";
import { epicTransitionStatement, type EpicState } from "./state-machine.js";

export interface DecomposeRequest {
  epicId: string;
  title: string;
  requirement: string;
  /** Why earlier attempts were refused, so the next one does not repeat them. */
  previousRejections: readonly string[];
  /** The Story ceiling this attempt is judged against. Carried in the request
   * rather than written into the phase prompt because it is configuration: a
   * prompt that says a limit exists without naming it asks the model to guess,
   * and the first Epic through this path guessed five against a limit of four. */
  maxStories: number;
}

export interface DecomposePort {
  run(input: DecomposeRequest): Promise<DecompositionCandidate>;
}

/**
 * The attempt produced no candidate the contract recognises. From the Epic's
 * side this is the same thing as a split that broke a rule -- the model did not
 * hand back a usable one -- so it is a refusal the loop tells the model about
 * and counts, not an exception. Thrown as an error only because there is no
 * candidate to return. Everything else the port throws (a provider that
 * refused, a runner that could not start) stays an exception: it says nothing
 * about the split, and the breaker upstream is what reads it.
 */
export class DecompositionContractError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "DecompositionContractError";
  }
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

/**
 * The ceiling on attempts, not the budget. What ends the loop early is the same
 * invariant the inner loop converges on: a set of reasons that repeats means
 * the next attempt is one already made. Two fixed attempts stopped three Epics
 * of one requirement on 2026-09-18 while every attempt was still making
 * progress -- the first spent on id shapes nothing had ever stated, the second
 * on the business language those ids had been hiding.
 */
const MAX_ATTEMPTS = 4;

/** True when this round's refusals are ones no earlier round already made. */
function isNewRefusal(seen: Set<string>, reasons: readonly string[]): boolean {
  const signature = [...new Set(reasons)].toSorted().join("\n");
  if (seen.has(signature)) return false;
  seen.add(signature);
  return true;
}

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
    const requirement = withPlanRevisions(
      withBlockerAnswers(epic.requirement, await blockerAnswers(this.client, epic.id)),
      // What a person said was wrong with the last plan. Without it this is a
      // blind retry: the same requirement produces the same split, and they
      // watch the plan they rejected come back.
      await planRevisionFeedback(this.client, epic.id),
    );

    // Words the person used are the product's own vocabulary, so a Story may
    // use them back. Read from the requirement the attempts are given, which
    // includes what they answered and what they asked to be changed.
    const vocabulary = domainVocabulary(requirement);

    const seen = new Set<string>();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let candidate: DecompositionCandidate;
      try {
        candidate = await this.port.run({
          epicId: epic.id,
          title: epic.title,
          requirement,
          previousRejections: [...rejections],
          maxStories: this.limits.maxStories ?? DEFAULT_MAX_STORIES,
        });
      } catch (cause) {
        if (!(cause instanceof DecompositionContractError)) throw cause;
        // Counted like any other refusal, so the ceiling and the "must not
        // repeat" rule apply. Without this the Epic stayed in DECOMPOSE and
        // every cycle paid the brain tier to be handed the same unparseable
        // answer, with nothing on the board for a person to see.
        rejections.push(cause.reason);
        if (!isNewRefusal(seen, [cause.reason])) break;
        continue;
      }
      const evaluated = evaluateDecomposition(candidate, this.limits, vocabulary);

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
          ...await this.judgeLanguage(epic.id, candidate, vocabulary),
          ...await this.judgeSlices(epic.id, candidate),
        ];
        if (refused.length > 0) {
          rejections.push(...refused);
          if (!isNewRefusal(seen, refused)) break;
          continue;
        }
        await this.approvals.present({
          epicId: epic.id,
          notionPageId: epic.notionPageId,
          title: epic.title,
          plan: candidate,
          vocabulary,
        });
        return { kind: "presented", stories: evaluated.stories.length };
      }
      rejections.push(...evaluated.reasons);
      if (!isNewRefusal(seen, evaluated.reasons)) break;
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
  private async judgeLanguage(
    epicId: string,
    candidate: DecompositionCandidate,
    vocabulary: ReadonlySet<string>,
  ): Promise<string[]> {
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
      vocabulary,
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
