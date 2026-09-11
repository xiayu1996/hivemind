import type { RequirementPagePublisher } from "../orchestrator/clarify-loop.js";
import type { RequirementState } from "../orchestrator/requirement-machine.js";
import type {
  AcceptanceItem,
  ClarifyRound,
  LinkedEpicProgress,
  PrdRevision,
  RequirementSnapshot,
  RequirementStop,
  RequirementStore,
} from "../orchestrator/requirement-store.js";
import { questionText } from "../orchestrator/human-question.js";
import type { DesiredRequirementPage } from "./blocks/requirement-page.js";
import type { NotionOutbox } from "./outbox.js";
import schema from "./notion-schema.json" with { type: "json" };

const STATUS = schema.options.requirementStatus;

/**
 * The board column a state is shown in. FAILED has no column of its own: a
 * requirement the system gave up on needs a person, which is what the parked
 * column already means to whoever is reading the board.
 */
export function requirementStatusFor(state: RequirementState, clarifyRounds: number): string {
  switch (state) {
    case "CLARIFY": {
      return clarifyRounds === 0 ? STATUS[0]! : STATUS[1]!;
    }
    case "PRD_CONFIRM": {
      return STATUS[2]!;
    }
    case "DECOMPOSING":
    case "EXECUTING": {
      return STATUS[3]!;
    }
    case "ACCEPTANCE": {
      return STATUS[4]!;
    }
    case "DONE": {
      return STATUS[5]!;
    }
    default: {
      return STATUS[6]!;
    }
  }
}

export interface RequirementPageInput {
  requirement: RequirementSnapshot;
  clarify: readonly ClarifyRound[];
  prd: PrdRevision | null;
  acceptance: readonly AcceptanceItem[];
  linkedEpics: readonly LinkedEpicProgress[];
  /** The last stop, shown only while `requirement.stopReason` is still set. */
  stop?: RequirementStop | null;
}

const EPIC_STATE_LABELS: Record<string, string> = {
  INTAKE: "待开始",
  DECOMPOSE: "拆解中",
  PLAN_APPROVAL: "方案待确认",
  EXECUTING: "开发中",
  EPIC_ACCEPT: "验收中",
  DONE: "已完成",
  BLOCKED: "受阻",
  FAILED: "失败",
};

function epicProgressLine(epics: readonly LinkedEpicProgress[]): string {
  if (epics.length === 0) return "关联 Epic: 暂无";
  const parts = epics.map((epic) => {
    const label = EPIC_STATE_LABELS[epic.state] ?? epic.state;
    const stories = epic.storiesTotal > 0 ? `，Story ${epic.storiesDelivered}/${epic.storiesTotal} 已交付` : "";
    return `${epic.epicId}（${label}${stories}）`;
  });
  return `关联 Epic: ${parts.join("、")}`;
}

/** What the page says while the system waits on a person, worded like the
 * Story page's own waiting section so both read the same way. */
export function requirementQuestionsText(stop: RequirementStop): string {
  return [
    `系统已停下等你回答：${stop.detail}`,
    "如何回答：直接在本页评论区留言，系统读到你的回复后会从停下的地方继续。",
  ].join("\n\n");
}

interface PrdBody {
  businessGoal: string;
  nonGoals?: string[];
  scenarios: Array<{ id: string; given: string; when: string; then: string }>;
  openQuestions?: string[];
}

/** Renders the page a person reads. Pure, so the same record always produces
 * the same page and a replay can tell "already applied" from "changed". */
export function buildRequirementPage(input: RequirementPageInput): DesiredRequirementPage {
  const { requirement } = input;
  const metadata = [
    `状态: ${requirementStatusFor(requirement.state, requirement.clarifyRounds)}`,
    `澄清轮次: ${requirement.clarifyRounds}`,
    epicProgressLine(input.linkedEpics),
    ...(requirement.stopReason ? [`等待人回答: ${requirement.stopReason}`] : []),
  ].join(" · ");
  const stop = requirement.stopReason ? input.stop ?? null : null;

  const clarify: string[] = [];
  for (const round of input.clarify) {
    for (const [index, question] of round.questions.entries()) {
      clarify.push(`第 ${round.round} 轮 问 ${index + 1}: ${questionText(question)}`);
    }
    for (const [index, answer] of (round.answers ?? []).entries()) {
      clarify.push(`第 ${round.round} 轮 答 ${index + 1}: ${answer}`);
    }
  }

  const prd: string[] = [];
  if (input.prd) {
    const body = JSON.parse(input.prd.body) as PrdBody;
    prd.push(`业务目标: ${body.businessGoal}`);
    for (const nonGoal of body.nonGoals ?? []) prd.push(`本次不做: ${nonGoal}`);
    for (const scenario of body.scenarios) {
      prd.push(`场景 ${scenario.id}: 给定 ${scenario.given}，当 ${scenario.when}，则 ${scenario.then}`);
    }
    for (const question of body.openQuestions ?? []) prd.push(`待你裁决: ${question}`);
  }

  return {
    metadata,
    original: requirement.originalRequest,
    clarify,
    prd,
    prdFrozen: input.prd?.status === "confirmed",
    acceptance: input.acceptance.map((item) => item.text),
    // The heading exists on every requirement page, so the section says that
    // nothing is waiting rather than standing empty and reading as unfinished.
    questions: stop ? requirementQuestionsText(stop) : "当前没有等你回答的问题。",
  };
}

/**
 * Turns the requirement's record into one durable page projection. Everything
 * the product manager layer shows a person goes through here, so a crash costs
 * a redelivery rather than a lost conversation.
 */
export class RequirementPageProjector implements RequirementPagePublisher {
  constructor(
    private readonly store: RequirementStore,
    private readonly outbox: NotionOutbox,
  ) {}

  async publish(requirementId: string): Promise<void> {
    const requirement = await this.store.getRequirement(requirementId);
    const [clarify, prd, acceptance, linkedEpics, stop] = await Promise.all([
      this.store.clarifyHistory(requirementId),
      this.store.getPrd(requirementId),
      this.store.acceptanceItems(requirementId),
      this.store.linkedEpicStates(requirementId),
      requirement.stopReason ? this.store.latestStop(requirementId) : Promise.resolve(null),
    ]);
    const desired = buildRequirementPage({ requirement, clarify, prd, acceptance, linkedEpics, stop });
    await this.outbox.enqueue({
      cardId: requirementId,
      priority: 1,
      operation: "sync_requirement_page",
      target: requirement.notionPageId,
      payload: {
        requirementId,
        pageId: requirement.notionPageId,
        status: requirementStatusFor(requirement.state, requirement.clarifyRounds),
        desired,
      },
    });
  }
}
