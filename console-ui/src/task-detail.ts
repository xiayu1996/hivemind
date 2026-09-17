import type { TaskExecutionDetail } from "../../src/console/task-execution-detail.js";

export interface TaskExecutionDetailClient {
  get(taskId: string, signal?: AbortSignal): Promise<TaskExecutionDetail | null>;
}

export type TaskExecutionDetailPageState =
  | { kind: "loading"; taskId: string }
  | { kind: "ready"; detail: TaskExecutionDetail }
  | { kind: "not_found"; taskId: string }
  | { kind: "error"; taskId: string; message: string };

export interface TaskSelection {
  taskId: string;
  taskName: string;
  detailHref: string;
}

/** Encodes the selected identifier so task navigation cannot leak another task's data. */
export declare function taskExecutionDetailPath(taskId: string): string;

/** A later selection supersedes an earlier in-flight request for the same page owner. */
export declare function loadTaskExecutionDetail(
  client: TaskExecutionDetailClient,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskExecutionDetailPageState>;

export declare const taskExecutionDetailPageRoute: "/tasks/:taskId";
