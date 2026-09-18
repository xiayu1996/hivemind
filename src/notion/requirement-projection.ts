import type { RequirementPagePublisher } from "../orchestrator/clarify-loop.js";
import type { RequirementState } from "../orchestrator/requirement-machine.js";
import type {
  AcceptanceItem,
  ClarifyRound,
  PrdRevision,
  PrototypeRevision,
  RequirementSnapshot,
  RequirementStop,
  RequirementStore,
  SolutionRevision,
} from "../orchestrator/requirement-store.js";
import type { SolutionBody } from "../orchestrator/requirement-solution.js";
import type { PrototypePage } from "../pipeline/interface-contract.js";
import { annotateReply, questionLines } from "../orchestrator/human-question.js";
import type {
  DesiredClarifyRound,
  DesiredRequirementPage,
  DesiredSolution,
  DesiredSolutionPage,
} from "./blocks/requirement-page.js";
import type { NotionOutbox } from "./outbox.js";
import schema from "./notion-schema.json" with { type: "json" };
import { quietText, waitingText } from "./display-text.js";

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
    case "SOLUTION": {
      return STATUS[3]!;
    }
    case "DECOMPOSING":
    case "EXECUTING": {
      return STATUS[4]!;
    }
    case "ACCEPTANCE": {
      return STATUS[5]!;
    }
    case "DONE": {
      return STATUS[6]!;
    }
    default: {
      return STATUS[7]!;
    }
  }
}

export interface RequirementPageInput {
  requirement: RequirementSnapshot;
  clarify: readonly ClarifyRound[];
  prd: PrdRevision | null;
  acceptance: readonly AcceptanceItem[];
  /** The solution revision the page shows, and the screens drawn for it. */
  solution?: SolutionRevision | null;
  prototype?: PrototypeRevision | null;
  /** The last stop, shown only while `requirement.stopReason` is still set. */
  stop?: RequirementStop | null;
}

interface PrdBody {
  businessGoal: string;
  nonGoals?: string[];
  scenarios: Array<{ id: string; given: string; when: string; then: string }>;
  openQuestions?: string[];
}

/** Which situation a requirement waits in, if any. Everything else the board
 * column already says, and the page does not repeat it. */
function situation(requirement: RequirementSnapshot): "CLARIFY" | "PRD_CONFIRM" | "SOLUTION" | undefined {
  if (requirement.stopReason) return "CLARIFY";
  if (requirement.state === "CLARIFY" || requirement.state === "PRD_CONFIRM") return requirement.state;
  return requirement.state === "SOLUTION" ? "SOLUTION" : undefined;
}

interface PrototypeBody {
  pages?: Array<{ file: string; scenarios?: string[]; visible?: Array<{ role: string; text: string }> }>;
  described?: PrototypePage[];
  concerns?: string[];
}

/**
 * The screens as a list a person reads: the name each page gave itself, what
 * it is for, and what the drawing said it carries. A record drawn before the
 * pages carried their own names falls back to the plan, which has the names
 * but not the scenarios -- fewer facts, never a file path in place of a name.
 */
