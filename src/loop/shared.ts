import type { AgentRun } from "../agents/run.ts";
import { PRODUCT_DIR } from "./product.ts";
import type { LoopContext } from "./context.ts";
import { render } from "./messages.ts";
import type { StepOutcome } from "./outcome.ts";

/** Commits what changed under `.hivemind/` (scratch space is excluded from git) and returns the new head. */
export async function commitProductFiles(context: LoopContext, worktree: string, message: string): Promise<string> {
  const changed = (await context.git.changedPaths(worktree, "HEAD")).filter((path) => path.startsWith(`${PRODUCT_DIR}/`));
  const sha = changed.length > 0 ? await context.git.commit(worktree, message, changed) : null;
  return sha ?? (await context.git.head(worktree));
}

/** No model can serve the session: wait for the soonest one, or for a person when none will recover alone. */
export function unavailable(context: LoopContext, run: Extract<AgentRun<unknown>, { ok: false }>): StepOutcome {
  const until = run.needsHuman ? null : (run.retryAt ?? null);
  if (until === null) {
    return {
      kind: "wait",
      waiting: { kind: "provider", until: null, detail: run.detail },
      note: render(context.messages.status.waitingProviderHuman, { detail: run.detail }),
    };
  }
  return {
    kind: "wait",
    waiting: { kind: "provider", until, detail: run.detail },
    note: render(context.messages.status.waitingProvider, { until: new Date(until).toISOString() }),
  };
}
