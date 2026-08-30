import { z } from "zod";
import { redactForExport } from "../observability/redact.js";
import { lastAssistantText } from "../runner/assistant-text.js";
import type { PiRunner } from "../runner/types.js";

export interface CompletionJudge {
  /** A single tool-free small-model call. */
  complete(prompt: string): Promise<string>;
}

export interface CompletionInput {
  phase: string;
  claimedArtifact: string;
  sideEffects: unknown;
}

export interface CompletionDecision {
  done: boolean;
  reason: string;
  feedback: string | null;
}

/** Runs the judgment in its own fresh, tool-free pi session. */
export class PiCompletionJudge implements CompletionJudge {
  constructor(private readonly createRunner: () => PiRunner) {}

  async complete(prompt: string): Promise<string> {
    const runner = this.createRunner();
    try {
      await runner.start();
      await runner.setAutoRetry(false);
      const result = await runner.prompt(prompt);
      if (result.failure) throw new Error(result.failure.errorMessage);
      return lastAssistantText(await runner.getMessages());
    } finally {
      await runner.stop();
    }
  }
}

const judgmentSchema = z.object({
  done: z.boolean(),
  reason: z.string().trim().min(1),
}).strict();

function rejected(reason: string): CompletionDecision {
  return {
    done: false,
    reason,
    feedback: `Completion verifier rejected this exit: ${reason}`,
  };
}

export async function verifyCompletion(
  judge: CompletionJudge,
  input: CompletionInput,
): Promise<CompletionDecision> {
  const prompt = [
    "Judge whether this phase exit is actually complete from its artifact and observable side effects.",
    "Return only JSON with keys done:boolean and reason:string. Fail closed when evidence is missing.",
    `Phase: ${input.phase}`,
    `Claimed artifact:\n${input.claimedArtifact}`,
    `Observable side effects:\n${JSON.stringify(input.sideEffects)}`,
  ].join("\n\n");

  let raw: string;
  try {
    raw = await judge.complete(prompt);
  } catch (cause) {
    const safe = redactForExport({ message: (cause as Error).message }).message;
    return rejected(`completion verifier failed: ${safe}`);
  }

  try {
    const parsed = judgmentSchema.parse(JSON.parse(raw) as unknown);
    return parsed.done
      ? { done: true, reason: parsed.reason, feedback: null }
      : rejected(parsed.reason);
  } catch (cause) {
    const message = cause instanceof SyntaxError ? cause.message : "schema mismatch";
    return rejected(`completion verifier returned invalid output: ${message}`);
  }
}
