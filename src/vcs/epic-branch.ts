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
 * Idempotent, and idempotent under concurrency: two callers reach here by
 * design — the plan approval publishes the branch while the first Story's
 * dispatch makes sure it exists — so every check can go stale between reading
 * and acting on it. Both recoveries ask git what is true now rather than
 * reading the error text. An existing local branch is kept, an existing remote
 * branch is left as it is, and a push is a plain push, so a diverged remote
 * still fails loudly rather than being overwritten.
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
  if ((await localHead(input.git, cwd, branch)) === null) {
    await input.git.run(cwd, ["fetch", "origin", main]);
    try {
      await input.git.run(cwd, ["branch", branch, `origin/${main}`]);
    } catch (error) {
      // A branch that appeared in this window is the other caller's, cut from
      // the same start point, so it is the branch we were about to create.
      if ((await localHead(input.git, cwd, branch)) === null) throw error;
    }
  }
  let pushed = true;
  try {
    await input.git.run(cwd, ["push", "--set-upstream", "origin", branch]);
  } catch (error) {
    // The other caller's push can land between the ls-remote above and this
    // one. A remote carrying exactly the commit we were publishing is the
    // outcome we wanted, whoever wrote it; anything else is a real failure.
    const published = (await input.git.run(cwd, ["ls-remote", "--heads", "origin", branch])).trim();
    const mine = await localHead(input.git, cwd, branch);
    if (mine === null || !published.startsWith(mine)) throw error;
    pushed = false;
  }
  return { branch, pushed };
}

/** The commit the local branch points at, or null when it does not exist. */
async function localHead(git: EpicBranchGitPort, cwd: string, branch: string): Promise<string | null> {
  return git.run(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then((out) => out.trim() || null, () => null);
}
