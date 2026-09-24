import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { judgeApprovals, renderMovedApprovals, type ApprovalJudgeSettings } from "../judge/approval-intent.js";
import type { AcceptanceChecklist } from "../orchestrator/acceptance-checklist.js";
import type { RequirementStore } from "../orchestrator/requirement-store.js";
import { floorToNotionMinute } from "./comment-ingest.js";
import type { CommentIngestor } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";
import { solutionBlocks, solutionConfirmLine } from "./blocks/requirement-page.js";
import { buildRequirementPage } from "./requirement-projection.js";
import { interpretRequirementComment, interpretRequirementPropertyChange } from "./intent-interpreter.js";
import schema from "./notion-schema.json" with { type: "json" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RequirementPropertyPollResult {
  requirementId: string;
  intent:
    | "initialized"
    | "none"
    | "approve_prd"
    | "approve_solution"
    | "accept"
    | "park"
    | "resume"
    | "unsupported_property_change";
  applied: boolean;
}

export interface RequirementCommentPollResult {
  ingested: number;
  prdConfirmed: boolean;
  solutionConfirmed: boolean;
  revisionRequested: boolean;
  /** A person answered a stopped requirement; the loop may pick it up again. */
  resumed: boolean;
}

const pageSchema = z.object({ properties: z.record(z.string(), z.unknown()) }).passthrough();
const blockListSchema = z.object({
  results: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
  has_more: z.boolean().default(false),
  next_cursor: z.string().nullable().default(null),
}).passthrough();
const toDoSchema = z.object({
  to_do: z.object({
    checked: z.boolean(),
    rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();
const selectSchema = z.object({ select: z.object({ name: z.string() }).nullable() });

function runId(requirementId: string): string {
  return `requirement:${requirementId}`;
}

/**
 * Reads what a person did on their requirement page and turns it into the
 * two inputs the product manager layer accepts from them: a verdict on the
 * PRD, and parking. Scenario verdicts are made on each Epic, where the person
 * saw the delivery, and this layer only ever reads them back. Clarification
 * answers are not read here; the clarification channel owns those. The one
 * exception is a stopped requirement: whatever a person writes after the stop
 * is the answer the system stopped for, and reading it here is what lets the
 * requirement move again.
 *
 * Every decision is claimed under an event id before it acts, so the same
 * comment or tick seen by a webhook and by the fallback poll counts once.
 */
export class NotionRequirementInputSync {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly comments: CommentIngestor,
    private readonly store: RequirementStore,
    private readonly checklist: AcceptanceChecklist,
    private readonly now: () => number = Date.now,
    /** Left out where there is no credential; the whitelist then answers alone. */
    private readonly approvalJudge: ApprovalJudgeSettings | undefined = undefined,
    /** How often the whitelist missed an approval, so the question earns its
     * place on measurement rather than on the argument that made it. */
    private readonly recordFriction:
      | ((input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>)
      | undefined = undefined,
  ) {}

  async pollProperties(requirementId: string): Promise<RequirementPropertyPollResult> {
    const requirement = await this.store.getRequirement(requirementId);
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(requirement.notionPageId)}`,
      priority: "interaction",
    });
    const observed = selectSchema.parse(
      pageSchema.parse(response.data).properties[schema.propertyNames.requirementStatus],
    ).select?.name;
    if (!observed) return { requirementId, intent: "none", applied: false };

    const row = (await this.client.execute({
      sql: "SELECT notion_status_shadow FROM requirements WHERE id = ?",
      args: [requirementId],
    })).rows[0];
    if (row?.notion_status_shadow === null) {
      // The first look establishes what the column showed before anyone acted;
      // reading it as a drag would apply a change nobody made.
      await this.client.execute({
        sql: "UPDATE requirements SET notion_status_shadow = ? WHERE id = ?",
        args: [observed, requirementId],
      });
      return { requirementId, intent: "initialized", applied: false };
    }
    const shadow = String(row?.notion_status_shadow);
    const intent = interpretRequirementPropertyChange(
      shadow,
      observed,
      requirement.state,
      requirement.resumeState ?? undefined,
      this.now(),
    );
    if (intent.type === "none") return { requirementId, intent: "none", applied: false };

    let applied = false;
    if (intent.type === "approve_prd") {
      const prd = await this.store.getPrd(requirementId);
      if (prd?.status === "draft") {
        applied = await this.store.confirmPrd(
          requirementId, prd.revision, `notion-property:${requirementId}:${randomUUID()}`, "drag", runId(requirementId),
        );
      }
    } else if (intent.type === "approve_solution") {
      const solution = await this.store.getSolution(requirementId);
      if (solution?.status === "draft") {
        applied = await this.store.confirmSolution(
          requirementId, solution.revision, `notion-property:${requirementId}:${randomUUID()}`, "drag", runId(requirementId),
        );
      }
    } else if (intent.type === "accept") {
      // Dragging the whole card to accepted is a verdict on every scenario
      // still waiting for one.
      for (const item of await this.store.acceptanceItems(requirementId)) {
        if (item.status !== "open") continue;
        applied = (await this.store.decideAcceptanceItem(
          requirementId, item.itemId, "accepted",
          `notion-property:${requirementId}:${item.itemId}:${randomUUID()}`, "drag", runId(requirementId),
        )) || applied;
      }
    } else if (intent.type === "park") {
      await this.store.transition(requirementId, requirement.state, "HUMAN_PARKED", "human", runId(requirementId));
      applied = true;
    } else if (intent.type === "resume") {
      await this.store.transition(requirementId, "HUMAN_PARKED", intent.state, "human", runId(requirementId), intent.state);
      applied = true;
    }
    await this.client.execute({
      sql: `UPDATE requirements SET notion_status_shadow = ?, human_wins_until = ?,
            last_human_action_at = ?, updated_at = ? WHERE id = ?`,
      args: [observed, intent.humanWinsUntil, this.now(), this.now(), requirementId],
    });
    return { requirementId, intent: intent.type, applied };
  }

  async pollComments(requirementId: string): Promise<RequirementCommentPollResult> {
    const requirement = await this.store.getRequirement(requirementId);
    const pageId = requirement.notionPageId;
    const anchors = (await this.client.execute({
      sql: "SELECT anchor_block_id FROM requirement_notion_sections WHERE requirement_id = ?",
      args: [requirementId],
    })).rows.map((row) => String(row.anchor_block_id));
    await this.comments.registerPage(pageId, anchors);
    const polled = await this.comments.pollPage(pageId);
    const result: RequirementCommentPollResult = {
      ingested: polled.inserted,
      prdConfirmed: false,
      solutionConfirmed: false,
      revisionRequested: false,
      resumed: false,
    };

    if (requirement.stopReason) {
      result.resumed = await this.resumeFromComments(requirementId, pageId);
      return result;
    }

    // The PRD and the solution are read the same way: one draft on the page,
    // an approval that ends the reading, and everything else travelling
    // together into the rewrite.
    if (requirement.state === "PRD_CONFIRM") {
      const verdict = await this.readDraftVerdict(requirementId, pageId, "PRD_CONFIRM");
      result.prdConfirmed = verdict.confirmed;
      result.revisionRequested = verdict.revisionRequested;
      return result;
    }
    if (requirement.state === "SOLUTION") {
      const verdict = await this.readDraftVerdict(requirementId, pageId, "SOLUTION");
      result.solutionConfirmed = verdict.confirmed;
      result.revisionRequested = verdict.revisionRequested;
      return result;
    }

    return result;
  }

  /**
   * The boxes in the solution section. A tick is the third way a person
   * approves a solution, beside a comment and a column, and it is the only one
   * that can say which forks they read: the confirmation counts only once every
   * open decision above it is ticked, which is what the box's own line says.
   *
   * An unticked box is the absence of a verdict, never a refusal -- that has to
   * be said in words, and those words already reach the revision path.
   */
  async pollContent(requirementId: string): Promise<{ confirmed: boolean }> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state !== "SOLUTION" || requirement.stopReason) return { confirmed: false };
    const solution = await this.store.getSolution(requirementId);
    if (solution?.status !== "draft") return { confirmed: false };

    const wanted = buildRequirementPage({
      requirement,
      clarify: await this.store.clarifyHistory(requirementId),
      prd: await this.store.getPrd(requirementId),
      acceptance: await this.store.acceptanceItems(requirementId),
      solution,
      prototype: await this.store.getSolutionPrototype(requirementId, solution.revision),
    }).solution;
    if (!wanted) return { confirmed: false };

    const boxes = solutionBlocks(wanted).filter((entry) => entry.kind === "todo").map((entry) => entry.line);
    const confirmLine = solutionConfirmLine();
    const ticked = await this.tickedBoxes(requirement.notionPageId);
    // Every fork first, then the confirmation: a page that asked a question and
    // took a tick beside it as an answer to something else would be reading a
    // gesture the person did not make.
    const undecided = boxes.filter((line) => line !== confirmLine && !ticked.has(line));
    const confirmBlockId = ticked.get(confirmLine);
    if (undecided.length > 0 || confirmBlockId === undefined) return { confirmed: false };
    const confirmed = await this.store.confirmSolution(
      requirementId,
      solution.revision,
      `notion-check:${confirmBlockId}`,
      "check",
      runId(requirementId),
    );
    return { confirmed };
  }

  /** The ticked boxes on the page, by the line each one carries. */
  private async tickedBoxes(pageId: string): Promise<Map<string, string>> {
    const ticked = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const suffix = cursor
        ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : "?page_size=100";
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encodeURIComponent(pageId)}/children${suffix}`,
        priority: "interaction",
      });
      const page = blockListSchema.parse(response.data);
      for (const block of page.results) {
        if (block.type !== "to_do") continue;
        const parsed = toDoSchema.safeParse(block);
        if (!parsed.success || !parsed.data.to_do.checked) continue;
        const line = parsed.data.to_do.rich_text.map((run) => run.plain_text).join("");
        if (!ticked.has(line)) ticked.set(line, block.id);
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return ticked;
  }

  private async readDraftVerdict(
    requirementId: string,
    pageId: string,
    state: "PRD_CONFIRM" | "SOLUTION",
  ): Promise<{ confirmed: boolean; revisionRequested: boolean }> {
    const prd = state === "PRD_CONFIRM";
    const draft = (await this.client.execute({
      sql: prd
        ? `SELECT revision, created_at FROM requirement_prds
             WHERE requirement_id = ? AND status = 'draft' ORDER BY revision DESC LIMIT 1`
        : `SELECT revision, created_at FROM requirement_solutions
             WHERE requirement_id = ? AND status = 'draft' ORDER BY revision DESC LIMIT 1`,
      args: [requirementId],
    })).rows[0];
    if (!draft) return { confirmed: false, revisionRequested: false };
    const revision = Number(draft.revision);
    const unclaimed = await this.unclaimedComments(pageId, Number(draft.created_at));
    const approving = await this.judgeApprovals(requirementId, state, unclaimed);
    const revisions: Array<{ id: string; body: string }> = [];
    let confirmed = false;
    for (const comment of unclaimed) {
      const intent = interpretRequirementComment(state, comment.body, approving);
      if ((intent.type === "approve_prd" || intent.type === "approve_solution") && revisions.length === 0) {
        confirmed = prd
          ? await this.store.confirmPrd(requirementId, revision, comment.id, "comment", runId(requirementId))
          : await this.store.confirmSolution(requirementId, revision, comment.id, "comment", runId(requirementId));
        break;
      }
      if (intent.type === "request_revision" || intent.type === "request_solution_revision") {
        revisions.push({ id: comment.id, body: intent.body });
      }
    }
    if (confirmed || revisions.length === 0) return { confirmed, revisionRequested: false };
    // Everything the person wrote about this draft travels together into the
    // rewrite; one comment superseding the draft must not drop the rest.
    const [first, ...rest] = revisions;
    const body = revisions.map((item) => item.body).join("\n");
    const revisionRequested = prd
      ? await this.store.requestPrdRevision(requirementId, revision, body, first!.id, "comment", runId(requirementId))
      : await this.store.requestSolutionRevision(requirementId, revision, body, first!.id, "comment", runId(requirementId));
    for (const item of rest) {
      await this.store.claimApprovalEvent(requirementId, item.id, prd ? "prd_revision" : "solution_revision", "comment");
    }
    return { confirmed, revisionRequested };
  }

  /**
   * Asks the judge about the comments the whitelist did not read as approvals,
   * and about nothing else: a comment it already matches is an approval today
   * and stays one, so the judge can only add. An absent, slow or unsure judge
   * leaves every comment exactly where the whitelist put it, which is a
   * rewrite the person did not ask for -- what happens today on every wording
   * the four strings miss.
   */
  private async judgeApprovals(
    requirementId: string,
    state: "PRD_CONFIRM" | "SOLUTION",
    comments: readonly { id: string; body: string }[],
  ): Promise<ReadonlySet<string>> {
    const settings = this.approvalJudge;
    if (!settings?.judge) return new Set();
    const unrecognised = comments
      .filter((comment) => {
        const type = interpretRequirementComment(state, comment.body).type;
        return type !== "approve_prd" && type !== "approve_solution";
      })
      .map((comment) => comment.body);
    if (unrecognised.length === 0) return new Set();
    const judgement = await judgeApprovals(
      settings.judge,
      unrecognised,
      state === "PRD_CONFIRM" ? "PRD" : "solution",
      { model: settings.model, threshold: settings.threshold },
    );
    if (judgement.moved.length > 0) {
      await this.recordFriction?.({
        cardId: requirementId,
        runId: runId(requirementId),
        kind: "notion_approval_judged",
        detail: renderMovedApprovals(judgement.moved),
      });
    }
    return judgement.approving;
  }

  /**
   * A stopped requirement resumes on the first human comment written after the
   * stop. The comments are archived as one more clarification round whose
   * question is the stop itself, because the clarification history is what
   * every product manager step reads back in; an answer kept anywhere else
   * would clear the stop and then be ignored.
   */
  private async resumeFromComments(requirementId: string, pageId: string): Promise<boolean> {
    const stop = await this.store.latestStop(requirementId);
    if (!stop) return false;
    const answers = await this.unclaimedComments(pageId, stop.stoppedAt);
    if (answers.length === 0) return false;
    // An author the user directory could not resolve is stored as the raw
    // Notion user id. That id means nothing to a reader, so the answer is
    // attributed to nobody rather than to a string of hex.
    const bodies = answers.map((comment) =>
      UUID.test(comment.author) ? comment.body : `${comment.author}: ${comment.body}`);
    const open = await this.store.latestClarifyRound(requirementId);
    if (open && open.answers === null) {
      await this.store.recordClarifyAnswers(requirementId, open.round, bodies, runId(requirementId));
    } else {
      const round = await this.store.openClarifyRound(
        requirementId, [`系统停下等你回答：${stop.detail}`], runId(requirementId),
      );
      await this.store.recordClarifyAnswers(requirementId, round, bodies, runId(requirementId));
    }
    // Spent: the same words must not be read a second time as PRD feedback.
    for (const comment of answers) {
      await this.store.claimApprovalEvent(requirementId, comment.id, "resume_answer", "comment");
    }
    return this.store.clearStop(requirementId, runId(requirementId));
  }

  /**
   * Comments this requirement has not acted on yet, written no earlier than
   * `after`. Two conditions because two clocks of different resolution meet
   * here: Notion's minute-granular created_time answers "was this written
   * before the draft", and our own ingested_at answers "had we already seen it"
   * — the first alone would sweep in page chatter that predates the draft by
   * more than a minute, the second alone would sweep in everything a first poll
   * discovers at once.
   */
  private async unclaimedComments(
    pageId: string,
    after: number,
  ): Promise<Array<{ id: string; blockId: string | null; author: string; body: string }>> {
    const rows = (await this.client.execute({
      sql: `SELECT ic.comment_id, ic.block_id, ic.author, ic.body FROM ingested_comments ic
            LEFT JOIN requirement_approval_events a ON a.event_id = ic.comment_id
            WHERE ic.page_id = ? AND ic.created_time >= ? AND ic.ingested_at > ?
              AND a.event_id IS NULL
            ORDER BY ic.created_time, ic.comment_id`,
      args: [pageId, floorToNotionMinute(after), after],
    })).rows;
    return rows.map((row) => ({
      id: String(row.comment_id),
      blockId: row.block_id === null ? null : String(row.block_id),
      author: String(row.author),
      body: String(row.body),
    }));
  }
}
