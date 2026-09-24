import { matchesAnyGlob } from "./path-glob.js";
import { redGreenFromCommits, type TrajectoryEvidence } from "./verdict.js";

/** One repository-declared check, e.g. lint or the full test run. */
export interface ProjectCheck {
  name: string;
  /** argv, never a shell string: the gate must not depend on a shell. */
  command: readonly string[];
  /** Globs deciding whether the round's changes make this check relevant.
   * Absent means always. A documentation-only round should not have to sit
   * through a full browser suite to be told nothing broke. */
  when?: readonly string[] | undefined;
  /** Checks that must pass before this one runs, for generator-then-consumer
   * orders: running the consumer against last week's generated output answers
   * a question nobody asked. */
  requires?: readonly string[] | undefined;
  /** Paths that must still be unchanged once the check has run. A suite can
   * stay green while quietly rewriting the snapshots it is checked against, so
   * exit code zero is necessary and not sufficient. */
  assertCleanPaths?: readonly string[] | undefined;
}

export interface ProjectCheckResult {
  name: string;
  passed: boolean;
  /** Tail of the output, for the list handed back to CODE. */
  detail: string;
  /** Why the check did not run. A skipped check is neither pass nor fail and
   * produces no finding: the round it was irrelevant to should not be told it
   * failed, and a prerequisite that failed has already said so itself. */
  skipped?: "not-relevant" | "prerequisite-failed";
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
  /** Test files SPECIFY froze that this phase changed anyway. The guard fences
   * them at the entrance; this is the exit proof, because the guard enumerates
   * shell write forms and cannot claim to have enumerated them all. */
  changedFrozenTestPaths?: readonly string[];
  /** Generated outputs edited by hand instead of regenerated. */
  changedProtectedPaths?: readonly string[];
  /** Dependency manifests this card changed. What a repository is built with
   * is decided once for every card at the requirement's solution gate, so a
   * card that adds a dependency is one card deciding for all of them. */
  changedDependencyPaths?: readonly string[];
  /** Tags of the round's tasks (a person's answer, a rejection, a failing scenario), from the prompt. */
  roundTags?: readonly string[];
  /** The implementation artifact, where each tag must be accounted for. */
  artifactText?: string;
}

/**
 * Tags the artifact never accounts for. The prompt asks for one line per tag,
 * `addressed <tag>: <what you changed>`; a round that read a person's answer
 * and wrote nothing about it is the round that did the smallest thing again.
 */
