import type { PrototypeDelivery, PrototypeResult } from "../orchestrator/prototype-runner.js";
import { processGitCommand, type GitCommandPort } from "./story-delivery.js";
import type { MRPort } from "./mr/types.js";

/**
 * Puts a drawn interface contract up for review.
 *
 * It goes in as a merge request rather than onto the target branch directly
 * for the same reason everything else does: a contract every later card is
 * built against is exactly the kind of decision that should be readable before
 * it binds anything. The person approves it together with the solution it
 * belongs to, so the request is opened and left open.
 *
 * Only the contract directory is committed. The write fence already refuses
 * anything else, but a fence made of path patterns cannot claim to have
 * enumerated every way a file gets written, so what leaves the machine is
 * named here as well.
 */

export interface GitPrototypeDeliveryOptions {
  /** The worktree the contract was drawn in. */
  worktreePath: string;
  /** Contract directory relative to that worktree. */
  contractRoot: string;
  repository: string;
  targetBranch: string;
  git?: GitCommandPort;
}

export class GitPrototypeDelivery implements PrototypeDelivery {
  private readonly git: GitCommandPort;

  constructor(private readonly mr: MRPort, private readonly options: GitPrototypeDeliveryOptions) {
    this.git = options.git ?? processGitCommand;
  }

  async publish(input: {
    requirementId: string;
    title: string;
    result: PrototypeResult;
  }): Promise<{ url: string } | null> {
    const branch = prototypeBranch(input.requirementId);
    const run = (args: string[]) => this.git.run(this.options.worktreePath, args);
    await run(["add", "--", this.options.contractRoot]);
    const staged = await run(["diff", "--cached", "--name-only"]);
    // Nothing staged means the drawing wrote nothing new: the contract that is
    // already on the branch is the one it decided on. There is no review to
    // open, and opening an empty one would read as a change nobody made.
    if (staged.trim() === "") return null;
    await run(["commit", "-m", commitMessage(input.requirementId, input.title)]);
    await run(["push", "--force-with-lease", "--set-upstream", "origin", branch]);

    const request = {
      repository: this.options.repository,
      sourceBranch: branch,
      targetBranch: this.options.targetBranch,
    };
    const open = await this.mr.findOpen?.(request);
    if (open) return { url: open };
    const created = await this.mr.create({
      ...request,
      title: `[${input.requirementId}] ${input.title} 的界面契约`,
      body: body(input.result),
    });
    return { url: created.url };
  }
}

export function prototypeBranch(requirementId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(requirementId)) {
    throw new Error("requirement id cannot be used in a branch name");
  }
  return `prototype/${requirementId}`;
}

function commitMessage(requirementId: string, title: string): string {
  return `Draw the screens ${title} will be built against\n\nRequirement: ${requirementId}\n`;
}

/** What a person reads before approving the solution: which page carries which
 * scenario, and anything the drawing wanted to say about the plan itself. */
function body(result: PrototypeResult): string {
  const lines = ["## 页面与它承接的场景", ""];
  for (const page of [...result.pages].toSorted((left, right) => left.file < right.file ? -1 : 1)) {
    lines.push(`- \`${page.file}\`：${page.scenarios.join("、")}`);
  }
  if (result.concerns.length > 0) {
    lines.push("", "## 画的时候发现的问题", "");
    for (const concern of result.concerns) lines.push(`- ${concern}`);
  }
  lines.push("", "每页都能以 `?state=empty` / `loading` / `error` / `waiting` 看四态。");
  return lines.join("\n");
}
