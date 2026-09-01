import type { ClarificationChannelSet } from "./clarification-channel.js";
import { evaluateClarification, type ClarificationCandidate } from "./requirement-artifacts.js";
import type { RequirementStore } from "./requirement-store.js";

export interface ClarifyRound {
  round: number;
  questions: readonly string[];
  answers: readonly string[] | null;
}

export interface ClarifyRequest {
  requirementId: string;
  title: string;
  originalRequest: string;
  history: readonly ClarifyRound[];
  maxQuestions: number;
  /** Why an earlier attempt in this same round was refused. */
  previousRejections: readonly string[];
}

export interface ClarifyPort {
  run(input: ClarifyRequest): Promise<ClarificationCandidate>;
}

/** Re-renders the requirement page after the record changed. */
export interface RequirementPagePublisher {
  publish(requirementId: string): Promise<void>;
}

export type ClarifyOutcome =
  | { kind: "asked"; round: number; questions: readonly string[] }
  | { kind: "waiting"; round: number }
  | { kind: "answered"; round: number }
  | { kind: "ready"; summary: string }
  | { kind: "stopped"; reason: string };

export interface ClarifyLoopOptions {
  maxRounds: number;
  maxQuestionsPerRound: number;
}

const MAX_ATTEMPTS = 2;

/**
 * Drives one requirement's clarification. Each call does at most one thing —
 * ask, read answers back, or conclude — so a crash costs a single step and the
 * next call resumes from what the database already holds.
 */
export class ClarifyLoop {
  constructor(
    private readonly store: RequirementStore,
    private readonly channels: ClarificationChannelSet,
    private readonly port: ClarifyPort,
    private readonly publisher: RequirementPagePublisher,
    private readonly options: ClarifyLoopOptions,
  ) {}

  async advance(requirementId: string): Promise<ClarifyOutcome> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state !== "CLARIFY") {
      throw new Error(`requirement ${requirementId} is ${requirement.state}, not in clarification`);
    }
    if (requirement.stopReason) {
      return { kind: "stopped", reason: requirement.stopReason };
    }

    const history = await this.store.clarifyHistory(requirementId);
    const open = history.at(-1);
    if (open && open.answers === null) {
      const answers = await this.channels.collect(requirementId, open.round);
      if (answers.length === 0) return { kind: "waiting", round: open.round };
      // Answers are archived verbatim: a paraphrase would quietly become the
      // requirement, and nobody would be able to tell it apart from what the
      // person actually wrote.
      const bodies = answers
        .toSorted((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id, "en"))
        .map((answer) => `${answer.author}: ${answer.body}`);
      await this.store.recordClarifyAnswers(requirementId, open.round, bodies, runId(requirementId));
      await this.publisher.publish(requirementId);
      return { kind: "answered", round: open.round };
    }

    const rejections: string[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await this.port.run({
        requirementId,
        title: requirement.title,
        originalRequest: requirement.originalRequest,
        history: history.map((entry) => ({
          round: entry.round,
          questions: entry.questions,
          answers: entry.answers,
        })),
        maxQuestions: this.options.maxQuestionsPerRound,
        previousRejections: [...rejections],
      });
      const evaluated = evaluateClarification(candidate, this.options.maxQuestionsPerRound);

      if (evaluated.kind === "ready") {
        await this.store.transition(requirementId, "CLARIFY", "PRD_CONFIRM", "system", runId(requirementId));
        await this.publisher.publish(requirementId);
        return { kind: "ready", summary: evaluated.summary };
      }
      if (evaluated.kind === "ask") {
        if (requirement.clarifyRounds >= this.options.maxRounds) {
          // The budget is spent and the product manager still has questions.
          // Asking forever is worse than handing the requirement to a person.
          return this.stop(
            requirementId,
            `clarification did not converge in ${this.options.maxRounds} rounds; still asking: ${evaluated.questions.join(" / ")}`,
          );
        }
        const round = await this.store.openClarifyRound(requirementId, [...evaluated.questions], runId(requirementId));
        await this.channels.ask({ requirementId, round, questions: evaluated.questions });
        await this.publisher.publish(requirementId);
        return { kind: "asked", round, questions: evaluated.questions };
      }
      rejections.push(...evaluated.reasons);
    }

    return this.stop(requirementId, `clarification output was unusable: ${rejections.join("; ")}`);
  }

  private async stop(requirementId: string, detail: string): Promise<ClarifyOutcome> {
    await this.store.stopForHumanInput(requirementId, "CLARIFY", runId(requirementId), detail);
    await this.publisher.publish(requirementId);
    return { kind: "stopped", reason: detail };
  }
}

function runId(requirementId: string): string {
  return `requirement:${requirementId}`;
}
