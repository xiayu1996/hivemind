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
export declare function projectTaskExecutionDetail(input: TaskExecutionProjectionInput): TaskExecutionDetail;

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
export declare function getTaskExecutionDetail(
  source: TaskExecutionDetailDataSource,
  request: TaskExecutionDetailRequest,
): Promise<TaskExecutionDetailResponse>;

export declare const taskExecutionDetailRoute: "/api/tasks/:taskId";
