import type { Project } from "../domain/project.ts";
import type { RunCommand } from "../ports.ts";
import { extractCheckFailures } from "./check-failures.ts";

/**
 * Gate one: the repository's own checks, exactly as `.hivemind/project.yaml`
 * declares them, run on the tree the builder left. The builder cannot edit
 * that file, so it cannot redefine what green means; it can only make the
 * declared commands pass.
 */

export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** What failed, by name, as the runner reported it. */
  failures: readonly string[];
  /** The end of the output, where most runners print their summary. */
  tail: string;
  durationMs: number;
}

export interface RepoCheckReport {
  ok: boolean;
  results: readonly CheckResult[];
  /** One line per problem, written for the builder that has to fix it. */
  findings: readonly string[];
}

const TAIL_CHARS = 4_000;
const SETUP_TIMEOUT_MS = 20 * 60_000;

export async function runRepoChecks(input: { cwd: string; project: Project; run: RunCommand; env: Readonly<Record<string, string>> }): Promise<RepoCheckReport> {
  const findings: string[] = [];
  for (const command of input.project.setup) {
    const result = await input.run(["bash", "-c", command], { cwd: input.cwd, env: input.env, timeoutMs: SETUP_TIMEOUT_MS });
    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      return {
        ok: false,
        results: [],
        findings: [`setup command \`${command}\` failed (${describeExit(result)}); nothing else was checked. Output ends with:\n${tail(output)}`],
      };
    }
  }

  const results: CheckResult[] = [];
  const passed = new Set<string>();
  for (const check of input.project.checks) {
    const blocking = check.requires.filter((name) => !passed.has(name));
    if (blocking.length > 0) {
      results.push({ name: check.name, status: "skipped", failures: [], tail: "", durationMs: 0 });
      findings.push(`check ${check.name} did not run because ${blocking.join(", ")} did not pass`);
      continue;
    }
    const result = await input.run(["bash", "-c", check.run], { cwd: input.cwd, env: input.env, timeoutMs: check.timeoutSeconds * 1000 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0) {
      passed.add(check.name);
      results.push({ name: check.name, status: "passed", failures: [], tail: "", durationMs: result.durationMs });
      continue;
    }
    const failures = extractCheckFailures(check.name, output);
    results.push({ name: check.name, status: "failed", failures, tail: tail(output), durationMs: result.durationMs });
    findings.push(
      `check ${check.name} (\`${check.run}\`) failed (${describeExit(result)}): ${failures.join("; ")}. Run it yourself to see the whole output. It ends with:\n${tail(output)}`,
    );
  }
  return { ok: findings.length === 0, results, findings };
}

function describeExit(result: { code: number | null; signal: string | null; timedOut: boolean; spawnError: string | null }): string {
  if (result.spawnError !== null) return `could not start: ${result.spawnError}`;
  if (result.timedOut) return "timed out";
  if (result.signal !== null) return `killed by ${result.signal}`;
  return `exit code ${result.code}`;
}

function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= TAIL_CHARS ? trimmed : `...${trimmed.slice(-TAIL_CHARS)}`;
}
