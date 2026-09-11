export interface EpicBranchGitPort {
  run(cwd: string, args: string[]): Promise<string>;
}

export interface PublishEpicBranchInput {
  git: EpicBranchGitPort;
  repositoryPath: string;
  epicId: string;
  /** The branch the Epic integrates onto and eventually merges into. */
  mainBranch?: string;
}

export function epicBranchName(epicId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(epicId)) throw new Error("Epic id cannot be used in a branch name");
  return `epic/${epicId}`;
}

/**
 * Makes the Epic's integration branch exist on origin.
 *
 * The moment an Epic plan is approved and its Stories exist is the moment the
 * branch they stack onto has to be real for everyone: the Story's draft MR
 * targets it, and `merge-base origin/<epic>` at delivery reads it. Cutting it
 * lazily at the first merge left the first Story's delivery failing on a ref
 * that only one machine had (S-E3OVERVIEW-01, 2026-09-10).
 *
 * Idempotent: an existing local branch is kept, an existing remote branch is
 * left as it is, and a push is a plain push — a diverged remote fails loudly
 * rather than being overwritten.
 */
export async function publishEpicBranch(input: PublishEpicBranchInput): Promise<{ branch: string; pushed: boolean }> {
  const branch = epicBranchName(input.epicId);
  const main = input.mainBranch ?? "main";
  const cwd = input.repositoryPath;
  const remote = (await input.git.run(cwd, ["ls-remote", "--heads", "origin", branch])).trim();
  if (remote !== "") {
    // Somebody already published it; make sure this checkout knows.
    await input.git.run(cwd, ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`]);
    return { branch, pushed: false };
  }
  const local = await input.git.run(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (!local) {
    await input.git.run(cwd, ["fetch", "origin", main]);
    await input.git.run(cwd, ["branch", branch, `origin/${main}`]);
  }
  await input.git.run(cwd, ["push", "--set-upstream", "origin", branch]);
  return { branch, pushed: true };
}
