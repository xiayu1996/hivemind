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

export const taskExecutionDetailPageRoute = "/tasks/:taskId";

/** Encodes the selected identifier so task navigation cannot leak another task's data. */
export function taskExecutionDetailPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

/** A later selection supersedes an earlier in-flight request for the same page owner. */
export async function loadTaskExecutionDetail(
  client: TaskExecutionDetailClient,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskExecutionDetailPageState> {
  try {
    const detail = await client.get(taskId, signal);
    if (detail === null) return { kind: "not_found", taskId };
    return { kind: "ready", detail };
  } catch (cause) {
    // A superseded request rethrows so its aborted response cannot replace the
    // state a newer selection already produced.
    if (signal?.aborted === true) throw cause;
    return { kind: "error", taskId, message: cause instanceof Error ? cause.message : String(cause) };
  }
}