export function unaddressedTags(artifactText: string, roundTags: readonly string[]): string[] {
  const text = artifactText.toLowerCase();
  return roundTags.filter((tag) => !text.includes(`addressed ${tag.toLowerCase()}`));
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

  if ((facts.changedFrozenTestPaths?.length ?? 0) > 0) {
    findings.push(`These tests were frozen by SPECIFY and this phase changed them: ${facts.changedFrozenTestPaths!.join(", ")}. Restore them and make the implementation satisfy them; changing the test is how a card passes without doing the work.`);
  }
  if ((facts.changedProtectedPaths?.length ?? 0) > 0) {
    findings.push(`These generated outputs were edited by hand: ${facts.changedProtectedPaths!.join(", ")}. Regenerate them through the repository's own command instead.`);
  }
  if ((facts.changedDependencyPaths?.length ?? 0) > 0) {
    findings.push(`This card changed what the repository is built with: ${facts.changedDependencyPaths!.join(", ")}. Restore them and do the work with what is already there. Adding a dependency is decided once for every card at the requirement's solution gate, not by whichever card needed it first; if there is genuinely no way to do this without one, say so in the artifact and leave the manifests alone.`);
  }

  for (const check of facts.projectChecks) {
    if (check.skipped || check.passed) continue;
    findings.push(`${check.name} failed: ${check.detail}`);
  }

  const unaddressed = unaddressedTags(facts.artifactText ?? "", facts.roundTags ?? []);
  if (unaddressed.length > 0) {
    findings.push(`The artifact does not account for: ${unaddressed.join(", ")}. For each, do the work it asks for and write one line \`addressed <tag>: <what you changed>\` in the artifact; a tag you deliberately did not act on still needs that line, saying why.`);
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
  /** What counts as a test path, from `codeExit.testPathPatterns`. */
  testPathPatterns?: readonly string[] | undefined;
  /** Generated outputs no phase may edit by hand. */
  protectedPaths?: readonly string[] | undefined;
  /** Dependency manifests, from `codeExit.dependencyManifests`. */
  dependencyManifests?: readonly string[] | undefined;
  /** The commit SPECIFY froze the tests in. Without it there is nothing to
   * diff against, and the frozen-test check does not run at all -- a card
   * driven without SPECIFY is measured by the checks that still apply. */
  frozenTestCommit?: string | undefined;
}

/** A declared check paired with whether this round's changes make it relevant. */
export interface SelectedProjectCheck {
  check: ProjectCheck;
  relevant: boolean;
}

/**
 * The declared checks in the order they run, each marked relevant or not for a
 * set of changed paths.
 *
 * Shared by the CODE exit gate and the merge re-verification so the two ask the
 * same question of the same round: a documentation-only change that the exit
 * gate let through on relevance used to be handed the full suite again at
 * merge, where an unrelated failure could send it back to CODE.
 */
export function selectProjectChecks(
  checks: readonly ProjectCheck[],
  changedPaths: readonly string[],
): SelectedProjectCheck[] {
  return orderProjectChecks(checks).map((check) => ({
    check,
    relevant: !check.when || changedPaths.some((path) => matchesAnyGlob(path, check.when!)),
  }));
}

/**
 * Declaration order, with every prerequisite ahead of the check that names it.
 * A cycle keeps the declared order: a repository that declares one has a
 * configuration problem, and refusing to run any check would hide it behind a
 * silence rather than behind a failing check.
 */
export function orderProjectChecks(checks: readonly ProjectCheck[]): ProjectCheck[] {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const ordered: ProjectCheck[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (check: ProjectCheck): void => {
    if (placed.has(check.name) || visiting.has(check.name)) return;
    visiting.add(check.name);
    for (const name of check.requires ?? []) {
      const prerequisite = byName.get(name);
      if (prerequisite) visit(prerequisite);
    }
    visiting.delete(check.name);
    placed.add(check.name);
    ordered.push(check);
  };
  for (const check of checks) visit(check);
  return ordered;
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
  const failedChecks = new Set<string>();
  for (const { check, relevant } of selectProjectChecks(input.projectChecks, changed)) {
    if (!relevant) {
      projectChecks.push({ name: check.name, passed: true, detail: "", skipped: "not-relevant" });
      continue;
    }
    if ((check.requires ?? []).some((name) => failedChecks.has(name))) {
      projectChecks.push({ name: check.name, passed: true, detail: "", skipped: "prerequisite-failed" });
      continue;
    }
    const result = await input.runCheck(check);
    let { passed, detail } = result;
    if (passed && (check.assertCleanPaths?.length ?? 0) > 0) {
      const dirty = (await git.run(["status", "--porcelain", "--", ...check.assertCleanPaths!]))
        .split(/\r?\n/)
        .filter((line) => line.length > 3)
        .map((line) => line.slice(3).trim());
      if (dirty.length > 0) {
        passed = false;
        detail = `it passed but changed files it must leave alone: ${dirty.join(", ")}`;
      }
    }
    if (!passed) failedChecks.add(check.name);
    projectChecks.push({ name: check.name, passed, detail });
  }

  const testPatterns = input.testPathPatterns ?? [];
  // A frozen test counts as rewritten only when it differs from the commit
  // SPECIFY froze it in AND is among what this branch changed since it forked
  // from the target. The second half is what keeps somebody else's work out of
  // the accusation: a card that takes an Epic or main update mid-flight sees
  // every test file the update moved differ from its frozen commit, though it
  // never touched one. S-R237511TR-01 was told it had rewritten 66 test files
  // across the repository the round after its branch merged its Epic head, and
  // the CODE exit refused the round for it.
  const changedSinceFork = new Set(changed);
  const changedFrozenTestPaths = input.frozenTestCommit
    ? lines(await git.run(["diff", "--name-only", input.frozenTestCommit, "HEAD"]))
      .filter((path) => matchesAnyGlob(path, testPatterns))
      .filter((path) => changedSinceFork.has(path))
    : [];
  const changedProtectedPaths = changed.filter((path) => matchesAnyGlob(path, input.protectedPaths ?? []));
  const changedDependencyPaths = changed.filter((path) => matchesAnyGlob(path, input.dependencyManifests ?? []));

  return {
    uncommittedPaths,
    commitCount: commitMessages.length,
    whitespaceErrors,
    redScenarioIds: [...evidence.red].toSorted(),
    greenScenarioIds: [...evidence.green].toSorted(),
    markedScenarioIds: [...marked].toSorted(),
    dodScenarioIds: [...input.dodScenarioIds],
    projectChecks,
    changedFrozenTestPaths,
    changedProtectedPaths,
    changedDependencyPaths,
  };
}

/** The list handed back to the CODE session, verbatim. */
export function renderCodeExitFindings(verdict: CodeExitVerdict): string {
  return [
    "The deterministic CODE exit checks did not pass. Fix each of these and finish the phase again:",
    ...verdict.findings.map((finding, index) => `${index + 1}. ${finding}`),
  ].join("\n");
}
