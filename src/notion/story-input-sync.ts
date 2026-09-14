import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { z } from "zod";
import type { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import type { StoryState } from "../orchestrator/state-machine.js";
import { phaseContract } from "../pipeline/phase-contract.js";
import { isStoryPhase, type StoryPhase } from "../pipeline/phase.js";
import { CommentIngestor } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";
import {
  interpretComment,
  interpretPropertyChange,
} from "./intent-interpreter.js";
import schema from "./notion-schema.json" with { type: "json" };
import { readStoryContent, type NotionStoryApi } from "./story-intake.js";
import { notionAiStatusForState } from "./story-projection.js";

const pageSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
}).passthrough();
const selectSchema = z.object({
  type: z.literal("select"),
  select: z.object({ name: z.string().min(1) }).nullable(),
}).passthrough();

export interface StoryPropertyPollResult {
  cardId: string;
  intent: "initialized" | "none" | "park" | "resume" | "continue_development" | "unsupported_property_change";
}

export interface StoryCommentPollResult {
  ingested: number;
  materialized: number;
  resumed: number;
  /** Cards a person sent back to an earlier phase. */
  reworked: number;
  /** Regression cards a person opened by reporting a defect. */
  defects: number;
}

/** The comment channels, one per intent, using the values the table allows. */
const CHANNEL_OF: Record<"answer_blocker" | "rework" | "defect" | "feedback", string> = {
  answer_blocker: "answer",
  rework: "rework",
  defect: "defect",
  // Not a request for anything: it becomes material for the next round.
  feedback: "preference",
};

function state(value: unknown): StoryState {
  if (typeof value !== "string") throw new Error("Story state is invalid");
  return value as StoryState;
}

