import type { RequirementPagePublisher } from "../orchestrator/clarify-loop.js";
import type { RequirementState } from "../orchestrator/requirement-machine.js";
import type {
  AcceptanceItem,
  ClarifyRound,
  PrdRevision,
  RequirementSnapshot,
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
  linkedEpics: readonly { epicId: string; state: string }[];
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
    `关联 Epic: ${input.linkedEpics.length === 0 ? "暂无" : input.linkedEpics.map((epic) => epic.epicId).join(", ")}`,
    ...(requirement.stopReason ? [`等待人回答: ${requirement.stopReason}`] : []),
  ].join(" · ");

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
    const [clarify, prd, acceptance, linkedEpics] = await Promise.all([
      this.store.clarifyHistory(requirementId),
      this.store.getPrd(requirementId),
      this.store.acceptanceItems(requirementId),
      this.store.linkedEpicStates(requirementId),
    ]);
    const desired = buildRequirementPage({ requirement, clarify, prd, acceptance, linkedEpics });
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
