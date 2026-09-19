import type { Client } from "@libsql/client";
import type { GitCommandPort } from "../vcs/story-delivery.js";
import { processGitCommand } from "../vcs/story-delivery.js";

export interface EpicBranchFreshnessOptions {
  worktreePath: string | ((epicId: string) => string);
  git?: GitCommandPort;
  intervalMs?: number;
  mainBranch?: string;
  now?: () => number;
}

export type FreshnessResult =
  | { epicId: string; outcome: "succeeded" | "skipped" }
  | { epicId: string; outcome: "failed"; reason: string };

/** Refreshes clean Epic worktrees from main, including those awaiting review,
 * and leaves main untouched. */
/**
 * The failure a person reads, with the files it stopped on. Without them the
 * reason is `Command failed: git merge --no-ff origin/main`, which says that
 * something is wrong and nothing about what to open.
 */
function withConflictedFiles(reason: string, files: readonly string[]): string {
  return files.length === 0 ? reason : `${reason}; conflicts in ${files.join(", ")}`;
}

export class EpicBranchFreshness {
  private readonly git: GitCommandPort;
  private readonly intervalMs: number;
  private readonly mainBranch: string;
  private readonly now: () => number;

  constructor(private readonly client: Client, private readonly options: EpicBranchFreshnessOptions) {
    this.git = options.git ?? processGitCommand;
    this.intervalMs = options.intervalMs ?? 86_400_000;
    this.mainBranch = options.mainBranch ?? "main";
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 1) throw new Error("freshness interval must be a positive integer");
  }

  async tick(): Promise<FreshnessResult[]> {
    // EPIC_ACCEPT as well as EXECUTING. An Epic waiting for a person to merge
    // it is exactly when main keeps moving and nobody is rebasing: E1ACTION sat
    // in review for a day, main took 28 commits, and the review request rotted
    // into a conflict that no part of the system was watching. Dropping the
    // branch the moment its review request opens abandons it in the window
    // where it is most likely to go stale.
    // BLOCKED as well: an Epic blocked because its own head fails a check is
    // waiting for exactly the fix that arrives on main, and a branch nobody
    // refreshes never receives it.
    const epics = (await this.client.execute(
      `SELECT id, integration_branch FROM epics
        WHERE state IN ('EXECUTING','EPIC_ACCEPT','BLOCKED') AND integration_branch IS NOT NULL
        ORDER BY created_at, id`,
    )).rows;
    const results: FreshnessResult[] = [];
    for (const epic of epics) results.push(await this.refresh(String(epic.id), String(epic.integration_branch)));
    return results;
  }

  private async refresh(epicId: string, integrationBranch: string): Promise<FreshnessResult> {
    const cwd = typeof this.options.worktreePath === "function" ? this.options.worktreePath(epicId) : this.options.worktreePath;
    // Merging the local ref would refresh the Epic against whatever this host
    // last happened to pull, which on an idle worker is nothing at all.
    const source = `origin/${this.mainBranch}`;
    // The network is not this host's fault and not the Epic's: a fetch that
    // fails is this refresh failing, not the whole orchestrator cycle.
    try {
      await this.git.run(cwd, ["fetch", "origin", this.mainBranch]);
    } catch (cause) {
      const reason = `fetch of ${source} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      return { epicId, outcome: "failed", reason };
    }
    const sourceRevision = (await this.git.run(cwd, ["rev-parse", source])).trim();
    const time = this.now();
    // The last attempt that settled, not the last one that worked. Keyed on
    // success alone, an Epic whose merge conflicts has no recent success ever,
    // so the interval never applies and every cycle runs another fetch, merge
    // and abort against an unchanged main -- the same answer, two rows, and a
    // warning line, every cycle for as long as the conflict lives. R237511OV
    // did that for hours and put 4523 rows in this table (2026-09-20).
    //
    // A success is throttled on time alone, as before. A failure is throttled
    // on time and on main standing still, because main moving is the one thing
    // that can change the answer -- so the branch is retried the moment the
    // conflict could have been resolved upstream, and not before.
    const last = (await this.client.execute({
      sql: `SELECT ts, outcome, source_revision FROM epic_branch_refresh_events
            WHERE epic_id = ? AND outcome IN ('succeeded','failed') ORDER BY ts DESC, id DESC LIMIT 1`,
      args: [epicId],
    })).rows[0];
    const settled = typeof last?.ts === "number" && time - last.ts < this.intervalMs;
    const answerCannotHaveChanged = last?.outcome === "succeeded"
      || String(last?.source_revision ?? "") === sourceRevision;
    if (settled && answerCannotHaveChanged) {
      // Not recorded: nothing reads a skip. The interval query reads
      // 'succeeded' and the progress probe reads 'succeeded' and 'failed', so
      // a row per cycle per Epic only grows the table -- one Epic had 742 of
      // them in a day, each saying that nothing happened.
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
      await this.git.run(cwd, ["merge", "--no-ff", source]);
    } catch (cause) {
      const reason = withConflictedFiles(
        cause instanceof Error ? cause.message : String(cause),
        // Read before the abort, which is what removes them. git writes the
        // conflicted paths to stdout, and the port keeps only stderr, so the
        // failure reaching the progress probe named no file at all: a person
        // was told the Epic could not take main and not where to look.
        await this.conflictedFiles(cwd),
      );
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

  /** The paths git stopped on, or none when the failure was not a conflict. */
  private async conflictedFiles(cwd: string): Promise<readonly string[]> {
    try {
      const unresolved = await this.git.run(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      return unresolved.split("\n").map((line) => line.trim()).filter((line) => line !== "").toSorted();
    } catch {
      // The worktree cannot be inspected either; the caller reports the merge
      // failure on its own, which is still more than nothing.
      return [];
    }
  }

  private async record(epicId: string, outcome: "attempted" | "succeeded" | "skipped" | "failed", sourceRevision: string, time: number, reason?: string): Promise<void> {
    await this.client.execute({
      sql: "INSERT INTO epic_branch_refresh_events (epic_id, outcome, source_revision, ts, failure_reason) VALUES (?, ?, ?, ?, ?)",
      args: [epicId, outcome, sourceRevision, time, reason ?? null],
    });
  }
}
