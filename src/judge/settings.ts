import type { ConfigStore } from "../config/store.js";
import type { ApprovalJudgeSettings } from "./approval-intent.js";
import type { BusinessLanguageJudgeSettings } from "./business-language.js";
import type { VerticalSliceJudgeSettings } from "./vertical-slice.js";
import type { EnvironmentJudgement, EnvironmentJudgeSettings } from "./environment-reasons.js";
import { HttpSystemOne, type SystemOne } from "./system-one.js";

/** Read from `~/.hivemind/secrets.env` like every other credential; it is never
 * passed to a pi subprocess, which has no business with it. */
export const JUDGE_API_KEY = "TYPESAFE_API_KEY";

export interface JudgeConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  timeoutMs: number;
  /** How sure the judge has to be that a rejection reason describes the box. */
  environmentThreshold: number;
  /** How sure it has to be that a comment approves what is on the page. */
  approvalThreshold: number;
  /** How sure it has to be that a line of a plan is about construction. */
  businessLanguageThreshold: number;
  /** How sure it has to be that a Story is a step rather than a slice. */
  verticalSliceThreshold: number;
}

/** The keys read in one place, so a caller cannot pick up one question's
 * threshold for another's. */
export function judgeConfigFrom(config: ConfigStore): JudgeConfig {
  return {
    enabled: config.get("judge.enabled"),
    endpoint: config.get("judge.endpoint"),
    model: config.get("judge.model"),
    timeoutMs: config.get("judge.timeoutMs"),
    environmentThreshold: config.get("judge.environmentThreshold"),
    approvalThreshold: config.get("judge.approvalThreshold"),
    businessLanguageThreshold: config.get("judge.businessLanguageThreshold"),
    verticalSliceThreshold: config.get("judge.verticalSliceThreshold"),
  };
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
  | { kind: "ready"; judge: SystemOne; model: string };

export function judgeSetup(config: JudgeConfig, secrets: ReadonlyMap<string, string>): JudgeSetup {
  if (!config.enabled) return { kind: "off" };
  const apiKey = secrets.get(JUDGE_API_KEY);
  if (!apiKey) return { kind: "no_credential", key: JUDGE_API_KEY };
  return {
    kind: "ready",
    judge: new HttpSystemOne({ endpoint: config.endpoint, apiKey, timeoutMs: config.timeoutMs }),
    model: config.model,
  };
}

/**
 * Each question carries its own threshold because the conservative direction is
 * not the same one twice. On the environment question the judge moves a
 * rejection off the code side, and being wrong costs a card that never
 * converges; on the approval question it turns a comment into an approval, and
 * being wrong lets unapproved content go on to be built.
 */
export function environmentJudgeSetup(
  config: JudgeConfig,
  secrets: ReadonlyMap<string, string>,
  onJudged?: (judgement: EnvironmentJudgement) => Promise<void> | void,
): { setup: JudgeSetup; settings?: EnvironmentJudgeSettings } {
  const setup = judgeSetup(config, secrets);
  if (setup.kind !== "ready") return { setup };
  return {
    setup,
    settings: {
      judge: setup.judge,
      model: setup.model,
      threshold: config.environmentThreshold,
      ...(onJudged ? { onJudged } : {}),
    },
  };
}

export function approvalJudgeSetup(
  config: JudgeConfig,
  secrets: ReadonlyMap<string, string>,
): { setup: JudgeSetup; settings?: ApprovalJudgeSettings } {
  const setup = judgeSetup(config, secrets);
  if (setup.kind !== "ready") return { setup };
  return {
    setup,
    settings: { judge: setup.judge, model: setup.model, threshold: config.approvalThreshold },
  };
}

/** One line for the operator, with no part of the credential in it. */
export function describeJudgeSetup(setup: JudgeSetup): string | null {
  if (setup.kind === "off") return null;
  return setup.kind === "no_credential"
    ? `judge is enabled but ${setup.key} is missing from the secrets file; the pattern tables answer alone`
    : "judge is answering the questions that declare a deterministic fallback";
}

export function businessLanguageJudgeSetup(
  config: JudgeConfig,
  secrets: ReadonlyMap<string, string>,
): { setup: JudgeSetup; settings?: BusinessLanguageJudgeSettings } {
  const setup = judgeSetup(config, secrets);
  if (setup.kind !== "ready") return { setup };
  return {
    setup,
    settings: { judge: setup.judge, model: setup.model, threshold: config.businessLanguageThreshold },
  };
}

export function verticalSliceJudgeSetup(
  config: JudgeConfig,
  secrets: ReadonlyMap<string, string>,
): { setup: JudgeSetup; settings?: VerticalSliceJudgeSettings } {
  const setup = judgeSetup(config, secrets);
  if (setup.kind !== "ready") return { setup };
  return {
    setup,
    settings: { judge: setup.judge, model: setup.model, threshold: config.verticalSliceThreshold },
  };
}
