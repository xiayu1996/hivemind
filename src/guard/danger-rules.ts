import { resolve } from "node:path";

/**
 * Pure danger-matching logic: no framework, no SDK, no I/O, so the rules stay
 * unit-testable and can run inside the pi extension as well as in-process.
 *
 * The red lines below are the ONLY bash gate. Everything else runs, because a
 * command allowlist cannot be completed and a denied-but-legitimate command
 * costs a whole round. Writes are bounded separately by the worktree and fenced
 * file checks, which are the guard's actual strength; bash matching is a
 * best-effort net over irreversible operations and is knowingly incomplete.
 */

/** Files an agent must never write: CI/CD config, deploy manifests, and its own guardrails. */
export const DEFAULT_FENCED_PATTERNS: RegExp[] = [
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
 * a human from a decision, which is why they are unconditional (see checkBash).
 */
export const BANNED_BASH: Array<[RegExp, string]> = [
  // Separate recursive and force matches so that -Rf, --recursive and split
  // flags are all covered; the original single -[rf]{1,2} form missed them.
  [/\brm\s+(-[a-z]*r[a-z]*\b|--recursive\b)/i, "recursive rm is forbidden"],
  [/\brm\s+(-[a-z]*f[a-z]*\b|--force\b)/i, "forced rm is forbidden"],
  // The branch must be a whole ref token: \b would also match inside
  // story/main-refactor and deny a legitimate push.
  [
    /\bgit\s+push\b[^\n]*[\s:](?:master|main)(?:\s|$)/,
    "push to master/main is forbidden",
  ],
  // --force-with-lease stays allowed: it is the safe form for rebased story
  // branches and aborts when the remote moved.
  [
    /\bgit\s+push\b[^\n]*\s(?:--force(?![-\w])|-f(?![-\w]))/,
    "force push is forbidden; use --force-with-lease",
  ],
  [/\bgh\s+pr\s+merge\b/, "AI may not merge pull requests"],
  [/\bgh\s+workflow\s+run\b/, "AI may not trigger CI workflows"],
  [/\bglab\s+mr\s+merge\b/, "AI may not merge merge requests"],
  [/\bglab\s+ci\s+play\b/, "AI may not play CI deploy jobs"],
];

export interface GuardVerdict {
  deny: boolean;
  reason?: string;
}

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
 * Reports whether `target` is `root` or sits underneath it.
 *
 * Comparison is case-insensitive on Windows so that a drive-letter or casing
 * difference does not deny a legitimate write inside the worktree.
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
 * Red lines are UNCONDITIONAL: they are denied for every phase, including the
 * wide-open CODE agent, because no phase has a legitimate reason to destroy
 * history, publish to a protected branch, or merge without a human.
 */
export function checkBash(command: string): GuardVerdict {
  for (const [pattern, reason] of BANNED_BASH) {
    if (pattern.test(command)) return { deny: true, reason };
  }
  return { deny: false };
}

/**
 * Denies writes that leave the worktree or land on a fenced file.
 *
 * `extraWriteRoots` whitelists additional absolute roots, such as the card's
 * evidence directory, so screenshots land outside the worktree instead of
 * polluting the diff. Paths are resolved before the containment check so `../`
 * cannot escape a root, and the fenced check runs first so the whitelist never
 * opens a bypass for it.
 */
export function checkFilePath(
  filePath: string,
  worktreePath: string,
  extraWriteRoots: string[] = [],
  fencedPatterns: RegExp[] = DEFAULT_FENCED_PATTERNS,
): GuardVerdict {
  const candidate = toPosixPath(filePath);
  if (fencedPatterns.some((pattern) => pattern.test(candidate))) {
    return { deny: true, reason: "fenced file" };
  }
  const abs = resolve(worktreePath, filePath);
  if (isWithinRoot(abs, worktreePath)) return { deny: false };
  for (const root of extraWriteRoots) {
    if (isWithinRoot(abs, resolve(root))) return { deny: false };
  }
  return { deny: true, reason: "path escapes worktree" };
}
