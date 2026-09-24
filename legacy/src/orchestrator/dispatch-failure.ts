import { classifyError, type ErrorClass } from "../runner/classify.js";
import { mayReenterPhase } from "../pipeline/retry-limits.js";
import type { StoryState } from "./state-machine.js";

export interface DispatchFailureFacts {
  /** The signal the child process died on, if any. */
  signal?: string | null | undefined;
  /** Whether this process is shutting down, which is what killed the child. */
  stopping: boolean;
  message: string;
  /** Absent when the card can no longer be read; there is nothing to charge. */
  card?: { state: StoryState; phaseReentries: number } | undefined;
  budget: number;
}

export type DispatchFailureDecision =
  /** This process ended the run; the card did nothing and keeps its budget. */
  | { kind: "cancelled" }
  /** This host could not run its own command; the card never started. */
  | { kind: "host_fault"; reason: string }
  /** A provider event, not the card's doing: the breaker holds dispatch. */
  | { kind: "provider_fault"; errorClass: ErrorClass }
  /** No card to charge, or one that finished anyway. */
  | { kind: "ignored" }
  | { kind: "reenter"; state: StoryState; attempt: number; budget: number; errorClass: ErrorClass; refusal?: PhaseExitRefusal }
  | { kind: "park"; state: StoryState; attempt: number; budget: number; errorClass: ErrorClass; refusal?: PhaseExitRefusal };

/**
 * A failure that happened before the card's own work could begin.
 *
 * These say the host cannot run the command it was asked to run -- the binary
 * is missing, the script is not declared. Nothing about the card is on trial,
 * and charging it is worse than useless: the next attempt runs the same broken
 * command, so the whole budget is spent in a minute and the card stops for a
 * person who then finds nothing wrong with it. The host's own dependencies
 * were emptied under a running orchestrator on 2026-09-20 and
 * S-R237511TD-02 -- which had existed for ninety seconds -- burned all three
 * attempts on `sh: tsx: command not found`.
 *
 * Deliberately narrow. A missing module or a non-zero exit can be the card's
 * own code and must stay the card's to answer for.
 */
const HOST_FAULT = [
  /\bcommand not found\b/i,
  /\bspawn\b[^\n]*\bENOENT\b/i,
  /\bnpm (?:ERR!|error) missing script\b/i,
];

export function isHostFault(message: string): boolean {
  return HOST_FAULT.some((pattern) => pattern.test(message));
}

/** A phase exit that used up its handbacks and refused what the round wrote. */
export interface PhaseExitRefusal {
  /** The phase whose exit refused, as the exit itself names it. */
  gate: string;
  /** What it asked for, which is the whole of what a person has to act on. */
  detail: string;
}

const EXIT_REFUSAL = /([A-Z_]+) exit checks were not met:\s*([\s\S]*)$/;

/**
 * Whether this run died of its own exit rather than of something unknown.
 *
 * Both arrive here identically -- a child process that exited non-zero with a
 * message -- and the classifier can only call the message UNKNOWN, so the page
 * said "3 runs died before producing anything" over three rounds whose exits
 * had each stated, in full, what was missing. Reading the refusal out keeps
 * the budget exactly where it was (three rounds that cannot satisfy their own
 * exit is a card for a person) and makes the stop say which exit refused and
 * what it asked for.
 */
export function describePhaseExitRefusal(message: string): PhaseExitRefusal | undefined {
  const match = EXIT_REFUSAL.exec(message);
  if (!match) return undefined;
  const detail = (match[2] ?? "").trim();
  if (detail === "") return undefined;
  return { gate: match[1]!, detail };
}

/**
 * What a dead Story run costs the card.
 *
 * Only the last two outcomes charge anything, and the order matters: a run this
 * process killed, and a run a provider killed, both say nothing about whether
 * the card's work can be done. Charging them parks whatever happened to be in
 * flight across a restart or a quota window, which is how S-AGENTRULES-01 came
 * to stop three minutes into SHAPE having produced nothing to read.
 */
export function decideDispatchFailure(facts: DispatchFailureFacts): DispatchFailureDecision {
  if (facts.stopping || facts.signal === "SIGTERM" || facts.signal === "SIGINT") return { kind: "cancelled" };
  if (isHostFault(facts.message)) return { kind: "host_fault", reason: facts.message };
  const { class: errorClass } = classifyError(facts.message);
  if (errorClass !== "UNKNOWN") return { kind: "provider_fault", errorClass };
  if (!facts.card || facts.card.state === "DELIVERED") return { kind: "ignored" };
  const attempt = facts.card.phaseReentries + 1;
  const kind = mayReenterPhase(facts.card.state, attempt, facts.budget) ? "reenter" : "park";
  const refusal = describePhaseExitRefusal(facts.message);
  return { kind, state: facts.card.state, attempt, budget: facts.budget, errorClass, ...(refusal ? { refusal } : {}) };
}

export interface DispatchFailureStore {
  getStory(cardId: string): Promise<{ state: StoryState; phaseReentries: number }>;
  recordDispatchFailure(input: {
    cardId: string;
    state: StoryState;
    errorClass: string;
    message: string;
    refusal?: PhaseExitRefusal;
    attempt: number;
    budget: number;
    runId: string;
  }): Promise<void>;
  stopForInput(
    cardId: string,
    expectedFrom: StoryState,
    reason: "retry_limit_exceeded",
    runId: string,
    detail?: Record<string, unknown>,
  ): Promise<void>;
}

export interface DispatchFailureConfig {
  reload(): Promise<void>;
  get(key: "retry.maxPhaseReentries"): number;
}

/**
 * Charges a dead Story run to the card and records why, returning what was
 * decided so the caller can say it on the console.
 */
export async function settleDispatchFailure(input: {
  store: DispatchFailureStore;
  config: DispatchFailureConfig;
  cardId: string;
  error: unknown;
  stopping: boolean;
}): Promise<DispatchFailureDecision> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const signal = (input.error as { signal?: string | null }).signal;
  const cancelled = decideDispatchFailure({ signal, stopping: input.stopping, message, budget: 0 });
  if (cancelled.kind === "cancelled" || cancelled.kind === "provider_fault" || cancelled.kind === "host_fault") {
    return cancelled;
  }

  await input.config.reload();
  const budget = input.config.get("retry.maxPhaseReentries");
  const card = await input.store.getStory(input.cardId).catch(() => undefined);
  const decision = decideDispatchFailure({ signal, stopping: input.stopping, message, card, budget });
  if (decision.kind !== "reenter" && decision.kind !== "park") return decision;

  const runId = `reentry-${input.cardId}`;
  await input.store.recordDispatchFailure({
    cardId: input.cardId,
    state: decision.state,
    // Named for what it is. UNKNOWN is the honest answer for a message nobody
    // can place, and this one places itself.
    errorClass: decision.refusal ? "PHASE_EXIT_REFUSED" : decision.errorClass,
    message,
    attempt: decision.attempt,
    budget,
    runId,
    ...(decision.refusal ? { refusal: decision.refusal } : {}),
  });
  if (decision.kind === "park") {
    await input.store.stopForInput(input.cardId, decision.state, "retry_limit_exceeded", runId, {
      classification: decision.refusal ? "phase_exit_refused" : "reentry",
      attempt: decision.attempt,
      budget,
      errorClass: decision.refusal ? "PHASE_EXIT_REFUSED" : decision.errorClass,
      ...(decision.refusal ? { refusal: decision.refusal } : {}),
    });
  }
  return decision;
}
