import type { EnvironmentJudgement, EnvironmentJudgeSettings } from "./environment-reasons.js";
import { HttpSystemOne } from "./system-one.js";

/** Read from `~/.hivemind/secrets.env` like every other credential; it is never
 * passed to a pi subprocess, which has no business with it. */
export const JUDGE_API_KEY = "TYPESAFE_API_KEY";

export interface JudgeConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  timeoutMs: number;
  environmentThreshold: number;
}

/**
 * Why the judge is or is not in play. The three cases are kept apart so a host
 * that turned it on and has no key says so at startup: a judge that silently
 * does nothing looks exactly like a judge that is answering, and the deployment
 * would keep paying attention to a signal that was never produced.
 */
export type JudgeSetup =
  | { kind: "off" }
  | { kind: "no_credential"; key: string }
  | { kind: "ready"; settings: EnvironmentJudgeSettings };

export function environmentJudgeSetup(
  config: JudgeConfig,
  secrets: ReadonlyMap<string, string>,
  onJudged?: (judgement: EnvironmentJudgement) => Promise<void> | void,
): JudgeSetup {
  if (!config.enabled) return { kind: "off" };
  const apiKey = secrets.get(JUDGE_API_KEY);
  if (!apiKey) return { kind: "no_credential", key: JUDGE_API_KEY };
  return {
    kind: "ready",
    settings: {
      judge: new HttpSystemOne({
        endpoint: config.endpoint,
        apiKey,
        timeoutMs: config.timeoutMs,
      }),
      model: config.model,
      threshold: config.environmentThreshold,
      ...(onJudged ? { onJudged } : {}),
    },
  };
}

/** One line for the operator, with no part of the credential in it. */
export function describeJudgeSetup(setup: JudgeSetup): string | null {
  if (setup.kind === "off") return null;
  return setup.kind === "no_credential"
    ? `judge is enabled but ${setup.key} is missing from the secrets file; the pattern tables answer alone`
    : "judge is answering the questions that declare a deterministic fallback";
}
