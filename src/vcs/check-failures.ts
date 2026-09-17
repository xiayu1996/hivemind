/**
 * The names of the things a check said were broken, pulled out of its output.
 *
 * A merge that is sent back to CODE carries the tail of the check's output as
 * its reason, and the tail is the wrong end: vitest prints its failure summary
 * before the stack traces and the diff, so a S-AGENTRULES-01 round was handed
 * 800 bytes of a coloured diff and never saw that the failing test was
 * `catalog-snapshot > deepseek`, which had nothing to do with it. Names put the
 * decidable part first, both for the next CODE round and for the person reading
 * the stopped card.
 *
 * Every pattern here is anchored on a runner's own summary line, so a project
 * whose checks are none of these still gets one entry - the check's name - and
 * the output is carried as before.
 */
const PATTERNS: readonly { pattern: RegExp; format: (match: RegExpMatchArray) => string }[] = [
  // vitest / jest summary: "FAIL src/x.test.ts > suite > case"
  {
    pattern: /^\s*FAIL\s+(\S+?)(?:\s+>\s+(.+?))?\s*$/gm,
    format: (match) => (match[2] ? `${match[1]} > ${match[2]}` : match[1]!),
  },
  // vitest per-file summary: " \u276f src/x.test.ts (2 tests | 1 failed)"
  {
    pattern: /^\s*\u276f\s+(\S+\.[cm]?[jt]sx?)\s+\(.*?\d+ failed.*?\)\s*$/gm,
    format: (match) => match[1]!,
  },
  // node:test TAP: "not ok 3 - name"
  { pattern: /^\s*not ok \d+ - (.+?)\s*$/gm, format: (match) => match[1]! },
  // jest: "\u25cf suite \u203a case"
  { pattern: /^\s*\u25cf\s+(?!Console)(.+?)\s*$/gm, format: (match) => match[1]! },
  // tsc: "src/x.ts(12,3): error TS2339: ..."
  {
    pattern: /^(\S+)\((\d+),\d+\): error (TS\d+)/gm,
    format: (match) => `${match[1]}:${match[2]} ${match[3]}`,
  },
];

/** Strips the SGR sequences a runner writes when it thinks it has a terminal. */
// oxlint-disable-next-line no-control-regex -- matching the escape byte is the point
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * What failed, in the order the check reported it, deduplicated. Falls back to
 * the check's own name so a caller always has something to show.
 */
export function extractCheckFailures(checkName: string, output: string): string[] {
  const plain = output.replace(ANSI, "");
  const failures: string[] = [];
  for (const { pattern, format } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of plain.matchAll(pattern)) {
      const name = format(match).trim();
      if (name !== "" && !failures.includes(name)) failures.push(name);
    }
  }
  return failures.length > 0 ? failures : [checkName];
}
