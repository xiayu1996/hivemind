import type { Client, Row } from "@libsql/client";
import type { StoryProjectionPort } from "../orchestrator/story-worker.js";
import { NotionOutbox, payloadHash } from "./outbox.js";
import type { DesiredStoryPage } from "./blocks/story-page.js";
import schema from "./notion-schema.json" with { type: "json" };
import { STORY_BOARD_STATUS } from "./board-status.js";
import { storyIcon, stopReasonWord, stopSummaryLine, waitingText } from "./display-text.js";
import type { StopSummary } from "../orchestrator/stop-summary.js";
import { laneWord, type DesiredRound, type DesiredSpec } from "./blocks/story-render.js";
import { scenarioTitle } from "../pipeline/dod.js";
import { lintHumanSentence } from "../report/business-language.js";

interface VerificationBody {
  reasons?: Array<{ scenarioId: string; reason: string; detail?: string }>;
  validationErrors?: string[];
  uiReview?: {
    acceptance?: Array<{ id: string; status: string; reason?: string; detail?: string; cites?: string }>;
    findings?: Array<{ severity: string; note: string }>;
    amendments?: Array<{ scenarioId: string; observation: string }>;
    inconclusive?: string[];
  };
}

function value(input: unknown): string {
  return typeof input === "string" ? input : "";
}

export function notionAiStatusForState(state: string): string {
  if (state === "NEEDS_INPUT") return STORY_BOARD_STATUS.needsInput;
  if (state === "HUMAN_PARKED") return STORY_BOARD_STATUS.parked;
  if (state === "DELIVERED") return STORY_BOARD_STATUS.done;
  if (state === "FAILED") return STORY_BOARD_STATUS.failed;
  return state === "QUEUED" ? STORY_BOARD_STATUS.queued : STORY_BOARD_STATUS.running;
}

/** One board word per state the pipeline actually has, so the column reads as
 * the card's position rather than as a rough bucket. */
const PHASE_WORDS: Record<string, string> = {
  QUEUED: schema.options.phase[0]!,
  SHAPE: schema.options.phase[1]!,
  DESIGN: schema.options.phase[2]!,
  SPECIFY: schema.options.phase[3]!,
  CODE: schema.options.phase[4]!,
  VERIFY: schema.options.phase[5]!,
  REGRESSION_FIX: schema.options.phase[6]!,
  MERGE: schema.options.phase[7]!,
  DELIVERED: schema.options.phase[8]!,
};

/**
 * Where the card stands. A card waiting for a person, parked or failed is
 * still somewhere, and the state alone does not say where: `phase` holds what
 * was running and `resume_state` where it will pick up, so a stopped card
 * keeps showing the work it stopped in rather than falling back to the queue.
 */
function phase(story: Row): string {
  const direct = PHASE_WORDS[String(story.state)];
  if (direct) return direct;
  for (const candidate of [story.phase, story.resume_state]) {
    const word = candidate === null || candidate === undefined ? undefined : PHASE_WORDS[String(candidate)];
    if (word) return word;
  }
  return schema.options.phase[0]!;
}

/** One scenario as the page shows it. A DoD frozen before these columns
 * existed has only its id and text, and falls back to a numbered name rather
 * than to a machine translation of words nobody wrote. */
function desiredSpec(row: Row): DesiredSpec {
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
  const spec: DesiredSpec = {
    id: String(row.spec_id),
    seq: Number(row.seq),
    status: String(row.status),
    title: scenarioTitle({ title: value(row.title) || undefined }, Number(row.seq)),
  };
  const given = value(row.given);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- the columns are named after reserved words.
  const when = value(row.when_);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- the columns are named after reserved words.
  const then = value(row.then_);
  if (given) spec.given = given;
  if (when) spec.when = when;
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
  if (then) spec.then = then;
  if (row.layers) spec.layers = JSON.parse(String(row.layers)) as string[];
  return spec;
}

