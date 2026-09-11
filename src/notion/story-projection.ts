import type { Client } from "@libsql/client";
import type { StoryProjectionPort } from "../orchestrator/story-worker.js";
import { NotionOutbox, payloadHash } from "./outbox.js";
import type { DesiredStoryPage } from "./blocks/story-page.js";
import schema from "./notion-schema.json" with { type: "json" };

/** Notion caps a rich text run at 2000 characters. */
const SUMMARY_LIMIT = 1900;

function value(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function richText(content: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content } }] };
}

export function notionAiStatusForState(state: string): string {
  const options = schema.options.aiStatus;
  if (state === "NEEDS_INPUT") return options[2]!;
  if (state === "HUMAN_PARKED") return options[4]!;
  if (state === "DELIVERED") return options[5]!;
  if (state === "FAILED") return options[6]!;
  return state === "QUEUED" ? options[0]! : options[1]!;
}

function phase(state: string): string {
  const options = schema.options.phase;
  if (state === "DESIGN") return options[1]!;
  if (state === "CODE" || state === "REGRESSION_FIX") return options[2]!;
  if (state === "VERIFY") return options[3]!;
  if (state === "MERGE" || state === "DELIVERED") return options[5]!;
  return options[0]!;
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
   * What a person reads about a round: which scenarios were looked at and what
   * was seen, in their words. An accepted round says what passed, not only
   * that nothing failed; a rejected one says, per scenario, what each lane saw
   * and which DoD sentence it rests on.
   */
  private async roundSummary(cardId: string, latest: Record<string, unknown>): Promise<string> {
    const failed = JSON.parse(String(latest.failed_scenarios)) as string[];
    const verdict = String(latest.verdict);
    const declared = (await this.client.execute({
      sql: "SELECT spec_id FROM story_specs WHERE story_id = ? ORDER BY seq",
      args: [cardId],
    })).rows.map((row) => String(row.spec_id));
    const artifact = (await this.client.execute({
      sql: `SELECT body FROM phase_artifacts
            WHERE card_id = ? AND phase = 'VERIFY' AND kind = 'verification' AND round = ?
            ORDER BY id DESC LIMIT 1`,
      args: [cardId, Number(latest.round)],
    })).rows[0];
    const body = artifact ? JSON.parse(String(artifact.body)) as {
      reasons?: Array<{ scenarioId: string; reason: string }>;
      validationErrors?: string[];
      uiReview?: {
        acceptance?: Array<{ id: string; status: string; reason?: string; cites?: string }>;
        findings?: Array<{ severity: string; note: string }>;
        amendments?: Array<{ scenarioId: string; observation: string }>;
        inconclusive?: string[];
      };
    } : {};
    const passed = declared.filter((id) => !failed.includes(id));
    const lines: string[] = [];
    if (verdict === "accepted") {
      // The UI lane's inconclusive scenarios never reject and never consume a
      // round, so the verdict hides them; the person still has to see which
      // screens nobody managed to look at.
      const unreviewed = body.uiReview?.inconclusive ?? [];
      const walkthrough = unreviewed.length > 0 ? `；走查无结论：${unreviewed.join("、")}` : "";
      lines.push(`通过：${passed.length} 个场景都验证通过${passed.length > 0 ? `（${passed.join("、")}）` : ""}${walkthrough}`);
    } else if (verdict === "inconclusive") {
      lines.push(`无结论：验证环境出了问题，不算这张卡的失败，也不消耗轮次${failed.length > 0 ? `（涉及 ${failed.join("、")}）` : ""}`);
    } else {
      lines.push(`未通过：${failed.length} 个场景被打回${passed.length > 0 ? `，${passed.length} 个通过（${passed.join("、")}）` : ""}`);
    }
    for (const id of failed) {
      const fromTests = (body.reasons ?? []).filter((item) => item.scenarioId === id).map((item) => `测试：${item.reason}`);
      const fromScreen = (body.uiReview?.acceptance ?? [])
        .filter((item) => item.id === id && item.status === "failed" && item.reason)
        .map((item) => `走查：${item.reason}${item.cites ? `（依据 DoD「${item.cites}」）` : ""}`);
      const why = [...fromTests, ...fromScreen];
      lines.push(`- ${id}：${why.length > 0 ? why.join("；") : "没有记录原因"}`);
    }
    if ((body.validationErrors ?? []).length > 0) lines.push(`代码校验拒绝了这些结论：${body.validationErrors!.join("；")}`);
    // The review's findings and amendments never rejected anything, so they
    // leave no trace in the verdict; a person still has to be told they exist
    // and that the card was not held for them.
    const findings = body.uiReview?.findings ?? [];
    if (findings.length > 0) {
      const major = findings.find((finding) => finding.severity === "major");
      lines.push(`界面走查 ${findings.length} 条（不影响验收）${major ? `，例如：${major.note}` : ""}`);
    }
    const amendments = body.uiReview?.amendments ?? [];
    if (amendments.length > 0) {
      lines.push(`走查提出了 DoD 没写的要求 ${amendments.length} 条，等你决定：${amendments.map((item) => `${item.scenarioId}：${item.observation}`).join("；")}`);
    }
    const summary = lines.join("\n");
    return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary;
  }

  /** How many rounds a person's last action has bought so far, and out of how many. */
  private async budgetLine(cardId: string, since: number): Promise<string> {
    const spent = Number((await this.client.execute({
      sql: `SELECT COUNT(*) AS n FROM verify_records
            WHERE card_id = ? AND verdict = 'rejected' AND created_at > ?`,
      args: [cardId, since],
    })).rows[0]?.n ?? 0);
    return `Budget ${Math.min(spent, this.innerLoopRounds)}/${this.innerLoopRounds}`;
  }

  /**
   * The answers a person gave, as the page shows them: who, when, on which
   * item, and the words. An answer written on the person's behalf by an
   * operator is shown as exactly that, never as the person's.
   */
  private async appliedAnswers(cardId: string): Promise<string[]> {
    const rows = (await this.client.execute({
      sql: `SELECT COALESCE(ic.author, 'unknown') AS author, ic.created_time, hf.spec_id, hf.body, hf.applied_at, hf.round
            FROM human_feedback hf
            JOIN ingested_comments ic ON ic.comment_id = hf.comment_id
            WHERE hf.card_id = ? AND hf.channel = 'answer'
            ORDER BY ic.created_time, hf.id`,
      args: [cardId],
    })).rows;
    return rows.map((row) => {
      const when = new Date(Number(row.created_time)).toISOString().slice(0, 16).replace("T", " ");
      const target = row.spec_id ? `，针对 ${String(row.spec_id)}` : "";
      const state = row.applied_at ? `已用于第 ${Number(row.round) + 1} 轮` : "下一轮使用";
      return `- ${String(row.author)}（${when} UTC${target}，${state}）：${String(row.body)}`;
    });
  }

  async enqueue(cardId: string): Promise<void> {
    const storyResult = await this.client.execute({
      sql: `SELECT notion_page_id, state, phase, inner_loop_rounds, stop_reason, mr_url,
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
    const [specs, design, verification, cost] = await Promise.all([
      this.client.execute({
        sql: "SELECT spec_id, seq, status, text FROM story_specs WHERE story_id = ? ORDER BY seq",
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT body FROM phase_artifacts
              WHERE card_id = ? AND kind = 'design-summary'
              ORDER BY round DESC, id DESC LIMIT 1`,
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT round, verdict, failed_scenarios FROM verify_records
              WHERE card_id = ? ORDER BY round DESC LIMIT 1`,
        args: [cardId],
      }),
      this.client.execute({
        sql: "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_entries WHERE card_id = ?",
        args: [cardId],
      }),
    ]);
    const latest = verification.rows[0];
    const roundSummary = latest ? await this.roundSummary(cardId, latest) : undefined;
    const stopText = story.stop_reason
      ? `Execution stopped: ${String(story.stop_reason)}` +
        (roundSummary && String(story.stop_reason) === "verify_loop_exceeded"
          ? `. Last verification round ${Number(latest!.round)}: ${roundSummary}`
          : "")
      : undefined;
    const answers = await this.appliedAnswers(cardId);
    const questions = [
      ...(stopText ? [stopText] : []),
      ...(answers.length > 0 ? [`已应用的回答：\n${answers.join("\n")}`] : []),
    ].join("\n\n");
    const desired: DesiredStoryPage = {
      metadata: [
        `Task ${cardId}`,
        `State ${String(story.state)}`,
        `Round ${Number(story.inner_loop_rounds)}`,
        await this.budgetLine(cardId, Number(story.last_human_action_at ?? 0)),
        `Cost $${Number(cost.rows[0]?.total ?? 0).toFixed(4)}`,
        ...(story.mr_url ? [`MR ${String(story.mr_url)}`] : []),
      ].join(" · "),
      design: value(design.rows[0]?.body) || "Design is pending.",
      ...(questions ? { questions } : {}),
      specs: specs.rows.map((row) => ({
        id: String(row.spec_id),
        seq: Number(row.seq),
        status: String(row.status),
        text: String(row.text),
      })),
      ...(latest && roundSummary ? {
        verificationRound: { round: Number(latest.round), summary: roundSummary },
      } : {}),
    };
    await this.outbox.enqueue({
      cardId,
      priority: 2,
      operation: "sync_story_page",
      target: `story-page:${pageId}`,
      payload: {
        cardId,
        pageId,
        desired,
      },
    });
    const names = schema.propertyNames;
    const aiStatus = notionAiStatusForState(String(story.state));
    const properties: Record<string, unknown> = {
      [names.aiStatus]: { select: { name: aiStatus } },
      [names.phase]: { select: { name: phase(String(story.state)) } },
      [names.cost]: { number: Number(cost.rows[0]?.total ?? 0) },
      [names.rounds]: { number: Number(story.inner_loop_rounds) },
      [names.mergeRequest]: { url: story.mr_url ? String(story.mr_url) : null },
    };
    const fingerprint = payloadHash(properties).hash;
    properties[names.syncFingerprint] = richText(fingerprint);
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
          properties,
        },
        ...(boardDisagrees ? { resend: true } : {}),
      });
    }
  }
}
