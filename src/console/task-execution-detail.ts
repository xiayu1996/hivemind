export type TaskExecutionRoundStatus = "completed" | "running" | "failed";

export interface TaskExecutionStep {
  phase: string;
  summary: string;
  occurredAt: number;
}

export interface TaskExecutionOutput {
  phase: string;
  kind: string;
  content: string;
  createdAt: number;
}

interface TaskExecutionRoundBase {
  round: number;
  process: readonly TaskExecutionStep[];
  outputs: readonly TaskExecutionOutput[];
  currentResult: string;
}

export type TaskExecutionRound =
  | (TaskExecutionRoundBase & { status: "completed"; failureReason?: never })
  | (TaskExecutionRoundBase & { status: "running"; failureReason?: never })
  | (TaskExecutionRoundBase & { status: "failed"; failureReason: string });

export interface TaskRoundObservation {
  round: number;
  phase: string;
  runStatus: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
  progress: string;
  outputs: readonly TaskExecutionOutput[];
  /** The persisted failure text of a phase run that ended in failure, when the
   * store holds one. It is the reason shown for a round whose failure is not a
   * verification verdict, and it is never synthesized here. */
  failureReason?: string;
  verification?:
    | { verdict: "accepted"; result: string }
    | { verdict: "rejected" | "inconclusive"; result: string; failureReason: string };
}

export interface TaskExecutionProjectionInput {
  taskId: string;
  taskName: string;
  observedAt: number;
  observations: readonly TaskRoundObservation[];
}

/** Groups each positive round once and orders rounds, steps and outputs from oldest to newest. */
export function projectTaskExecutionDetail(input: TaskExecutionProjectionInput): TaskExecutionDetail {
  const byRound = new Map<number, TaskRoundObservation[]>();
  for (const observation of input.observations) {
    if (!Number.isInteger(observation.round) || observation.round <= 0) continue;
    const existing = byRound.get(observation.round);
    if (existing === undefined) byRound.set(observation.round, [observation]);
    else existing.push(observation);
  }
  const rounds = [...byRound.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([round, observations]) => projectRound(round, observations));
  return {
    taskId: input.taskId,
    taskName: input.taskName,
    rounds,
    observedAt: input.observedAt,
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function byStartedAt(left: TaskRoundObservation, right: TaskRoundObservation): number {
  return left.startedAt - right.startedAt || compareText(left.phase, right.phase);
}

function byCreatedAt(left: TaskExecutionOutput, right: TaskExecutionOutput): number {
  return left.createdAt - right.createdAt
    || compareText(left.phase, right.phase)
    || compareText(left.kind, right.kind)
    || compareText(left.content, right.content);
}

/**
 * A round's status is a terminal outcome first and activity second. An accepted
 * verification settles it as completed; a rejected or inconclusive verdict, or
 * a phase run that ended in failure, settles it as failed; only otherwise does
 * an observation still running make it running. The latest progress of the
 * round is the current result unless a verification verdict states one.
 */
function projectRound(round: number, roundObservations: readonly TaskRoundObservation[]): TaskExecutionRound {
  const ordered = [...roundObservations].toSorted(byStartedAt);
  const process = ordered.map((observation) => ({
    phase: observation.phase,
    summary: observation.progress,
    occurredAt: observation.startedAt,
  }));
  const outputs = ordered
    .flatMap((observation) => observation.outputs)
    .toSorted(byCreatedAt);
  const latestProgress = ordered.at(-1)?.progress ?? "";

  const verification = ordered.findLast((observation) => observation.verification !== undefined)?.verification;
  if (verification !== undefined) {
    if (verification.verdict === "accepted") {
      return { round, process, outputs, currentResult: verification.result, status: "completed" };
    }
    return {
      round,
      process,
      outputs,
      currentResult: verification.result,
      status: "failed",
      failureReason: verification.failureReason,
    };
  }

  const failed = ordered.findLast((observation) => observation.runStatus === "failed");
  if (failed !== undefined) {
    const reason = failed.failureReason;
    if (reason === undefined || reason === "") {
      throw new Error(`round ${round} failed without a persisted reason`);
    }
    return { round, process, outputs, currentResult: latestProgress, status: "failed", failureReason: reason };
  }

  if (ordered.some((observation) => observation.runStatus === "running")) {
    return { round, process, outputs, currentResult: latestProgress, status: "running" };
  }
  return { round, process, outputs, currentResult: latestProgress, status: "completed" };
}

export interface TaskExecutionDetail {
  taskId: string;
  taskName: string;
  rounds: readonly TaskExecutionRound[];
  observedAt: number;
}

export interface TaskExecutionDetailDataSource {
  /** Returns one transactionally consistent snapshot, or null when the task does not exist. */
  taskExecutionDetail(taskId: string): Promise<TaskExecutionDetail | null>;
}

export interface TaskExecutionDetailRequest {
  taskId: string;
}

export type TaskExecutionDetailResponse =
  | { status: 200; body: TaskExecutionDetail }
  | { status: 404; body: { error: "task_not_found"; taskId: string } };

/** The detail endpoint owns no execution state and reads only the central store snapshot. */
export async function getTaskExecutionDetail(
  source: TaskExecutionDetailDataSource,
  request: TaskExecutionDetailRequest,
): Promise<TaskExecutionDetailResponse> {
  const detail = await source.taskExecutionDetail(request.taskId);
  if (detail === null) {
    return { status: 404, body: { error: "task_not_found", taskId: request.taskId } };
  }
  return { status: 200, body: detail };
}

export const taskExecutionDetailRoute = "/api/tasks/:taskId";
