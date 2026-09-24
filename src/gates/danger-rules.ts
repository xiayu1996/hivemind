import { relative, resolve } from "node:path";

/**
 * The red lines no session policy can relax, as pure data and matchers (no
 * I/O), so the whole table is unit-testable.
 *
 * The bash table is the only shell gate every session gets. Everything else
 * runs, because a command allowlist cannot be completed and a refused but
 * legitimate command costs the model a detour. Writes are bounded separately
 * by the workspace and fence checks, which are the guard's actual strength;
 * bash matching is a best-effort net over irreversible operations and is
 * knowingly incomplete.
 */

/** Files an agent must never write: CI/CD config, deploy manifests, and its own guardrails. */
export const DEFAULT_FENCED_PATTERNS: readonly RegExp[] = [
  // Matching is case-insensitive because macOS and Windows resolve CLAUDE.md
  // and claude.md to the same file; case-sensitive rules would be bypassable
  // there. On Linux this can deny a genuinely distinct file, which is the safe
  // direction for a guard.
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)deploy\/k8s\/(production|stage)\//i,
  /(^|\/)(CLAUDE|AGENTS)\.md$/i,
  /(^|\/)\.claude\/rules\//i,
  /(^|\/)\.agents\//i,
];

/**
 * Bash commands an agent must never run. Every entry is irreversible or removes
 * a person from a decision, which is why they are unconditional (see checkBash).
 * Each reason names what to do instead, because the model reads it and goes on.
 */
export const BANNED_BASH: readonly (readonly [RegExp, string])[] = [
  // Recursive and force are matched separately, and anywhere in the same simple
  // command, so -Rf, --recursive, split flags and flags after the operand
  // (`rm dist -rf`, which GNU rm accepts) are all the same operation.
  [
    /\brm\b[^;&|\n]*\s(?:-[a-z]*r[a-z]*\b|--recursive\b)/i,
    "recursive rm is forbidden; delete files by name (rm <file>) and empty directories with rmdir",
  ],
  [
    /\brm\b[^;&|\n]*\s(?:-[a-z]*f[a-z]*\b|--force\b)/i,
    "forced rm is forbidden; run rm without -f and read what it reports",
  ],
  // Both push rules accept git's global options before `push` (`git -C dir
  // push`), and their span stops at a command separator, so
  // `git push origin x && git checkout main` is not a push to main.
  //
  // The branch must be a whole ref token: \b would also match inside
  // story/main-refactor and deny a legitimate push. Quotes, a following
  // separator and the full `refs/heads/main` spelling still name the branch.
  [
    /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+=\S+))*\s+push\b[^;&|\n]*(?:[\s:"']|refs\/heads\/)(?:master|main)(?=[\s;&|)"']|$)/,
    "pushing to master/main is forbidden; commit on your working branch and leave integrating it to the pipeline",
  ],
  // --force-with-lease stays allowed: it is the safe form for a rebased branch
  // and aborts when the remote moved. A combined short flag (`-fu`) and a `+`
  // refspec are the same force by another spelling.
  [
    /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+=\S+))*\s+push\b[^;&|\n]*\s(?:--force(?![-\w])|-[A-Za-z]*f[A-Za-z]*(?![-\w])|\+(?=\S))/,
    "force push is forbidden; use --force-with-lease",
  ],
  [/\bgh\s+pr\s+merge\b/, "AI may not merge pull requests; leave the merge to a person"],
  [/\bgh\s+workflow\s+run\b/, "AI may not trigger CI workflows; run the same checks locally instead"],
  [/\bglab\s+mr\s+merge\b/, "AI may not merge merge requests; leave the merge to a person"],
  [/\bglab\s+ci\s+play\b/, "AI may not play CI deploy jobs; deploying is left to a person"],
];

export type GuardVerdict = { deny: false; reason?: undefined } | { deny: true; reason: string };

const FENCED_REASON =
  "fenced file: CI/CD configuration, deploy manifests and agent instruction files are never written by an agent; leave it unchanged and say in your result what should change";
const ESCAPE_REASON = "path escapes the workspace; write inside it, using a path relative to the workspace root";

/**
 * Rewrites Windows separators to posix so one rule set matches on every
 * platform. Fenced patterns are written with `/`, and a Windows agent naturally
 * produces `.claude\rules\core.md`, which would otherwise slip past them.
 *
 * A posix filename may legally contain a backslash; such a path is normalised
 * too and may be denied. That direction is safe for a guard, and the tradeoff
 * buys platform-independent tests.
 */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Joins backslash-newline continuations the way bash does before it parses,
 * so a red line cannot be split across lines (`git push \` then `--force` on
 * the next line) out of reach of the single-line patterns.
 */
export function joinLineContinuations(command: string): string {
  return command.replaceAll("\\\n", "");
}

/**
 * Reports whether `target` is `root` or sits underneath it.
 *
 * Comparison is case-insensitive on Windows so that a drive-letter or casing
 * difference does not deny a legitimate write inside the workspace.
 */
export function isWithinRoot(
  target: string,
  root: string,
  caseInsensitive: boolean = process.platform === "win32",
): boolean {
  const key = (value: string): string => {
    const posix = toPosixPath(value);
    return caseInsensitive ? posix.toLowerCase() : posix;
  };
  const t = key(target);
  let r = key(root).replace(/\/+$/, "");
  if (r === "") r = "/";
  return t === r || t.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * Red lines are UNCONDITIONAL: they are denied for every session, including
 * the one that builds, because none has a legitimate reason to destroy
 * history, publish to a protected branch, or merge without a person.
 */
export function checkBash(command: string): GuardVerdict {
  const joined = joinLineContinuations(command);
  for (const [pattern, reason] of BANNED_BASH) {
    if (pattern.test(joined)) return { deny: true, reason };
  }
  return { deny: false };
}

/**
 * Denies a write that leaves the workspace or lands on a fenced file.
 *
 * The fence is judged on the path as written and on the workspace-relative
 * path it resolves to: `.claude//rules/core.md`, `CLAUDE.md/.` and
 * `.github/x/../workflows/ci.yml` each land on a fenced file without spelling
 * one. The containment check resolves first, so `../` cannot escape.
 */
export function checkFilePath(
  filePath: string,
  root: string,
  fencedPatterns: readonly RegExp[] = DEFAULT_FENCED_PATTERNS,
): GuardVerdict {
  // Resolve both sides with the host path semantics. On Windows a POSIX-looking
  // root such as /wt/card becomes D:/wt/card; comparing the resolved candidate
  // to the unresolved root would deny every relative write.
  const workspace = resolve(root);
  const absolute = resolve(workspace, filePath);
  const candidates = [toPosixPath(filePath), toPosixPath(relative(workspace, absolute))];
  if (fencedPatterns.some((pattern) => candidates.some((candidate) => pattern.test(candidate)))) {
    return { deny: true, reason: FENCED_REASON };
  }
  if (!isWithinRoot(absolute, workspace)) return { deny: true, reason: ESCAPE_REASON };
  return { deny: false };
}