/** Builds a complete desired page from central truth and durably queues the projection. */
export class NotionStoryProjection implements StoryProjectionPort {
  private readonly outbox: NotionOutbox;

  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
    /** The inner-loop budget, so the page can say how much of it a person's last action bought. */
    private readonly innerLoopRounds: number = 6,
  ) {
    this.outbox = new NotionOutbox(client, this.now);
  }

  private async pageCreationPending(cardId: string): Promise<boolean> {
    const row = (await this.client.execute({
      sql: `SELECT 1 FROM notion_outbox
            WHERE card_id = ? AND operation = 'create_story_page' AND state = 'pending'`,
      args: [cardId],
    })).rows[0];
    return row !== undefined;
  }

  /** Pending projections queued against a page id the Story no longer has
   * (the synthetic one from before the page existed) can never be delivered. */
  private async dropStaleTargets(cardId: string, pageId: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM notion_outbox
            WHERE card_id = ? AND state = 'pending'
              AND operation IN ('sync_story_page', 'sync_story_properties')
              AND target NOT IN (?, ?)`,
      args: [cardId, `story-page:${pageId}`, `story-properties:${pageId}`],
    });
  }

  /**
   * The round as a table: one row per scenario, one column per lane. The
   * paragraph this replaces made a person read every scenario to find theirs,
   * and put the code-level reason in front of them whether they wanted it or
   * not -- that now lives under the technical heading.
   */
  private async roundDetail(cardId: string, latest: Record<string, unknown>): Promise<{
    round: DesiredRound;
    technical: string[];
  }> {
    const failed = new Set(JSON.parse(String(latest.failed_scenarios)) as string[]);
    const verdict = String(latest.verdict);
    const declared = (await this.client.execute({
      sql: "SELECT spec_id, seq, title FROM story_specs WHERE story_id = ? ORDER BY seq",
      args: [cardId],
    })).rows;
    const artifact = (await this.client.execute({
      sql: `SELECT body FROM phase_artifacts
            WHERE card_id = ? AND phase = 'VERIFY' AND kind = 'verification' AND round = ?
            ORDER BY id DESC LIMIT 1`,
      args: [cardId, Number(latest.round)],
    })).rows[0];
    const body = artifact ? JSON.parse(String(artifact.body)) as VerificationBody : {};
    const screen = new Map((body.uiReview?.acceptance ?? []).map((item) => [item.id, item]));
    const reasons = new Map((body.reasons ?? []).map((item) => [item.scenarioId, item]));
    const inconclusive = new Set(body.uiReview?.inconclusive ?? []);

    const rows = declared.map((row) => {
      const id = String(row.spec_id);
      const seen = screen.get(id);
      const note = seen?.reason ?? reasons.get(id)?.reason ?? "";
      return {
        scenario: `\u573a\u666f ${Number(row.seq)} \u00b7 ${scenarioTitle({ title: value(row.title) || undefined }, Number(row.seq))}`,
        test: laneWord(failed.has(id) ? "rejected" : "accepted"),
        screen: seen ? laneWord(seen.status === "passed" ? "accepted" : seen.status === "failed" ? "rejected" : "inconclusive")
          : inconclusive.has(id) ? laneWord("inconclusive") : "\u2014",
        note: lintHumanSentence("\u8bf4\u660e", note).length === 0 ? note : "",
      };
    });

    // A reason written for a debugger is not thrown away, it is put where a
    // person only sees it if they went looking.
    const technical: string[] = [];
    for (const [id, item] of reasons) {
      if (item.reason && lintHumanSentence("reason", item.reason).length > 0) technical.push(`${id}\uff1a${item.reason}`);
      if (item.detail) technical.push(`${id}\uff1a${item.detail}`);
    }
    for (const error of body.validationErrors ?? []) technical.push(error);

    return {
      round: {
        round: Number(latest.round),
        at: Number(latest.created_at ?? this.now()),
        verdict,
        passed: rows.length - rows.filter((row) => row.test === laneWord("rejected")).length,
        total: rows.length,
        rows,
        ...(body.uiReview?.findings && body.uiReview.findings.length > 0
          ? { findings: body.uiReview.findings.map((finding) => finding.note) }
          : {}),
      },
      technical,
    };
  }

  /** The newest body of one design artifact kind, or an empty row. */
  private async latestArtifact(cardId: string, kind: string): Promise<{ body?: unknown }> {
    const row = (await this.client.execute({
      sql: `SELECT body FROM phase_artifacts
            WHERE card_id = ? AND kind = ?
            ORDER BY round DESC, id DESC LIMIT 1`,
      args: [cardId, kind],
    })).rows[0];
    return { body: row?.body };
  }

  /** Scenario numbers and names, for text that has only ids to work with. */
  private async scenarioNames(cardId: string): Promise<Map<string, string>> {
    const rows = (await this.client.execute({
      sql: "SELECT spec_id, seq, title FROM story_specs WHERE story_id = ? ORDER BY seq",
      args: [cardId],
    })).rows;
    return new Map(rows.map((row) => [
      String(row.spec_id),
      `\u573a\u666f ${Number(row.seq)} \u00b7 ${scenarioTitle({ title: value(row.title) || undefined }, Number(row.seq))}`,
    ]));
  }

  /**
   * What the rounds since a person last acted added up to, in their words.
   *
   * The pieces are collected when the card stops, not read back from four
   * tables here: by the time a person opens the page the run is long over, and
   * the summary is what the alert and the friction record were written from
   * too. Only the rendering lives here, because the English report those read
   * is not what a person reads on a page.
   */
  private async stopSummaryLines(cardId: string): Promise<string[]> {
    const row = (await this.client.execute({
      sql: "SELECT stop_summary FROM stories WHERE id = ? AND stop_reason IS NOT NULL",
      args: [cardId],
    })).rows[0];
    const raw = value(row?.stop_summary);
    if (!raw) return [];
    const summary = JSON.parse(raw) as StopSummary;
    const names = await this.scenarioNames(cardId);
    const name = (id: string): string => names.get(id) ?? id;
    const lines: string[] = [];

    if (summary.diagnosis) {
      lines.push(stopSummaryLine(summary.diagnosis.side === "requirement" ? "requirementSide" : "systemSide"));
      if (summary.diagnosis.curve.length > 0) {
        lines.push(stopSummaryLine("curve", { curve: summary.diagnosis.curve.join(" \u2192 ") }));
      }
      if (summary.diagnosis.persistent.length > 0) {
        lines.push(stopSummaryLine("neverPassed", { scenarios: summary.diagnosis.persistent.map(name).join("\u3001") }));
      }
      if (summary.diagnosis.regressed.length > 0) {
        lines.push(stopSummaryLine("regressed", { scenarios: summary.diagnosis.regressed.map(name).join("\u3001") }));
      }
    }
    for (const bounce of summary.mergeBounces) {
      lines.push(bounce.attribution === "conflict"
        ? stopSummaryLine("mergeConflict")
        : stopSummaryLine("mergeBounce", { failures: bounce.failures.join("\u3001") || bounce.check || "" }));
    }
    for (const baseline of summary.baselineFailures) {
      lines.push(stopSummaryLine("baselineFailing", {
        check: baseline.check,
        failures: baseline.failures.join("\u3001"),
      }));
    }
    for (const refusal of summary.refusals) {
      lines.push(stopSummaryLine("refusal", { reason: refusal.reason }));
    }
    if (summary.dispatchFailures.length > 0) {
      lines.push(stopSummaryLine("dispatchFailed", { count: String(summary.dispatchFailures.length) }));
    }
    if (summary.inconclusive) {
      lines.push(stopSummaryLine("inconclusive", {
        attempts: String(summary.inconclusive.attempts),
        scenarios: summary.inconclusive.scenarios.join("\u3001"),
      }));
    }
    if (summary.budget !== undefined && summary.budget > 0) {
      lines.push(stopSummaryLine("budget", { spent: String(summary.spent), budget: String(summary.budget) }));
    }
    if (summary.costUsd > 0) lines.push(stopSummaryLine("spend", { amount: summary.costUsd.toFixed(2) }));
    return lines;
  }

  /**
   * What the page asks of a person, and nothing else: why the card stopped,
   * the questions still open with the answer SHAPE proposed, and how to reply.
   * Answers already given are folded away separately -- they are a record, not
   * a thing to do.
   */
  private async waitingSection(cardId: string, stopReason: string | undefined, action: string): Promise<string> {
    const lines: string[] = [];
    if (stopReason) lines.push(`\u8fd9\u5f20\u5361\u505c\u4e0b\u4e86\uff1a${stopReasonWord(stopReason)}\u3002`);
    const questions = (await this.client.execute({
      sql: `SELECT question_key, question, suggestion FROM open_questions
            WHERE card_id = ? AND blocking = 1 AND answer IS NULL ORDER BY id`,
      args: [cardId],
    })).rows;
    for (const [index, row] of questions.entries()) {
      lines.push(`${index + 1}. ${String(row.question)}`);
      const suggestion = value(row.suggestion);
      if (suggestion) lines.push(`   \u5efa\u8bae\u7684\u7b54\u6cd5\uff1a${suggestion}`);
      lines.push(`   \u56de\u7b54\u65f6\u5199\u300c${String(row.question_key)}\uff1a<\u4f60\u7684\u56de\u7b54>\u300d`);
    }
    // Every stop carries it, not only a spent verification loop: a card that
    // crashed its way to a ceiling, or one that ran out of money, is just as
    // unreadable as one word.
    if (stopReason) lines.push(...await this.stopSummaryLines(cardId));
    lines.push(action);
    return lines.join("\n");
  }

  /** How many rounds a person's last action has bought so far, and out of how
   * many. Merge bounces count: they come out of the same budget. */
  private async budgetLine(cardId: string, since: number): Promise<string> {
    const [verifications, bounces] = await this.client.batch([
      {
        sql: `SELECT COUNT(*) AS n FROM verify_records
              WHERE card_id = ? AND verdict = 'rejected' AND created_at > ?`,
        args: [cardId, since],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM event_log
              WHERE card_id = ? AND ts > ?
                AND type IN ('merge.verification_failed', 'merge.conflict')
                AND json_extract(data, '$.spent') = 1`,
        args: [cardId, since],
      },
    ], "read");
    const spent = Number(verifications!.rows[0]?.n ?? 0) + Number(bounces!.rows[0]?.n ?? 0);
    return `\u672c\u6bb5\u9884\u7b97 ${Math.min(spent, this.innerLoopRounds)}/${this.innerLoopRounds}`;
  }

  /**
   * The answers a person gave, as the page shows them: who, when, on which
   * item, and the words. An answer written on the person's behalf by an
   * operator is shown as exactly that, never as the person's.
   */
  private async appliedAnswers(cardId: string): Promise<string[]> {
    const rows = (await this.client.execute({
      sql: `SELECT COALESCE(ic.author, 'unknown') AS author, ic.created_time, hf.spec_id, hf.body,
                   hf.applied_at, hf.applied_round
            FROM human_feedback hf
            JOIN ingested_comments ic ON ic.comment_id = hf.comment_id
            WHERE hf.card_id = ? AND hf.channel = 'answer'
            ORDER BY ic.created_time, hf.id`,
      args: [cardId],
    })).rows;
    return rows.map((row) => {
      const when = new Date(Number(row.created_time)).toISOString().slice(0, 16).replace("T", " ");
      const target = row.spec_id ? `，针对 ${String(row.spec_id)}` : "";
      const state = row.applied_at ? `已用于第 ${Number(row.applied_round)} 轮` : "下一轮使用";
      return `- ${String(row.author)}（${when} UTC${target}，${state}）：${String(row.body)}`;
    });
  }

  async enqueue(cardId: string): Promise<void> {
    const storyResult = await this.client.execute({
      sql: `SELECT notion_page_id, state, phase, resume_state, inner_loop_rounds, stop_reason, mr_url,
                   human_wins_until, notion_ai_status_shadow, last_human_action_at
            FROM stories WHERE id = ?`,
      args: [cardId],
    });
    const story = storyResult.rows[0];
    if (!story) throw new Error(`Story does not exist: ${cardId}`);
    // The approval gate inserts a Story with a synthetic page id before Notion
    // has a page; projecting against it can only 404 and would poison the outbox.
    if (await this.pageCreationPending(cardId)) return;
    const pageId = String(story.notion_page_id);
    await this.dropStaleTargets(cardId, pageId);
    const [specs, design, technicalDesign, diagram, verification, cost] = await Promise.all([
      this.client.execute({
        sql: `SELECT spec_id, seq, status, title, given, when_, then_, layers
              FROM story_specs WHERE story_id = ? ORDER BY seq`,
        args: [cardId],
      }),
      this.latestArtifact(cardId, "design-summary"),
      this.latestArtifact(cardId, "design-technical"),
      this.latestArtifact(cardId, "design-diagram"),
      this.client.execute({
        sql: `SELECT round, verdict, failed_scenarios, created_at FROM verify_records
              WHERE card_id = ? ORDER BY round DESC LIMIT 1`,
        args: [cardId],
      }),
      this.client.execute({
        sql: "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_entries WHERE card_id = ?",
        args: [cardId],
      }),
    ]);
    const latest = verification.rows[0];
    const detail = latest ? await this.roundDetail(cardId, latest) : undefined;

    // A card speaks up when it has actually stopped and only a person can move
    // it on: one of the four stop reasons, or a card that failed. Everything
    // else is progress the board already shows, and a page that repeats it
    // spends attention for nothing.
    const state = String(story.state);
    const stopReason = story.stop_reason === null ? undefined : String(story.stop_reason);
    const situation = stopReason
      ?? (state === "FAILED" ? "failed" : state === "NEEDS_INPUT" ? "blocking_question" : undefined);
    const waiting = situation ? waitingText("story", situation) : undefined;
    const questions = waiting ? await this.waitingSection(cardId, stopReason, waiting.action) : undefined;
    const metadata = waiting
      ? [
          waiting.action,
          [
            `\u7b2c ${Number(story.inner_loop_rounds)} \u8f6e`,
            await this.budgetLine(cardId, Number(story.last_human_action_at ?? 0)),
            `\u8d39\u7528 $${Number(cost.rows[0]?.total ?? 0).toFixed(4)}`,
            ...(story.mr_url ? [`MR ${String(story.mr_url)}`] : []),
          ].join(" \u00b7 "),
        ].join("\n")
      : undefined;
    const answers = await this.appliedAnswers(cardId);

    const summary = value(design.body);
    const technical = [
      ...(value(technicalDesign.body) ? [value(technicalDesign.body)] : []),
      ...(detail?.technical ?? []),
      ...(story.mr_url ? [`MR\uff1a${String(story.mr_url)}`] : []),
      ...(stopReason ? [`\u505c\u70b9\uff1a${stopReason}`] : []),
    ];
    const desired: DesiredStoryPage = {
      ...(metadata ? { metadata } : {}),
      design: summary || "\u8bbe\u8ba1\u8fd8\u6ca1\u5199\u51fa\u6765\u3002",
      ...(questions ? { questions } : {}),
      specs: specs.rows.map(desiredSpec),
      ...(detail ? { verificationRound: detail.round } : {}),
    };
    await this.outbox.enqueue({
      cardId,
      priority: 2,
      operation: "sync_story_page",
      target: `story-page:${pageId}`,
      payload: {
        cardId,
        pageId,
        desired: {
          ...desired,
          ...(waiting ? { metadataIcon: waiting.icon, metadataColor: waiting.color } : {}),
          ...(value(diagram.body) ? { diagram: value(diagram.body) } : {}),
          ...(answers.length > 0 ? { answers } : {}),
          ...(technical.length > 0 ? { technical } : {}),
        },
      },
    });
    const names = schema.propertyNames;
    const aiStatus = notionAiStatusForState(String(story.state));
    const properties: Record<string, unknown> = {
      [names.aiStatus]: { select: { name: aiStatus } },
      [names.phase]: { select: { name: phase(story) } },
      [names.cost]: { number: Number(cost.rows[0]?.total ?? 0) },
      [names.rounds]: { number: Number(story.inner_loop_rounds) },
      [names.mergeRequest]: { url: story.mr_url ? String(story.mr_url) : null },
    };
    const icon = storyIcon(String(story.state));
    // The fingerprint stays in central truth: on the page it was a column a
    // person could read and edit, and neither is any use to them. The icon is
    // hashed with the properties so a card that only changed its face is still
    // written.
    const fingerprint = payloadHash({ ...properties, icon }).hash;
    if (Number(story.human_wins_until ?? 0) <= this.now()) {
      // The board shows the last status we wrote (the shadow). When it differs
      // from what the state now calls for, the page must be written even if
      // this exact payload went out once before an intermediate state.
      const boardDisagrees = story.notion_ai_status_shadow !== null && String(story.notion_ai_status_shadow) !== aiStatus;
      await this.outbox.enqueue({
        cardId,
        priority: 1,
        operation: "sync_story_properties",
        target: `story-properties:${pageId}`,
        payload: {
          cardId,
          pageId,
          fingerprint,
          icon,
          properties,
        },
        ...(boardDisagrees ? { resend: true } : {}),
      });
    }
  }
}