function solutionPages(
  plan: SolutionBody["interface"],
  prototype: PrototypeBody | null,
): DesiredSolutionPage[] {
  const described = prototype?.described ?? [];
  if (described.length === 0) {
    return (plan?.pages ?? []).map((page) => ({
      name: page.name,
      purpose: page.purpose,
      scenarios: [],
      visible: [],
    }));
  }
  const claims = new Map((prototype?.pages ?? []).map((claim) => [claim.file, claim]));
  return [...described]
    .toSorted((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .map((page) => {
      const claim = claims.get(page.file);
      return {
        name: page.name,
        purpose: page.purpose,
        scenarios: claim?.scenarios ?? [],
        visible: (claim?.visible ?? []).map((item) => item.text),
      };
    });
}

/** The solution the page shows, or nothing at all before one is drafted. */
function solutionSection(
  revision: SolutionRevision | null | undefined,
  prototype: PrototypeRevision | null | undefined,
): DesiredSolution | null {
  if (!revision) return null;
  const body = JSON.parse(revision.body) as SolutionBody;
  const drawn = prototype ? JSON.parse(prototype.body) as PrototypeBody : null;
  return {
    approach: { summary: body.approach.summary, alternatives: body.approach.alternatives },
    direction: body.interface?.direction ?? null,
    stackChanges: body.stackChanges ?? [],
    qualityGates: (body.qualityGates ?? []).map((gate) => ({ name: gate.name, covers: gate.covers })),
    pages: solutionPages(body.interface ?? null, drawn),
    prototypeUrl: prototype?.mrUrl ?? null,
    concerns: drawn?.concerns ?? [],
    openDecisions: body.openDecisions ?? [],
    confirmed: revision.status === "confirmed",
  };
}

/** One clarification round as the page folds it. */
function clarifyRound(round: ClarifyRound): DesiredClarifyRound {
  const answers = round.answers ?? [];
  const answered = answers.length > 0;
  return {
    round: round.round,
    line: `\u7b2c ${round.round} \u8f6e \u00b7 ${round.questions.length} \u9898 \u00b7 ${answered ? "\u5df2\u56de\u7b54" : "\u7b49\u4f60\u56de\u7b54"}`,
    items: round.questions.map((question, index) => {
      const reply = answers[index];
      return {
        question: question.question,
        options: questionLines(question).slice(1),
        ...(reply === undefined ? {} : { answer: reply, reading: annotateReply([question], reply) }),
      };
    }),
  };
}

/** Renders the page a person reads. Pure, so the same record always produces
 * the same page and a replay can tell "already applied" from "changed". */
export function buildRequirementPage(input: RequirementPageInput): DesiredRequirementPage {
  const { requirement } = input;
  const waiting = waitingText("requirement", situation(requirement) ?? "");
  const stop = requirement.stopReason ? input.stop ?? null : null;
  const callout = waiting
    ? [...(stop ? [`\u505c\u5728\u8fd9\u91cc\uff1a${stop.detail}`] : []), waiting.action].join("\n")
    : quietText().action;

  const body = input.prd ? JSON.parse(input.prd.body) as PrdBody : null;
  const delivered = input.acceptance.filter((item) => item.status === "accepted").length;
  const delivery = input.acceptance.length === 0
    ? "\u573a\u666f\u7531\u627f\u63a5\u5b83\u4eec\u7684 Epic \u9010\u6279\u9a8c\u6536\uff0c\u5168\u90e8\u901a\u8fc7\u540e\u8fd9\u6761\u9700\u6c42\u81ea\u52a8\u7ed3\u6848\u3002"
    : `\u5df2\u9a8c\u6536 ${delivered}/${input.acceptance.length} \u4e2a\u573a\u666f\uff1b\u9a8c\u6536\u5728\u5404\u4e2a Epic \u9875\u4e0a\u505a\uff0c\u8fd9\u91cc\u53ea\u6c47\u603b\u3002`;

  return {
    callout,
    original: requirement.originalRequest,
    clarify: input.clarify.map((round) => clarifyRound(round)),
    prd: body
      ? {
        goal: body.businessGoal,
        nonGoals: body.nonGoals ?? [],
        scenarios: body.scenarios,
        openQuestions: body.openQuestions ?? [],
        frozen: input.prd?.status === "confirmed",
      }
      : null,
    solution: solutionSection(input.solution, input.prototype),
    delivery,
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
    const [clarify, prd, acceptance, stop, solution] = await Promise.all([
      this.store.clarifyHistory(requirementId),
      this.store.getPrd(requirementId),
      this.store.acceptanceItems(requirementId),
      requirement.stopReason ? this.store.latestStop(requirementId) : Promise.resolve(null),
      this.store.getSolution(requirementId),
    ]);
    const prototype = solution ? await this.store.getSolutionPrototype(requirementId, solution.revision) : null;
    const desired = buildRequirementPage({ requirement, clarify, prd, acceptance, stop, solution, prototype });
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
