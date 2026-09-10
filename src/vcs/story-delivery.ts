import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StoryDeliveryPort } from "../orchestrator/story-worker.js";
import { normalizeActualFootprint, type ActualFootprintRecorder } from "./actual-footprint.js";
import type { MRPort } from "./mr/types.js";

const execFileAsync = promisify(execFile);

export interface GitCommandPort {
  run(cwd: string, args: string[]): Promise<string>;
}

export const processGitCommand: GitCommandPort = {
  async run(cwd, args) {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  },
};

function epicBranch(epicId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(epicId)) throw new Error("Epic id cannot be used in a branch name");
  return `epic/${epicId}`;
}

export interface GitMrDeliveryOptions {
  worktreePath: string;
  targetBranch?: string;
  git?: GitCommandPort;
  actualFootprints?: ActualFootprintRecorder;
}

/**
 * Publishes a clean Story branch and opens its review request.
 *
 * A Story inside an Epic opens a draft MR onto the Epic branch, not onto the
 * target branch: the Epic MR stays the only way work reaches main, but a Story
 * whose only visible trace was a row in a database was, in practice, a Story
 * nobody could look at. The draft is the deliverable a person can read, review
 * and comment on while the Epic is still filling up. A standalone Story opens
 * a normal MR onto the target branch.
 */
export class GitMrStoryDelivery implements StoryDeliveryPort {
  private readonly git: GitCommandPort;

  constructor(
    private readonly mr: MRPort,
    private readonly options: GitMrDeliveryOptions,
  ) {
    this.git = options.git ?? processGitCommand;
  }

  async deliver(input: Parameters<StoryDeliveryPort["deliver"]>[0]): Promise<{ mrUrl: string | null }> {
    const { story } = input;
    if (!story.repo) throw new Error("Story repository is required for MR creation");
    if (!story.branch) throw new Error("Story branch is required for MR creation");
    if (["main", "master"].includes(story.branch.toLowerCase())) {
      throw new Error("refusing to publish a protected branch as a Story branch");
    }
    const current = (await this.git.run(this.options.worktreePath, ["branch", "--show-current"])).trim();
    if (current !== story.branch) {
      throw new Error(`worktree branch mismatch: expected ${story.branch}, got ${current || "detached HEAD"}`);
    }
    const status = await this.git.run(this.options.worktreePath, ["status", "--porcelain"]);
    if (status.trim() !== "") throw new Error("worktree has uncommitted changes at delivery");
    await this.git.run(this.options.worktreePath, ["push", "--set-upstream", "origin", story.branch]);
    await this.recordActualFootprint(story.id, story.branch);
    // A Story in an Epic stacks onto the Epic branch it is about to land on.
    const targetBranch = story.epicId
      ? epicBranch(story.epicId)
      : this.options.targetBranch ?? story.targetBranch ?? "main";
    const request = { repository: story.repo, sourceBranch: story.branch, targetBranch };
    // A second delivery of the same branch (the Epic head refused the first
    // one after its request was opened) reuses the open request.
    const open = await this.mr.findOpen?.(request);
    if (open) return { mrUrl: open };
    // A branch the target already contains has nothing to review; the hosting
    // platform refuses such a request, and refusing here says why.
    const ahead = (await this.git.run(this.options.worktreePath, ["rev-list", "--count", `origin/${targetBranch}..${story.branch}`])).trim();
    if (ahead === "0") {
      console.warn(`Story ${story.id}: ${targetBranch} already contains ${story.branch}; no review request to open`);
      return { mrUrl: null };
    }
    const result = await this.mr.create({
      ...request,
      title: `[${story.id}] ${story.title}`,
      body: input.mergeArtifact,
      ...(story.epicId ? { draft: true } : {}),
    });
    return { mrUrl: result.url };
  }

  /** The published diff is what the Story really touched; DECOMPOSE is scored against it. */
  private async recordActualFootprint(storyId: string, branch: string): Promise<void> {
    const footprints = this.options.actualFootprints;
    if (!footprints) return;
    const targetBranch = this.options.targetBranch ?? "main";
    const baseRevision = (await this.git.run(this.options.worktreePath, ["merge-base", `origin/${targetBranch}`, branch])).trim();
    const storyRevision = (await this.git.run(this.options.worktreePath, ["rev-parse", "HEAD"])).trim();
    const nameStatus = await this.git.run(
      this.options.worktreePath,
      ["diff", "--name-status", "-z", "--find-renames", baseRevision, storyRevision],
    );
    await footprints.capture({
      storyId,
      integrationBranch: targetBranch,
      baseRevision,
      storyRevision,
      actualFootprint: normalizeActualFootprint(nameStatus),
    });
    await footprints.apply(storyId);
  }
}