/** Turns Notion's human-owned fields and comments into central state exactly once. */
export class NotionStoryInputSync {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly storyApi: NotionStoryApi,
    private readonly comments: CommentIngestor,
    private readonly store: StoryExecutionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async pollProperties(pageId: string): Promise<StoryPropertyPollResult> {
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(pageId)}`,
      priority: "interaction",
    });
    const page = pageSchema.parse(response.data);
    const parsedStatus = selectSchema.safeParse(page.properties[schema.propertyNames.aiStatus]);
    const observed = parsedStatus.success ? parsedStatus.data.select?.name : undefined;
    const row = (await this.client.execute({
      sql: `SELECT id, state, resume_state, notion_ai_status_shadow
            FROM stories WHERE notion_page_id = ?`,
      args: [pageId],
    })).rows[0];
    if (!row) throw new Error(`Notion page is not an ingested Story: ${pageId}`);
    const cardId = String(row.id);
    // A freshly created page has no status until the first property projection
    // lands; there is nothing a person could have changed yet.
    if (!observed) return { cardId, intent: "initialized" };
    const internalState = state(row.state);
    const persistedShadow = row.notion_ai_status_shadow === null ? null : String(row.notion_ai_status_shadow);
    const shadow = persistedShadow ?? notionAiStatusForState(internalState);
    if (persistedShadow === null) {
      await this.client.execute({
        sql: "UPDATE stories SET notion_ai_status_shadow = ? WHERE id = ?",
        args: [shadow, cardId],
      });
      if (shadow === observed) return { cardId, intent: "initialized" };
    }

    const resumeState = row.resume_state === null ? undefined : state(row.resume_state);
    const time = this.now();
    const intent = interpretPropertyChange({
      shadowAiStatus: shadow,
      observedAiStatus: observed,
      internalState,
      ...(resumeState ? { parkedPreviousState: resumeState } : {}),
      now: time,
    });
    if (intent.type === "none") return { cardId, intent: "none" };

    if (intent.type === "park") {
      if (internalState === "DELIVERED" || internalState === "FAILED") {
        await this.rememberHumanObservation(cardId, observed, intent.humanWinsUntil, time);
        return { cardId, intent: "unsupported_property_change" };
      }
      await this.store.applyHumanTransition({
        cardId,
        expectedFrom: internalState,
        to: "HUMAN_PARKED",
        observedAiStatus: observed,
        humanWinsUntil: intent.humanWinsUntil,
        runId: `notion-property:${cardId}:${randomUUID()}`,
      });
    } else if (intent.type === "resume") {
      await this.store.applyHumanTransition({
        cardId,
        expectedFrom: "HUMAN_PARKED",
        to: intent.state,
        observedAiStatus: observed,
        humanWinsUntil: intent.humanWinsUntil,
        runId: `notion-property:${cardId}:${randomUUID()}`,
        parkedResumeState: intent.state,
      });
    } else if (intent.type === "continue_development") {
      // A stop in VERIFY or MERGE is answered in CODE: neither of those phases
      // may change code, so sending the card back there would only stop it again.
      const target = internalState === "NEEDS_INPUT"
        ? resumeState === "VERIFY" || resumeState === "MERGE" ? "CODE" : resumeState
        : internalState === "MERGE"
          ? "CODE"
          : internalState === "DELIVERED"
            // A delivered card reenters at SPECIFY: whatever is being continued
            // needs a test before it needs an implementation.
            ? "SPECIFY"
            : undefined;
      if (target) {
        await this.store.applyHumanTransition({
          cardId,
          expectedFrom: internalState,
          to: target,
          observedAiStatus: observed,
          humanWinsUntil: intent.humanWinsUntil,
          runId: `notion-property:${cardId}:${randomUUID()}`,
        });
      } else {
        await this.rememberHumanObservation(cardId, observed, intent.humanWinsUntil, time);
      }
    } else {
      await this.rememberHumanObservation(cardId, observed, intent.humanWinsUntil, time);
    }
    return { cardId, intent: intent.type };
  }

  async pollContent(pageId: string): Promise<void> {
    const content = await readStoryContent(this.storyApi, pageId);
    const story = (await this.client.execute({
      sql: "SELECT id FROM stories WHERE notion_page_id = ?",
      args: [pageId],
    })).rows[0];
    if (!story) throw new Error(`Notion page is not an ingested Story: ${pageId}`);
    const cardId = String(story.id);
    const statements: InStatement[] = [{
      sql: "UPDATE stories SET requirement = ?, updated_at = ? WHERE id = ?",
      args: [content.requirement, this.now(), cardId],
    }];
    for (const [section, anchor] of Object.entries(content.sections)) {
      if (!anchor) continue;
      statements.push({
        sql: `INSERT INTO notion_sections (story_id, section, anchor_block_id)
              VALUES (?, ?, ?)
              ON CONFLICT(story_id, section) DO UPDATE SET anchor_block_id = excluded.anchor_block_id`,
        args: [cardId, section, anchor],
      });
    }
    await this.client.batch(statements, "write");
  }

  async pollComments(pageId: string): Promise<StoryCommentPollResult> {
    const polled = await this.comments.pollPage(pageId);
    const pending = (await this.client.execute({
      sql: `SELECT ic.comment_id, ic.block_id, ic.body, s.id AS card_id, s.state,
                   s.inner_loop_rounds
            FROM ingested_comments ic
            JOIN stories s ON s.notion_page_id = ic.page_id
            LEFT JOIN human_feedback hf ON hf.comment_id = ic.comment_id
            WHERE ic.page_id = ? AND hf.comment_id IS NULL
            ORDER BY ic.created_time, ic.comment_id`,
      args: [pageId],
    })).rows;
    const statements: InStatement[] = [];
    /** Which question a keyed answer names, kept until the feedback is applied. */
    const questionKeys = new Map<string, string>();
    for (const item of pending) {
      const cardId = String(item.card_id);
      const blockId = item.block_id === null ? null : String(item.block_id);
      const spec = blockId ? (await this.client.execute({
        sql: "SELECT spec_id FROM story_specs WHERE story_id = ? AND notion_block_id = ?",
        args: [cardId, blockId],
      })).rows[0] : undefined;
      const interpreted = interpretComment(state(item.state), String(item.body));
      if (interpreted.type === "answer_blocker" && interpreted.questionKey) {
        questionKeys.set(String(item.comment_id), interpreted.questionKey);
      }
      statements.push({
        sql: `INSERT INTO human_feedback
                (comment_id, card_id, spec_id, round, channel, body, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(comment_id) DO NOTHING`,
        args: [
          String(item.comment_id),
          cardId,
          spec ? String(spec.spec_id) : null,
          Number(item.inner_loop_rounds),
          CHANNEL_OF[interpreted.type],
          interpreted.body,
          this.now(),
        ],
      });
    }
    if (statements.length > 0) await this.client.batch(statements, "write");

    const unapplied = (await this.client.execute({
      sql: `SELECT hf.id, hf.comment_id, hf.card_id, hf.channel, hf.body, hf.spec_id
            FROM human_feedback hf
            JOIN stories s ON s.id = hf.card_id
            JOIN ingested_comments ic ON ic.comment_id = hf.comment_id
            WHERE ic.page_id = ? AND hf.applied_at IS NULL AND hf.channel IN ('answer', 'rework', 'defect')
            ORDER BY hf.id`,
      args: [pageId],
    })).rows;
    let resumed = 0;
    let reworked = 0;
    let defects = 0;
    for (const feedback of unapplied) {
      const cardId = String(feedback.card_id);
      const commentId = String(feedback.comment_id);
      const specId = feedback.spec_id === null ? null : String(feedback.spec_id);
      const runId = `notion-comment:${commentId}:${randomUUID()}`;
      const current = await this.store.getStory(cardId);
      let acted = false;
      if (feedback.channel === "answer" && current.state === "NEEDS_INPUT" && current.resumeState) {
        acted = await this.applyAnswer(cardId, current, String(feedback.body), questionKeys.get(commentId), runId);
        if (acted) resumed++;
      } else if (feedback.channel === "rework") {
        acted = await this.applyRework(cardId, current, String(feedback.body), runId);
        if (acted) reworked++;
      } else if (feedback.channel === "defect") {
        acted = await this.applyDefect(cardId, current, specId, String(feedback.body), runId);
        if (acted) defects++;
      }
      // Marked only when it actually did something. The card page says "used in
      // round N" from this column, and saying that about a comment nothing has
      // read yet is a lie a person acts on.
      if (acted) {
        await this.client.execute({
          sql: "UPDATE human_feedback SET applied_at = ?, applied_round = ? WHERE id = ? AND applied_at IS NULL",
          args: [this.now(), current.innerLoopRounds + 1, Number(feedback.id)],
        });
      }
    }
    return { ingested: polled.inserted, materialized: pending.length, resumed, reworked, defects };
  }

  /**
   * A person answered. The answer is attached to the question it settles, and
   * the card resumes where it stopped.
   *
   * A card stopped on a blocking question resumes only once the answer has
   * somewhere to go: resuming without attaching it would re-run SHAPE, find the
   * same question unanswered and stop again on the next turn, having paid for
   * the phase.
   */
  private async applyAnswer(
    cardId: string,
    current: { state: StoryState; resumeState: StoryState | null; stopReason: string | null },
    body: string,
    questionKey: string | undefined,
    runId: string,
  ): Promise<boolean> {
    const open = await this.store.unansweredBlockingQuestions(cardId);
    if (open.length > 0) {
      // With several questions open the answer has to name one. Resuming with
      // it attached to nothing would re-run the phase, find the same questions
      // unanswered and stop again, having paid for the turn.
      const key = questionKey ?? (open.length === 1 ? open[0] : undefined);
      if (!key || !open.includes(key)) return false;
      await this.store.answerOpenQuestion(cardId, key, body);
    }
    const target = current.resumeState === "VERIFY" ? "CODE" : current.resumeState!;
    await this.store.transition(cardId, "NEEDS_INPUT", target, "human", runId);
    return true;
  }

  /**
   * A person refused the phase's approach. The result is invalidated and the
   * card goes back to the phase that owns the decision, which is the same path
   * the system takes when a contract check throws a result away -- one road, so
   * the card's history reads the same whoever refused it.
   */
  private async applyRework(
    cardId: string,
    current: { state: StoryState; phase: StoryPhase | null },
    reason: string,
    runId: string,
  ): Promise<boolean> {
    const phase = current.phase ?? (isStoryPhase(current.state) ? current.state : null);
    if (!phase) return false;
    const target = phaseContract(phase).rejectReturnsTo;
    if (!target) return false;
    await this.store.invalidateLatestPhase(cardId, phase, `a person refused this result: ${reason}`);
    if (current.state === "NEEDS_INPUT") {
      await this.store.transition(cardId, "NEEDS_INPUT", target, "human", runId);
    } else if (current.state !== target) {
      await this.store.transition(cardId, current.state, target, "human", runId);
    }
    return true;
  }

  /**
   * A person reported something broken in delivered work. It becomes a
   * regression card, which is the same object the sweep raises, so the fix goes
   * down the path that writes a reproduction test before it writes a fix.
   */
  private async applyDefect(
    cardId: string,
    current: { state: StoryState },
    specId: string | null,
    body: string,
    runId: string,
  ): Promise<boolean> {
    const scenarioId = await this.store.defectScenario(cardId, specId, body);
    if (!scenarioId) return false;
    await this.store.openRegressionCard({ cardId, scenarioId, signature: body.slice(0, 500) });
    if (current.state === "DELIVERED") {
      await this.store.transition(cardId, "DELIVERED", "SPECIFY", "human", runId);
      await this.store.markNarrowSpecify(cardId);
    }
    return true;
  }

  private async rememberHumanObservation(
    cardId: string,
    observedAiStatus: string,
    humanWinsUntil: number,
    time: number,
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE stories SET notion_ai_status_shadow = ?, human_wins_until = ?,
              last_human_action_at = ?, updated_at = ? WHERE id = ?`,
      args: [observedAiStatus, humanWinsUntil, time, time, cardId],
    });
  }
}
