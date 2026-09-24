import type { RpcEvent } from "./types.js";

/** A blocking extension dialog pi is waiting on. */
export interface PendingUiPrompt {
  id: string;
  method: string;
  title: string | undefined;
}

/**
 * Dialog methods block the agent until the client writes an
 * `extension_ui_response` back on stdin. Fire-and-forget methods share the
 * `extension_ui_request` envelope but expect no answer, so counting them as
 * waiting would report a run as blocked while it is still working.
 */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Extension dialogs still awaiting an answer.
 *
 * A run blocked here is not making progress and is not failing either: it sits
 * there until the prompt timeout kills the phase, with nothing in the event
 * stream that says why. Deriving it lets the heartbeat report "waiting for a
 * person" instead of counting the wait as work.
 *
 * pi calls the same span `ui_prompt_start` / `ui_prompt_end` for in-process
 * extensions; over RPC those events are not emitted and this envelope is the
 * only signal.
 */
export function pendingUiPrompts(
  events: readonly RpcEvent[],
  answeredIds: ReadonlySet<string> = new Set(),
): PendingUiPrompt[] {
  const open = new Map<string, PendingUiPrompt>();
  for (const event of events) {
    if (event.type !== "extension_ui_request") continue;
    const id = event.id;
    const method = event.method;
    if (typeof id !== "string" || typeof method !== "string") continue;
    if (!DIALOG_METHODS.has(method)) continue;
    open.set(id, { id, method, title: typeof event.title === "string" ? event.title : undefined });
  }
  for (const id of answeredIds) open.delete(id);
  return [...open.values()];
}
