import { normalizeActualFootprint, type ActualFootprintRecorder } from "./actual-footprint.js";

export interface MergeGitPort {
  run(cwd: string, args: string[]): Promise<string>;
}

export interface MergeStory {
  id: string;
  branch: string;
  predictedFootprint: readonly string[];
  scenarioIds?: readonly string[];
}

export interface SubsetVerifier {
  (scenarioIds: readonly string[]): Promise<{ passed: boolean; scenarioIds: readonly string[] }>;
}

export interface EpicMergeFlowOptions {
  storyWorktree: string;
  integrationWorktree: string;
  mainBranch?: string;
  actualFootprints?: ActualFootprintRecorder;
}

export type MergeResult =
  | { kind: "merged"; integrationBranch: string; scenarioIds: readonly string[] }
  | { kind: "conflict"; integrationBranch: string; reason: string }
  | { kind: "verification_failed"; integrationBranch: string; scenarioIds: readonly string[]; reason?: string };

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

  async merge(input: { epicId: string; story: MergeStory; integratedStories: readonly MergeStory[] }): Promise<MergeResult> {
    const target = integrationBranch(input.epicId);
    await this.ensureIntegrationBranch(target);
    await this.requireCleanIntegrationBranch();
    await this.requireCleanStoryBranch(input.story.branch);
    try {
      await this.git.run(this.options.storyWorktree, ["rebase", target]);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      try {
        const unresolved = await this.git.run(this.options.storyWorktree, ["diff", "--name-only", "--diff-filter=U"]);
        if (unresolved.trim() !== "") return { kind: "conflict", integrationBranch: target, reason };
      } catch (inspectionCause) {
        const inspectionReason = inspectionCause instanceof Error ? inspectionCause.message : String(inspectionCause);
        return { kind: "verification_failed", integrationBranch: target, scenarioIds: [], reason: `${reason}; unable to inspect rebase state: ${inspectionReason}` };
      }
      return { kind: "verification_failed", integrationBranch: target, scenarioIds: [], reason };
    }
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
    const verification = await this.verifySubset(scenarioIds);
    if (!verification.passed || verification.scenarioIds.join("\0") !== scenarioIds.join("\0")) {
      return { kind: "verification_failed", integrationBranch: target, scenarioIds };
    }
    if (this.options.actualFootprints) {
      const baseRevision = (await this.git.run(this.options.integrationWorktree, ["rev-parse", "HEAD"])).trim();
      const storyRevision = (await this.git.run(this.options.storyWorktree, ["rev-parse", "HEAD"])).trim();
      const nameStatus = await this.git.run(this.options.integrationWorktree, ["diff", "--name-status", "-z", "--find-renames", baseRevision, storyRevision]);
      await this.options.actualFootprints.capture({
        storyId: input.story.id,
        integrationBranch: target,
        baseRevision,
        storyRevision,
        actualFootprint: normalizeActualFootprint(nameStatus),
      });
    }
    await this.git.run(this.options.integrationWorktree, ["merge", "--ff-only", input.story.branch]);
    if (this.options.actualFootprints) await this.options.actualFootprints.apply(input.story.id);
    return { kind: "merged", integrationBranch: target, scenarioIds };
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

  private async requireCleanStoryBranch(branch: string): Promise<void> {
    const current = (await this.git.run(this.options.storyWorktree, ["branch", "--show-current"])).trim();
    if (current !== branch) throw new Error(`worktree branch mismatch: expected ${branch}, got ${current || "detached HEAD"}`);
    const status = await this.git.run(this.options.storyWorktree, ["status", "--porcelain"]);
    if (status.trim() !== "") throw new Error("worktree has uncommitted changes at integration");
  }
}
