/**
 * The names of the things a check said were broken, pulled out of its output.
 *
 * A round that is sent back carries the check's output as its reason, and the
 * tail of that output is the wrong end: vitest prints its failure summary
 * before the stack traces and the diff, so a merge round was once handed 800
 * bytes of a coloured diff and never saw that the failing test was
 * `catalog-snapshot > deepseek`, which had nothing to do with it. Names put the
 * decidable part first, both for the next building round and for the person
 * reading a stopped requirement. The extractor therefore reads the whole
 * output, never a cut of it.
 *
 * Every pattern is anchored on a runner's own summary line, so a project whose
 * checks are none of these still gets one entry, the check's own name, and the
 * output is carried as before.
 */
const PATTERNS: readonly { pattern: RegExp; format: (match: RegExpMatchArray) => string }[] = [
  // vitest / jest summary: "FAIL src/x.test.ts > suite > case", and vitest's
  // form for a file that failed to load: "FAIL src/x.test.ts [ src/x.test.ts ]"
  {
    pattern: /^\s*FAIL\s+(\S+?)(?:\s+>\s+(.+?)|\s+\[\s*\S+\s*\])?\s*$/gm,
    format: (match) => (match[2] ? `${match[1]} > ${match[2]}` : match[1]!),
  },
  // vitest per-file summary: " \u276f src/x.test.ts (2 tests | 1 failed) 4ms"
  {
    pattern: /^\s*\u276f\s+(\S+\.[cm]?[jt]sx?)\s+\(.*?\d+ failed.*?\)(?:\s+\d[\d.]*m?s)?\s*$/gm,
    format: (match) => match[1]!,
  },
  // node:test TAP: "not ok 3 - name"
  { pattern: /^\s*not ok \d+ - (.+?)\s*$/gm, format: (match) => match[1]! },
  // node:test spec reporter (its default without a terminal): "\u2716 name (0.7ms)"
  { pattern: /^\s*\u2716\s+(.+?)\s+\(\d[\d.]*ms\)\s*$/gm, format: (match) => match[1]! },
  // jest: "\u25cf suite \u203a case"
  { pattern: /^\s*\u25cf\s+(?!Console)(.+?)\s*$/gm, format: (match) => match[1]! },
  // tsc: "src/x.ts(12,3): error TS2339: ..."
  {
    pattern: /^(\S+)\((\d+),\d+\): error (TS\d+)/gm,
    format: (match) => `${match[1]}:${match[2]} ${match[3]}`,
  },
];

/** The SGR sequences a runner writes when it believes it has a terminal. */
// oxlint-disable-next-line no-control-regex -- matching the escape byte is the point
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * What failed, in the order the check reported it, deduplicated. A file is
 * named on its own only when none of its tests is. Falls back to the check's
 * own name so a caller always has something to show.
 */
export function extractCheckFailures(checkName: string, output: string): string[] {
  const plain = output.replace(ANSI, "");
  const failures: string[] = [];
  for (const { pattern, format } of PATTERNS) {
    for (const match of plain.matchAll(pattern)) {
      const name = format(match).trim();
      if (name !== "" && !failures.includes(name)) failures.push(name);
    }
  }
  const named = failures.filter((name) => !failures.some((other) => other.startsWith(`${name} > `)));
  return named.length > 0 ? named : [checkName];
}
