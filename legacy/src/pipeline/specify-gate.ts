import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestSource } from "./dod.js";
import { matchesAnyGlob } from "./path-glob.js";
import { parseTestReport } from "./test-report.js";
import type { ChangedPath, SpecExitPorts, TestRunReport } from "./spec-exit-gate.js";

/** Runs a command in the worktree and hands back whatever it printed. */
export interface CommandPort {
  run(argv: readonly string[]): Promise<{ stdout: string; stderr: string; ok: boolean }>;
}

export interface SpecifyGatePortsInput {
  worktreePath: string;
  /** Runs git; the gate does not care how. */
  git: (args: readonly string[]) => Promise<string>;
  command: CommandPort;
  /** The declared test command, from `specifyExit.testCommand`. */
  testCommand: readonly string[];
  testPathPatterns: readonly string[];
}

function lines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * The repository side of the SPECIFY exit.
 *
 * Everything here measures the worktree rather than reading the session's
 * account of it: the phase is asked to prove its tests fail, and a phase that
 * could report its own red would have nothing left to prove.
 */
export function specifyGatePorts(input: SpecifyGatePortsInput): SpecExitPorts {
  const { git, worktreePath } = input;
  return {
    async changedPaths(baseCommit: string): Promise<readonly ChangedPath[]> {
      // Committed and uncommitted alike: the phase may have committed some of
      // its trespass, and the tree-pin is about the tree, not about the index.
      const tracked = lines(await git(["diff", "--name-status", baseCommit]));
      const untracked = lines(await git(["ls-files", "--others", "--exclude-standard"]));
      const changed = new Map<string, ChangedPath>();
      for (const row of tracked) {
        const [status, ...rest] = row.split(/\s+/);
        const path = rest.at(-1);
        if (!path) continue;
        changed.set(path, { path, existedBefore: !status?.startsWith("A") });
      }
      for (const path of untracked) changed.set(path, { path, existedBefore: false });
      return [...changed.values()].toSorted((a, b) => a.path.localeCompare(b.path, "en"));
    },

    async revert(baseCommit: string, paths: readonly string[]): Promise<void> {
      if (paths.length === 0) return;
      // A path the baseline never had cannot be checked out of it, so it is
      // removed instead; git answers which is which rather than the caller
      // guessing from the earlier listing.
      for (const path of paths) {
        try {
          await git(["cat-file", "-e", `${baseCommit}:${path}`]);
          await git(["checkout", baseCommit, "--", path]);
        } catch {
          // Absent at the baseline: the phase created it, so it goes away. The
          // index entry and the file are removed separately because a file the
          // phase never staged is invisible to `git rm`, and leaving it on disk
          // would put the trespass straight into the freeze commit.
          await git(["rm", "-f", "--ignore-unmatch", "--", path]);
          await rm(join(worktreePath, path), { force: true, recursive: true });
        }
      }
    },

    async readTestSources(): Promise<readonly TestSource[]> {
      const tracked = lines(await git(["ls-files"]))
        .filter((path) => matchesAnyGlob(path, input.testPathPatterns));
      const sources: TestSource[] = [];
      for (const path of tracked) {
        try {
          sources.push({ path, content: await readFile(join(worktreePath, path), "utf8") });
        } catch {
          // Listed but gone from the tree; it carries no marker now.
        }
      }
      return sources;
    },

    async runTests(): Promise<TestRunReport> {
      if (input.testCommand.length === 0) {
        throw new Error(
          "this repository declares no specifyExit.testCommand, so a red cannot be proved; declare one before freezing a test contract",
        );
      }
      const result = await input.command.run(input.testCommand);
      // A failing exit code is the expected case here: the tests are supposed
      // to fail. What matters is the report, not the status.
      return parseTestReport(`${result.stdout}\n${result.stderr}`, worktreePath);
    },

    async commit(message: string): Promise<{ commit: string; treeSha: string }> {
      await git(["add", "--all"]);
      // A phase that committed its own red leaves nothing here to freeze. The
      // freeze is about the tree being pinned, not about who pinned it, so
      // HEAD is answered rather than an empty commit attempted: `git commit`
      // calls that an error and says why on stdout, so it reaches the caller
      // as a failure carrying no reason at all -- which is how a SPECIFY that
      // had done everything right came back as an unclassifiable crash.
      const staged = lines(await git(["diff", "--cached", "--name-only"]));
      if (staged.length > 0) await git(["commit", "-m", message]);
      return {
        commit: (await git(["rev-parse", "HEAD"])).trim(),
        treeSha: (await git(["rev-parse", "HEAD^{tree}"])).trim(),
      };
    },

    async currentTreeSha(): Promise<string> {
      await git(["add", "--all"]);
      return (await git(["write-tree"])).trim();
    },

    async isClean(): Promise<boolean> {
      return (await git(["status", "--porcelain"])).trim() === "";
    },
  };
}
