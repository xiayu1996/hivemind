import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AgentSession, AgentSessions, SessionOutcome, SessionRequest } from "../ports.ts";
import type { FinishedRun, NewRun } from "../store/store.ts";
import { promptDigest } from "./prompt.ts";
import { SUBMIT_TOOL, submissionTool } from "./submit.ts";

export interface RunLog {
  startRun(run: NewRun): Promise<void>;
  finishRun(id: string, result: FinishedRun): Promise<void>;
}

export interface RunDependencies {
  sessions: AgentSessions;
  log: RunLog;
  billing(provider: string): "subscription" | "metered";
  newId?: () => string;
}

export interface AgentTask<T> {
  requirementId: string;
  itemId: string | null;
  step: string;
  session: Omit<SessionRequest, "runId">;
  task: string;
  result: { schema: z.ZodType<T>; description: string };
  /** Deterministic checks of a submitted result. Findings go back into the same session. */
  check?: (value: T) => Promise<readonly string[]> | readonly string[];
  maxHandbacks: number;
}

export type AgentRun<T> =
  | { ok: true; runId: string; value: T }
  | {
      ok: false;
      runId: string | null;
      reason: "unavailable" | "no_result" | "rejected" | "error" | "timeout" | "turn_limit";
      detail: string;
      /** Findings of the last rejected submission, for the next attempt. */
      findings: readonly string[];
      /** Only a person can fix what went wrong (credentials, billing, an unknown error). */
      needsHuman: boolean;
      errorClass: string | null;
      /** For "unavailable": when a model can serve again, or null when only a person can fix it. */
      retryAt?: number | null;
    };

/**
 * One agent session from start to result: open it on the first usable model,
 * send the task, and hand every deterministic finding back into the same
 * session until the result passes or the hand-back budget is spent. A
 * hand-back is a work item for the session, not a verdict on the attempt, so
 * it costs no attempt and the session keeps everything it already read.
 */
export async function runAgent<T>(deps: RunDependencies, task: AgentTask<T>): Promise<AgentRun<T>> {
  const runId = (deps.newId ?? randomUUID)();
  const submission = submissionTool(task.result.schema, task.result.description);
  const opened = await deps.sessions.open({ ...task.session, runId, tools: [...task.session.tools, submission.tool] });
  if (!opened.ok) {
    return { ok: false, runId: null, reason: "unavailable", detail: opened.reason, findings: [], needsHuman: opened.retryAt === null, errorClass: null, retryAt: opened.retryAt };
  }
  const session = opened.session;
  const started = session.model;
  await deps.log.startRun({
    id: runId,
    requirementId: task.requirementId,
    itemId: task.itemId,
    step: task.step,
    role: task.session.role,
    provider: started.provider,
    model: started.model,
    effort: started.effort,
    promptSha256: promptDigest(task.session.systemPrompt, task.task),
    billing: deps.billing(started.provider),
  });

  let result: AgentRun<T> | undefined;
  try {
    result = await drive(session, submission.value, task, runId);
    return result;
  } finally {
    session.close();
    const usage = session.usage();
    const outcome: FinishedRun["outcome"] =
      result?.ok === true ? "submitted" : result?.reason === "timeout" ? "timeout" : result?.reason === "error" ? "error" : "no_submit";
    await deps.log.finishRun(runId, {
      ...usage,
      outcome,
      errorClass: result?.ok === false ? result.errorClass : null,
      errorMessage: result?.ok === false ? result.detail.slice(0, 2000) : null,
      provider: session.model.provider,
      model: session.model.model,
    });
  }
}

async function drive<T>(session: AgentSession, submitted: () => T | undefined, task: AgentTask<T>, runId: string): Promise<AgentRun<T>> {
  let outcome: SessionOutcome = await session.send(task.task);
  let handbacks = 0;
  let nudged = false;
  let findings: readonly string[] = [];
  for (;;) {
    switch (outcome.kind) {
      case "ended":
      case "stopped": {
        const value = submitted();
        if (value === undefined) {
          if (nudged) return failure(runId, "no_result", `the session ended twice without calling ${SUBMIT_TOOL}`, findings);
          nudged = true;
          outcome = await session.send(`You stopped without calling ${SUBMIT_TOOL}. The work only counts once it is submitted: call ${SUBMIT_TOOL} now with your result.`);
          continue;
        }
        findings = task.check === undefined ? [] : await task.check(value);
        if (findings.length === 0) return { ok: true, runId, value };
        if (handbacks >= task.maxHandbacks) return failure(runId, "rejected", `the result was still rejected after ${handbacks} hand-backs`, findings);
        handbacks += 1;
        outcome = await session.send(handbackMessage(findings));
        continue;
      }
      case "error":
        return { ok: false, runId, reason: "error", detail: outcome.message, findings, needsHuman: outcome.needsHuman, errorClass: outcome.errorClass };
      case "timeout":
        return failure(runId, "timeout", "the session ran out of time", findings);
      case "turn_limit":
        return failure(runId, "turn_limit", "the session used all of its turns", findings);
    }
  }
}

function failure<T>(runId: string, reason: "no_result" | "rejected" | "timeout" | "turn_limit", detail: string, findings: readonly string[]): AgentRun<T> {
  return { ok: false, runId, reason, detail, findings, needsHuman: false, errorClass: null };
}

export function handbackMessage(findings: readonly string[]): string {
  const list = findings.map((finding) => `- ${finding}`).join("\n");
  return `Your submitted result was checked and refused for these reasons:\n${list}\n\nFix every one of them, then call ${SUBMIT_TOOL} again with the complete corrected result.`;
}
