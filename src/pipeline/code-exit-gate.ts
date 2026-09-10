import { redGreenFromCommits, type TrajectoryEvidence } from "./verdict.js";

/** One repository-declared check, e.g. lint or the full test run. */
export interface ProjectCheck {
  name: string;
  /** argv, never a shell string: the gate must not depend on a shell. */
  command: readonly string[];
}

export interface ProjectCheckResult {
  name: string;
  passed: boolean;
  /** Tail of the output, for the list handed back to CODE. */
  detail: string;
}

/** What the orchestrator measured in the worktree after CODE ended. */
export interface CodeExitFacts {
  uncommittedPaths: readonly string[];
  commitCount: number;
  whitespaceErrors: readonly string[];
  redScenarioIds: readonly string[];
  greenScenarioIds: readonly string[];
  /** Scenario ids named by the test files this Story changed. */
  markedScenarioIds: readonly string[];
  dodScenarioIds: readonly string[];
  projectChecks: readonly ProjectCheckResult[];
}

export interface CodeExitVerdict {
  passed: boolean;
  /** One line per unmet check, in the wording handed back to the CODE session. */
  findings: readonly string[];
}

const TEST_PATH = /(?:^|\/)(?:tests?|specs?)\/|(?:[._-](?:test|spec)s?)\.[A-Za-z0-9]+$|(?:^|\/)test_[^/]+$/i;
const SCENARIO_ID = /S-[A-Za-z0-9]+-\d{2}-[a-z0-9]+/g;

/** Whether a changed path is somewhere a scenario marker can live. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/**
 * Scenario ids a test file names, in either form 2.1 allows: an `@scenario`
 * annotation or the id inside the test name.
 */
export function scenarioMarkers(text: string): string[] {
  return [...new Set(text.match(SCENARIO_ID) ?? [])];
}

/**
 * The deterministic CODE exit.
 *
 * It replaces the completion judge, which asked a model whether a phase that
 * claimed to be finished really was. Every shape of false completion the judge
 * existed to catch has a check here that cannot be argued with, and the judge's
 * remaining question — whether the implementation satisfies the requirement —
 * is what the blind VERIFY phase answers.
 *
 * Nothing here is a stop point: an unmet check costs no round and no reentry,
 * the findings go straight back to the same CODE session.
 */
export function evaluateCodeExit(facts: CodeExitFacts): CodeExitVerdict {
  const findings: string[] = [];

  if (facts.uncommittedPaths.length > 0) {
    findings.push(`The worktree is not clean. Commit or revert: ${facts.uncommittedPaths.join(", ")}.`);
  }
  if (facts.commitCount === 0) {
    findings.push("The Story branch has no commit of its own. The work has to be committed to the branch.");
  }
  if (facts.whitespaceErrors.length > 0) {
    findings.push(`git diff --check rejects the diff: ${facts.whitespaceErrors.join("; ")}.`);
  }

  const red = new Set(facts.redScenarioIds);
  const green = new Set(facts.greenScenarioIds);
  const marked = new Set(facts.markedScenarioIds);
  const missingRed = facts.dodScenarioIds.filter((id) => !red.has(id));
  const missingGreen = facts.dodScenarioIds.filter((id) => !green.has(id));
  const unmarked = facts.dodScenarioIds.filter((id) => !marked.has(id));
  if (missingRed.length > 0) {
    findings.push(`No failing-test evidence exists for: ${missingRed.join(", ")}. Each scenario needs a test that failed before the implementation.`);
  }
  if (missingGreen.length > 0) {
    findings.push(`No passing-test evidence exists for: ${missingGreen.join(", ")}.`);
  }
  if (unmarked.length > 0) {
    findings.push(`No changed test file names these scenarios: ${unmarked.join(", ")}. Mark the test with the scenario id.`);
  }

  for (const check of facts.projectChecks) {
    if (!check.passed) findings.push(`${check.name} failed: ${check.detail}`);
  }

  return { passed: findings.length === 0, findings };
}

export interface CodeExitGitPort {
  /** Runs git in the Story worktree and returns stdout. */
  run(args: readonly string[]): Promise<string>;
}

export interface CodeExitCollectInput {
  git: CodeExitGitPort;
  /** Reads a path inside the worktree. */
  readWorktreeFile: (path: string) => Promise<string>;
  runCheck: (check: ProjectCheck) => Promise<{ passed: boolean; detail: string }>;
  /** Branch the Story is landing on; the base of its own commits. */
  baseRef: string;
  dodScenarioIds: readonly string[];
  projectChecks: readonly ProjectCheck[];
  /** Test events the session emitted, the second of the two red/green channels. */
  trajectory?: readonly TrajectoryEvidence[];
}

function lines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Measures the worktree itself rather than reading the session's account of it. */
export async function collectCodeExitFacts(input: CodeExitCollectInput): Promise<CodeExitFacts> {
  const { git } = input;
  // Porcelain's first two columns are the status codes, so the path starts at
  // column three and the line must not be trimmed before it is cut.
  const uncommittedPaths = (await git.run(["status", "--porcelain"]))
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim());
  // A Story branched off the target and then rebased onto it still has to be
  // measured against the commit they share, not against the branch tip.
  const base = (await git.run(["merge-base", input.baseRef, "HEAD"])).trim();
  const commitMessages = lines(await git.run(["log", "--format=%s", `${base}..HEAD`]));
  const changed = lines(await git.run(["diff", "--name-only", base, "HEAD"]));

  let whitespaceErrors: string[] = [];
  try {
    await git.run(["diff", "--check", base, "HEAD"]);
  } catch (cause) {
    // `git diff --check` reports the offending lines on stdout and exits 1.
    const stdout = (cause as { stdout?: unknown }).stdout;
    whitespaceErrors = lines(typeof stdout === "string" && stdout.trim() !== ""
      ? stdout
      : (cause as Error).message);
  }

  const marked = new Set<string>();
  for (const path of changed.filter((candidate) => isTestPath(candidate))) {
    try {
      for (const id of scenarioMarkers(await input.readWorktreeFile(path))) marked.add(id);
    } catch {
      // Deleted or renamed away in a later commit: it cannot carry a marker now.
    }
  }

  const evidence = redGreenFromCommits(commitMessages, input.trajectory ?? []);
  const projectChecks: ProjectCheckResult[] = [];
  for (const check of input.projectChecks) {
    const result = await input.runCheck(check);
    projectChecks.push({ name: check.name, passed: result.passed, detail: result.detail });
  }

  return {
    uncommittedPaths,
    commitCount: commitMessages.length,
    whitespaceErrors,
    redScenarioIds: [...evidence.red].toSorted(),
    greenScenarioIds: [...evidence.green].toSorted(),
    markedScenarioIds: [...marked].toSorted(),
    dodScenarioIds: [...input.dodScenarioIds],
    projectChecks,
  };
}

/** The list handed back to the CODE session, verbatim. */
export function renderCodeExitFindings(verdict: CodeExitVerdict): string {
  return [
    "The deterministic CODE exit checks did not pass. Fix each of these and finish the phase again:",
    ...verdict.findings.map((finding, index) => `${index + 1}. ${finding}`),
  ].join("\n");
}
