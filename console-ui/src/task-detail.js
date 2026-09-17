/**
 * The browser's view of one task's execution detail.
 *
 * This module is the JavaScript the page actually loads: the console is served
 * straight from the worktree, so what runs in the browser has to be plain ES
 * modules. `task-detail.ts` beside it is the same contract with types, for
 * code that is compiled.
 */

export const taskExecutionDetailPageRoute = "/tasks/:taskId";

/** Encodes the selected identifier so task navigation cannot leak another task's data. */
export function taskExecutionDetailPath(taskId) {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

/** The read endpoint for one task, scoped by the same encoded identifier. */
export function taskExecutionDetailRequestPath(taskId) {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

/** A later selection supersedes an earlier in-flight request for the same page owner. */
export async function loadTaskExecutionDetail(client, taskId, signal) {
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
