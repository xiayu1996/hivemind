import { normalizeActualFootprint, type ActualFootprintRecorder } from "./actual-footprint.js";
import { unpredictedDirectories } from "../orchestrator/footprint-deviation.js";

export interface MergeGitPort {
  run(cwd: string, args: string[]): Promise<string>;
}

export interface MergeStory {
  id: string;
  branch: string;
  predictedFootprint: readonly string[];
  scenarioIds?: readonly string[];
}

/** Why a re-verification failed, which decides what it costs the Story. */
export type MergeFailureAttribution =
  /** The checks pass on the Epic head and fail with the Story on top. */
  | "story_regression"
  /** The same check fails on the Epic head alone; the Story is not the cause. */
  | "baseline_failing"
  /** The check could not be run at all. */
  | "environment";

export interface SubsetVerificationRequest {
  scenarioIds: readonly string[];
  /** The rebased Story tree, which is what a fast-forward would land. */
  candidate: { cwd: string; revision: string };
  /** The Epic head without this Story, for telling the two apart. */
  base: { cwd: string; revision: string };
  /** What the Story changes, for deciding which checks are relevant. */
  changedPaths: readonly string[];
}

export interface SubsetVerification {
  passed: boolean;
  scenarioIds: readonly string[];
  /** What the verifier and the verdict checks said about the failures; the
   * Story's next CODE round is written from these. */
  reasons?: readonly string[];
  attribution?: MergeFailureAttribution;
  /** The names the checks themselves gave what broke. */
  failures?: readonly string[];
  failedChecks?: readonly string[];
  /** Checks that actually ran; empty means nothing was relevant. */
  ranChecks?: readonly string[];
}

export interface SubsetVerifier {
  (request: SubsetVerificationRequest): Promise<SubsetVerification>;
}

export interface EpicMergeFlowOptions {
  storyWorktree: string;
  integrationWorktree: string;
  mainBranch?: string;
  actualFootprints?: ActualFootprintRecorder;
  /**
   * Called when the diff reached outside the Story's predicted footprint.
   *
   * Not a refusal: a prediction made before the work is a prediction, and the
   * connected change a card has to make next door is ordinary. But nothing at
   * all was said about it before -- the deviation was computed, stored, and
   * read by no production code -- so a card that rewrote the verifier judging
   * it and the build configuration every other card shares passed through
   * every gate in silence, and those changes are still on its Epic branch.
   * Recording it is what makes the size of the problem answerable.
   */
  onFootprintOverreach?: (overreach: {
    storyId: string;
    predicted: readonly string[];
    actual: readonly string[];
    unpredicted: readonly string[];
  }) => Promise<void>;
}

/**
 * Opens the Story's review request once the branch sits on the Epic head. It
 * runs before the subset re-verification and the fast-forward, so the request
 * shows the Story's own diff; opened afterwards it would be empty, since the
 * Epic branch already contains every commit.
 */
export type StoryPublisher = (story: MergeStory) => Promise<{ mrUrl: string | null }>;

export type MergeResult =
  | { kind: "merged"; integrationBranch: string; scenarioIds: readonly string[]; mrUrl: string | null }
  | { kind: "conflict"; integrationBranch: string; reason: string; files: readonly string[] }
  | {
      kind: "verification_failed";
      integrationBranch: string;
      scenarioIds: readonly string[];
      reason?: string;
      attribution?: MergeFailureAttribution;
      failures?: readonly string[];
      failedChecks?: readonly string[];
      baseRevision?: string;
      candidateRevision?: string;
    };

function integrationBranch(epicId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(epicId)) throw new Error("Epic id cannot be used in a branch name");
  return `epic/${epicId}`;
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  return left.some((path) => right.some((other) => pathsIntersect(path, other)));
}

/** Merges a clean Story only after it has been rebased and its affected scenarios pass. */
export class EpicMergeFlow {
  private readonly mainBranch: string;

  constructor(
    private readonly git: MergeGitPort,
    private readonly verifySubset: SubsetVerifier,
    private readonly options: EpicMergeFlowOptions,
  ) {
    this.mainBranch = options.mainBranch ?? "main";
  }

