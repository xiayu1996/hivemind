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
    const published = await this.publishedAhead(cwd, integrationBranch);
    const time = this.now();
    // What makes a branch due is main moving, not a clock reaching a number.
    //
    // Keyed on elapsed time since the last *success*, a branch took main once a
    // day however far main had gone, and a branch whose merge conflicts had no
    // recent success ever, so the interval never applied at all: R237511OV ran
    // another fetch, merge and abort every cycle for hours -- the same answer,
    // two rows and a warning line each time -- and put 4523 rows in this table.
    // Meanwhile R237511DT took main cleanly on 09-18, waited out its day while
    // main gained a hundred and fifty commits, and conflicted on the next try.
    // One number produced both failures at once: too slow to keep a branch
    // close to main, and no brake at all once it had fallen behind.
    //
    // So the source revision decides. A branch that has not seen this main is
    // due whatever the clock says, which keeps every refresh as small as the
    // movement that triggered it; a branch that has already answered for this
    // main is skipped, because nothing about the answer can have changed --
    // a merge would be a no-op and a conflict would conflict again. The
    // interval stays as the floor under a main that moves constantly.
    const last = (await this.client.execute({
      sql: `SELECT ts, source_revision FROM epic_branch_refresh_events
            WHERE epic_id = ? AND outcome IN ('succeeded','failed') ORDER BY ts DESC, id DESC LIMIT 1`,
      args: [epicId],
    })).rows[0];
    const settled = typeof last?.ts === "number" && time - last.ts < this.intervalMs;
    if (settled && String(last?.source_revision ?? "") === sourceRevision && !published) {
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
    // Fast-forward only, so a published branch can add to this one and can
    // never rewrite it; it is strictly ahead or this is not reached.
    if (published) await this.git.run(cwd, ["merge", "--ff-only", `refs/remotes/origin/${integrationBranch}`]);
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

  /**
   * Whether the platform holds commits for this same branch that this worktree
   * does not.
   *
   * The integration branch lives there too, and a conflict this merge cannot do
   * is one a person resolves there -- by hand, or with the host's own "update
   * branch" button. The local branch is what every Story merge and every push
   * builds on, and it never hears about that: R237511DT was resolved and pushed
   * on 09-19 while the worktree stayed 88 commits behind, so the same conflict
   * was rediscovered every cycle for a day and the eventual push would have
   * been refused as non-fast-forward.
   *
   * Asked before the throttle because it changes the answer: the same main
   * against a branch that has moved is a different question. Nothing is merged
   * here -- the worktree has not been checked yet, and a tree on the wrong
   * branch must not receive commits.
   */
  private async publishedAhead(cwd: string, integrationBranch: string): Promise<boolean> {
    try {
      await this.git.run(cwd, ["fetch", "origin", integrationBranch]);
      const behind = await this.git.run(cwd, [
        "rev-list", "--count", `HEAD..refs/remotes/origin/${integrationBranch}`,
      ]);
      return Number(behind.trim()) > 0;
    } catch {
      // No such branch on the platform yet, which is every Epic before its
      // first delivery. The local branch is the only one there is.
      return false;
    }
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
