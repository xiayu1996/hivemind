import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StoryDeliveryPort } from "../orchestrator/story-worker.js";

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

/** Publishes a clean Story branch for integration; only Epic delivery may create an MR. */
export class GitMrStoryDelivery implements StoryDeliveryPort {
  private readonly git: GitCommandPort;

  constructor(
    _mr: unknown,
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
    void input.mergeArtifact;
    return { mrUrl: null };
  }
}