  async merge(input: {
    epicId: string;
    story: MergeStory;
    integratedStories: readonly MergeStory[];
    publish?: StoryPublisher;
  }): Promise<MergeResult> {
    const target = integrationBranch(input.epicId);
    await this.ensureIntegrationBranch(target);
    await this.requireCleanIntegrationBranch();
    await this.requireCleanStoryBranch(input.story.branch);
    try {
      await this.git.run(this.options.storyWorktree, ["rebase", target]);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      let files: readonly string[] | undefined;
      let inspectionReason: string | undefined;
      try {
        const unresolved = await this.git.run(this.options.storyWorktree, ["diff", "--name-only", "--diff-filter=U"]);
        if (unresolved.trim() !== "") {
          // The files, not just git's prose. They are what a count of these
          // conflicts is worth reading by, and what tells a later round which
          // ground two Stories are competing for.
          files = unresolved.split("\n").map((line) => line.trim()).filter((line) => line !== "").toSorted();
        }
      } catch (inspectionCause) {
        inspectionReason = inspectionCause instanceof Error ? inspectionCause.message : String(inspectionCause);
      }
      // Read the conflict first, then put the worktree back. A rebase left
      // standing owns that worktree: it sits detached with the conflict in the
      // tree, and every later dispatch of this card refuses to start because
      // the worktree is not on the Story branch. The conflict is something to
      // report, not something to keep.
      const abandoned = await this.abandonRebase();
      const detail = abandoned === undefined ? reason : `${reason}; ${abandoned}`;
      if (inspectionReason !== undefined) {
        return {
          kind: "verification_failed",
          integrationBranch: target,
          scenarioIds: [],
          reason: `${detail}; unable to inspect rebase state: ${inspectionReason}`,
        };
      }
      if (files !== undefined) return { kind: "conflict", integrationBranch: target, reason: detail, files };
      return { kind: "verification_failed", integrationBranch: target, scenarioIds: [], reason: detail };
    }
    // Published while the branch is rebased and still ahead of the Epic head.
    // A later refusal leaves the request open as a draft, and the next attempt
    // finds it again rather than opening a second one.
    const published = input.publish ? await input.publish(input.story) : { mrUrl: null };
    const affectedStories = [
      input.story,
      ...input.integratedStories.filter((story) => intersects(input.story.predictedFootprint, story.predictedFootprint)),
    ];
    const missingMapping = affectedStories.find((story) => !story.scenarioIds || story.scenarioIds.length === 0);
    if (missingMapping) {
      return {
        kind: "verification_failed",
        integrationBranch: target,
        scenarioIds: [],
        reason: `missing scenario mapping for Story ${missingMapping.id}`,
      };
    }
    const scenarioIds = [...new Set(affectedStories.flatMap((story) => story.scenarioIds!))].toSorted();
    // What the re-verification ran against has to be what gets merged. The
    // checks therefore run in the rebased Story worktree, which is the tree a
    // fast-forward lands, and not in the integration worktree, which at this
    // point still holds the Epic head without this Story: running them there
    // asked whether the Epic head was green, a question the Story cannot
    // change however many rounds it spends. Both revisions are read before and
    // after, because a green merge nobody verified is the same defect whether
    // the tree moved under the candidate or under the base it was judged
    // against.
    const verifiedRevision = (await this.git.run(this.options.storyWorktree, ["rev-parse", "HEAD"])).trim();
    const baseRevision = (await this.git.run(this.options.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    const changedPaths = (await this.git.run(
      this.options.integrationWorktree,
      ["diff", "--name-only", baseRevision, verifiedRevision],
    )).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    const verification = await this.verifySubset({
      scenarioIds,
      candidate: { cwd: this.options.storyWorktree, revision: verifiedRevision },
      base: { cwd: this.options.integrationWorktree, revision: baseRevision },
      changedPaths,
    });
    const revisionNow = (await this.git.run(this.options.storyWorktree, ["rev-parse", "HEAD"])).trim();
    const baseNow = (await this.git.run(this.options.integrationWorktree, ["rev-parse", "HEAD"])).trim();
    if (revisionNow !== verifiedRevision || baseNow !== baseRevision) {
      const moved = revisionNow !== verifiedRevision
        ? `the Story branch moved during re-verification: verified ${verifiedRevision}, now ${revisionNow}`
        : `the Epic head moved during re-verification: verified against ${baseRevision}, now ${baseNow}`;
      return {
        kind: "verification_failed",
        integrationBranch: target,
        scenarioIds,
        reason: moved,
        baseRevision,
        candidateRevision: verifiedRevision,
      };
    }
    if (!verification.passed || verification.scenarioIds.join("\0") !== scenarioIds.join("\0")) {
      const failed = verification.passed ? scenarioIds : verification.scenarioIds;
      const detail = (verification.reasons ?? []).join("; ");
      return {
        kind: "verification_failed",
        integrationBranch: target,
        scenarioIds,
        reason: `subset re-verification for ${failed.join(", ")}${detail ? `: ${detail}` : ""}`,
        ...(verification.attribution ? { attribution: verification.attribution } : {}),
        ...(verification.failures ? { failures: verification.failures } : {}),
        ...(verification.failedChecks ? { failedChecks: verification.failedChecks } : {}),
        baseRevision,
        candidateRevision: verifiedRevision,
      };
    }
    if (this.options.actualFootprints || this.options.onFootprintOverreach) {
      const nameStatus = await this.git.run(this.options.integrationWorktree, ["diff", "--name-status", "-z", "--find-renames", baseRevision, verifiedRevision]);
      const actualFootprint = normalizeActualFootprint(nameStatus);
      await this.options.actualFootprints?.capture({
        storyId: input.story.id,
        integrationBranch: target,
        baseRevision,
        storyRevision: verifiedRevision,
        actualFootprint,
      });
      const unpredicted = unpredictedDirectories(input.story.predictedFootprint, actualFootprint);
      // Reported, never refused, and never able to fail the merge: the record
      // exists to be counted, and a sink that throws would turn a bookkeeping
      // problem into a Story that cannot land.
      if (unpredicted.length > 0) {
        await this.options.onFootprintOverreach?.({
          storyId: input.story.id,
          predicted: input.story.predictedFootprint,
          actual: actualFootprint,
          unpredicted,
        }).catch(() => undefined);
      }
    }
    await this.git.run(this.options.integrationWorktree, ["merge", "--ff-only", input.story.branch]);
    // The Story's draft MR stacks onto this branch on origin, so origin has to
    // hold the head the Story was merged into, not the one it was cut from.
    await this.git.run(this.options.integrationWorktree, ["push", "--set-upstream", "origin", target]);
    if (this.options.actualFootprints) await this.options.actualFootprints.apply(input.story.id);
    return { kind: "merged", integrationBranch: target, scenarioIds, mrUrl: published.mrUrl };
  }

  private async ensureIntegrationBranch(target: string): Promise<void> {
    const current = (await this.git.run(this.options.integrationWorktree, ["branch", "--show-current"])).trim();
    if (current === target) return;
    try {
      await this.git.run(this.options.integrationWorktree, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`]);
      await this.git.run(this.options.integrationWorktree, ["switch", target]);
    } catch {
      await this.git.run(this.options.integrationWorktree, ["switch", "-c", target, this.mainBranch]);
    }
  }

  private async requireCleanIntegrationBranch(): Promise<void> {
    const status = await this.git.run(this.options.integrationWorktree, ["status", "--porcelain"]);
    if (status.trim() !== "") throw new Error("integration worktree has uncommitted changes at integration");
  }

  /** Puts the Story worktree back on its branch after a rebase stopped in it.
   * Returns what went wrong when even that fails, so the reason a person reads
   * says the tree still needs a hand rather than only naming the conflict. */
  private async abandonRebase(): Promise<string | undefined> {
    try {
      await this.git.run(this.options.storyWorktree, ["rebase", "--abort"]);
      return undefined;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `the Story worktree is still mid-rebase: ${detail}`;
    }
  }

  private async requireCleanStoryBranch(branch: string): Promise<void> {
    const current = (await this.git.run(this.options.storyWorktree, ["branch", "--show-current"])).trim();
    if (current !== branch) throw new Error(`worktree branch mismatch: expected ${branch}, got ${current || "detached HEAD"}`);
    const status = await this.git.run(this.options.storyWorktree, ["status", "--porcelain"]);
    if (status.trim() !== "") throw new Error("worktree has uncommitted changes at integration");
  }
}
