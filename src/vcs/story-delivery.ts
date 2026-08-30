import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StoryDeliveryPort } from "../orchestrator/story-worker.js";
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

export interface GitMrDeliveryOptions {
  worktreePath: string;
  targetBranch?: string;
  git?: GitCommandPort;
}

/** Publishes only a clean Story branch, then creates its MR through the provider-neutral port. */
export class GitMrStoryDelivery implements StoryDeliveryPort {
  private readonly targetBranch: string | undefined;
  private readonly git: GitCommandPort;

  constructor(
    private readonly mr: MRPort,
    private readonly options: GitMrDeliveryOptions,
  ) {
    this.targetBranch = options.targetBranch;
    this.git = options.git ?? processGitCommand;
  }

  async deliver(input: Parameters<StoryDeliveryPort["deliver"]>[0]): Promise<{ mrUrl: string }> {
    const { story } = input;
    if (!story.repo) throw new Error("Story repository is required for MR creation");
    if (!story.branch) throw new Error("Story branch is required for MR creation");
    const targetBranch = this.targetBranch ?? story.targetBranch ?? "main";
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
    const result = await this.mr.create({
      repository: story.repo,
      sourceBranch: story.branch,
      targetBranch,
      title: `[${story.id}] ${story.title}`,
      body: input.mergeArtifact,
    });
    return { mrUrl: result.url };
  }
}
