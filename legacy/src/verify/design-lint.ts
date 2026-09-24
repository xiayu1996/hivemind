import { relative } from "node:path";

/**
 * The anti-mean design detector, wrapped as a warn-level gate (design 08
 * section 3.3).
 *
 * It is a third-party binary with no model and no credentials behind it: it
 * reads static HTML and reports the anti-patterns an unconstrained generative
 * design falls into -- violet gradients, the default font, a flat type scale,
 * padding nobody can tap. It never refuses a prototype. Its own author's
 * wording is the reason: a clean scan is evidence, not proof, and a criterion
 * that refuses on taste is the failure mode design 08 section 8 exists to
 * remove. Every finding is recorded as friction instead, so the question "does
 * this discipline actually change anything" gets answered with data.
 */

/** What the binary prints per finding, as captured in `fixtures/design-lint/`. */
interface RawFinding {
  antipattern?: unknown;
  name?: unknown;
  description?: unknown;
  severity?: unknown;
  category?: unknown;
  file?: unknown;
  line?: unknown;
  snippet?: unknown;
}

export interface DesignLintFinding {
  /** The rule id, e.g. `ai-color-palette`. */
  rule: string;
  /** Relative to the scan root, so the same page reads the same on every host. */
  file: string;
  /** 0 when the rule is about the rendered page rather than a line of source. */
  line: number;
  /** The rule's own one-line name. */
  what: string;
  /** What it saw on this page. */
  detail: string;
}

export type DesignLintOutcome =
  | { kind: "ran"; findings: readonly DesignLintFinding[] }
  /** The scan could not be trusted: the binary is missing, a target could not
   * be read, or the output was not the contract. The prototype is unaffected;
   * an operator sees the reason in the canonical log. */
  | { kind: "unavailable"; reason: string };

/** Exit codes, from `impeccable detect --help`. */
const CLEAN = 0;
const PARTIAL_SCAN = 1;
const FOUND = 2;

export interface DesignLintProcess {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DesignLintRequest {
  binary: string;
  /** Directory the files are named relative to; also the scan's cwd. */
  root: string;
  /** Files to scan, relative to the root. */
  files: readonly string[];
  run: (input: { binary: string; args: readonly string[]; cwd: string }) => Promise<DesignLintProcess>;
}

/**
 * Runs one scan.
 *
 * `--no-config` is not optional: without it the tool reads the target
 * repository's `.impeccable/` ignore rules and its `DESIGN.md`, and two hosts
 * scanning the same prototype would then reach different conclusions about it.
 */
export async function runDesignLint(request: DesignLintRequest): Promise<DesignLintOutcome> {
  if (request.files.length === 0) return { kind: "ran", findings: [] };
  let process: DesignLintProcess;
  try {
    process = await request.run({
      binary: request.binary,
      args: ["detect", "--json", "--no-config", ...request.files],
      cwd: request.root,
    });
  } catch (cause) {
    return { kind: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (process.code === PARTIAL_SCAN) {
    return { kind: "unavailable", reason: firstLine(process.stderr) || "一个或多个页面没扫成" };
  }
  if (process.code !== CLEAN && process.code !== FOUND) {
    return { kind: "unavailable", reason: `detect 退出码 ${process.code}: ${firstLine(process.stderr)}` };
  }
  return parseDesignLint(process.stdout, request.root, request.files);
}

/**
 * Reads the JSON array on stdout.
 *
 * A row missing its rule or its file is dropped rather than guessed at: the
 * engine is still 0.x and its rule set moves, and a friction row keyed by
 * nothing is a row nobody can act on later.
 */
export function parseDesignLint(
  stdout: string,
  root: string,
  scanned: readonly string[] = [],
): DesignLintOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
  } catch (cause) {
    return { kind: "unavailable", reason: `detect 的输出不是 JSON: ${cause instanceof Error ? cause.message : ""}` };
  }
  if (!Array.isArray(payload)) return { kind: "unavailable", reason: "detect 的输出不是一个数组" };

  const findings: DesignLintFinding[] = [];
  for (const entry of payload as RawFinding[]) {
    if (entry === null || typeof entry !== "object") continue;
    const rule = text(entry.antipattern);
    const file = text(entry.file);
    if (rule === "" || file === "") continue;
    findings.push({
      rule,
      file: nameWithin(file, root, scanned),
      line: typeof entry.line === "number" ? entry.line : 0,
      what: text(entry.name),
      detail: text(entry.snippet),
    });
  }
  return { kind: "ran", findings: findings.toSorted(byFileThenRule) };
}

/**
 * One friction row per finding, in the shape the friction table takes.
 *
 * The rule id leads the detail because that is what makes rows comparable
 * across requirements: the question these rows exist to answer is which
 * anti-patterns keep coming back, not which page had a bad day.
 */
export function describeDesignLintFindings(findings: readonly DesignLintFinding[]): string[] {
  return findings.map((finding) =>
    `${finding.rule} ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""} ${finding.what}: ${finding.detail}`
      .trim()
  );
}

function byFileThenRule(left: DesignLintFinding, right: DesignLintFinding): number {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.rule !== right.rule) return left.rule < right.rule ? -1 : 1;
  return left.line - right.line;
}

/**
 * The page's name as the caller asked for it.
 *
 * The scanned list is consulted before the root because the tool answers with
 * the path it resolved, which is not always the path it was handed: on a host
 * whose temp directory is a symlink the two differ by a prefix, and a friction
 * row keyed by the machine's own mount layout is not comparable with anything.
 */
function nameWithin(file: string, root: string, scanned: readonly string[]): string {
  const normalized = file.replaceAll("\\", "/");
  for (const candidate of scanned) {
    const wanted = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized === wanted || normalized.endsWith(`/${wanted}`)) return wanted;
  }
  const inside = relative(root, file);
  return inside === "" || inside.startsWith("..") ? file : inside.replaceAll("\\", "/");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(stream: string): string {
  return stream.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * The real scan, for a composition root. Output is small (a JSON array of
 * findings for a handful of static pages), so it is buffered whole; a scan that
 * hangs is bounded by the caller's own timeout rather than by a pipe.
 */
export async function execDesignLint(input: {
  binary: string;
  args: readonly string[];
  cwd: string;
}): Promise<DesignLintProcess> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(
      input.binary,
      [...input.args],
      { cwd: input.cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        // Findings and partial scans both exit non-zero, and both are answers
        // rather than failures; only a process that never ran rejects.
        const code = (error as { code?: unknown } | null)?.code;
        if (error && typeof code !== "number") reject(error);
        else resolve({ code: typeof code === "number" ? code : 0, stdout, stderr });
      },
    );
  });
}
