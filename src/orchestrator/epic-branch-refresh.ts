import type { Client } from "@libsql/client";
import type { GitCommandPort } from "../vcs/story-delivery.js";
import { processGitCommand } from "../vcs/story-delivery.js";

export interface EpicBranchFreshnessOptions {
  worktreePath: string | ((epicId: string) => string);
  git?: GitCommandPort;
  intervalMs?: number;
  now?: () => number;
}

export type FreshnessResult =
  | { epicId: string; outcome: "succeeded" | "skipped" }
  | { epicId: string; outcome: "failed"; reason: string };

/** Refreshes only clean, active Epic worktrees from main and leaves main untouched. */
export class EpicBranchFreshness {
  private readonly git: GitCommandPort;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly client: Client, private readonly options: EpicBranchFreshnessOptions) {
    this.git = options.git ?? processGitCommand;
    this.intervalMs = options.intervalMs ?? 86_400_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 1) throw new Error("freshness interval must be a positive integer");
  }

  async tick(): Promise<FreshnessResult[]> {
    const epics = (await this.client.execute(
      "SELECT id, integration_branch FROM epics WHERE state = 'EXECUTING' AND integration_branch IS NOT NULL ORDER BY created_at, id",
    )).rows;
    const results: FreshnessResult[] = [];
    for (const epic of epics) results.push(await this.refresh(String(epic.id), String(epic.integration_branch)));
    return results;
  }

  private async refresh(epicId: string, integrationBranch: string): Promise<FreshnessResult> {
    const cwd = typeof this.options.worktreePath === "function" ? this.options.worktreePath(epicId) : this.options.worktreePath;
    const sourceRevision = (await this.git.run(cwd, ["rev-parse", "main"])).trim();
    const time = this.now();
    const lastSuccess = (await this.client.execute({
      sql: `SELECT ts FROM epic_branch_refresh_events
            WHERE epic_id = ? AND outcome = 'succeeded' ORDER BY ts DESC, id DESC LIMIT 1`,
      args: [epicId],
    })).rows[0];
    if (typeof lastSuccess?.ts === "number" && time - lastSuccess.ts < this.intervalMs) {
      await this.record(epicId, "skipped", sourceRevision, time);
      return { epicId, outcome: "skipped" };
    }
    await this.record(epicId, "attempted", sourceRevision, time);
    const currentBranch = (await this.git.run(cwd, ["branch", "--show-current"])).trim();
    if (currentBranch !== integrationBranch) {
      const reason = `integration worktree branch mismatch: expected ${integrationBranch}, got ${currentBranch || "detached HEAD"}`;
      await this.record(epicId, "failed", sourceRevision, time, reason);
      return { epicId, outcome: "failed", reason };
    }
    const status = await this.git.run(cwd, ["status", "--porcelain"]);
    if (status.trim() !== "") {
      const reason = "integration worktree has uncommitted changes";
      await this.record(epicId, "failed", sourceRevision, time, reason);
      return { epicId, outcome: "failed", reason };
    }
    try {
      await this.git.run(cwd, ["merge", "--no-ff", "main"]);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      try {
        await this.git.run(cwd, ["merge", "--abort"]);
        const clean = await this.git.run(cwd, ["status", "--porcelain"]);
        if (clean.trim() !== "") {
          const failure = `${reason}; merge abort did not restore a clean integration worktree`;
          await this.record(epicId, "failed", sourceRevision, time, failure);
          return { epicId, outcome: "failed", reason: failure };
        }
      } catch (abortCause) {
        const abortReason = abortCause instanceof Error ? abortCause.message : String(abortCause);
        await this.record(epicId, "failed", sourceRevision, time, `${reason}; ${abortReason}`);
        return { epicId, outcome: "failed", reason: `${reason}; ${abortReason}` };
      }
      await this.record(epicId, "failed", sourceRevision, time, reason);
      return { epicId, outcome: "failed", reason };
    }
    await this.record(epicId, "succeeded", sourceRevision, time);
    return { epicId, outcome: "succeeded" };
  }

  private async record(epicId: string, outcome: "attempted" | "succeeded" | "skipped" | "failed", sourceRevision: string, time: number, reason?: string): Promise<void> {
    await this.client.execute({
      sql: "INSERT INTO epic_branch_refresh_events (epic_id, outcome, source_revision, ts, failure_reason) VALUES (?, ?, ?, ?, ?)",
      args: [epicId, outcome, sourceRevision, time, reason ?? null],
    });
  }
}
