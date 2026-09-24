import { relative, isAbsolute } from "node:path";
import type { FailureKind, ObservedFailure, TestRunReport } from "./spec-exit-gate.js";
import { scenarioMarkers } from "./code-exit-gate.js";

/**
 * Reads the JSON reporter shape that vitest and jest share.
 *
 * The SPECIFY exit compares a failure field by field against what the phase
 * predicted, so it needs the failure taken apart rather than a wall of text. A
 * regex over human output would let a compile error or an unrelated crash stand
 * in for the assertion that was supposed to fail, which is the one thing this
 * exit exists to prevent.
 */
interface RawAssertion {
  fullName?: unknown;
  title?: unknown;
  status?: unknown;
  failureMessages?: unknown;
}

interface RawFile {
  name?: unknown;
  assertionResults?: unknown;
}

const KINDS: ReadonlyArray<[RegExp, FailureKind]> = [
  [/cannot find module|failed to resolve import|module not found/i, "module_not_found"],
  [/\bts\d{4}\b|syntaxerror|parse error|transform failed/i, "compile_error"],
  [/not implemented|notimplementederror|todo:/i, "not_implemented"],
  [/assertionerror|expected .* (?:to|but)|received:/i, "assertion"],
];

/** What kind of nothing-happened this failure is, which decides whether it counts as red. */
export function classifyFailure(message: string): FailureKind {
  for (const [pattern, kind] of KINDS) {
    if (pattern.test(message)) return kind;
  }
  return "other";
}

/** `path:line` from the first stack frame inside the test file, so a prediction
 * can name the assertion rather than the file. */
function locate(message: string, file: string): string {
  const escaped = file.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
  const frame = new RegExp(`${escaped}:(\\d+):\\d+`).exec(message);
  return frame ? `${file}:${frame[1]}` : file;
}

function firstLine(message: string): string {
  return message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** The value the runner actually saw, as the runner named it. */
function actualOf(message: string): string {
  const received = /(?:received|actual)\s*:?\s*(.+)/i.exec(message);
  if (received) return received[1]!.trim();
  const inline = /expected\s+(.+?)\s+to\b/i.exec(message);
  return inline ? inline[1]!.trim() : firstLine(message);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class TestReportParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TestReportParseError";
  }
}

/**
 * The runner's report, taken out of everything else on the two streams.
 *
 * The report shares its output with whatever else the runner says, on both
 * sides of it: npm prints its own lines first, vitest prints a summary after,
 * and a test that shells out can put a message of its own on either stream --
 * the caller hands both streams over as one string because a runner may put
 * the report on either. Reading from the first brace to the end of the text
 * therefore fails on the noise that follows the report rather than on the
 * report, and reports the repository's test command as broken when it is not.
 * Scanning to the matching brace cuts the document out of the middle instead.
 * A brace inside a string literal closes nothing, so strings are tracked. The
 * report is recognised by its `testResults` array rather than by being first,
 * because the noise around it can be JSON of its own -- a structured log line
 * ahead of it would otherwise be read as a report that has no tests in it.
 */
function findJsonDocument(output: string): { document?: unknown; error?: Error } | null {
  let error: Error | undefined;
  let fallback: { document: unknown } | undefined;
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    const end = matchingBrace(output, start);
    if (end < 0) continue;
    let document: unknown;
    try {
      document = JSON.parse(output.slice(start, end + 1)) as unknown;
    } catch (cause) {
      error ??= cause as Error;
      continue;
    }
    if (Array.isArray((document as { testResults?: unknown }).testResults)) return { document };
    fallback ??= { document };
  }
  // Nothing carried a testResults array. The first thing that parsed is handed
  // on so the caller can say what is wrong with it, which is more use than
  // saying no report was printed at all.
  if (fallback) return fallback;
  if (error) return { error };
  // A brace that never closes is a report cut short rather than an absent one,
  // and saying so beats sending somebody to look for output that is right
  // there. Only reached when no candidate closed at all.
  return output.includes("{") ? { error: new Error("the report ends before its closing brace") } : null;
}

/** The index of the brace closing the one at `start`, or -1 if it never closes. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const character = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Parses a runner's JSON output into the report the SPECIFY exit reads.
 *
 * `root` makes the file paths repository-relative, because that is what the
 * contract names and what a person reads on the card.
 */
export function parseTestReport(output: string, root: string): TestRunReport {
  const found = findJsonDocument(output);
  if (!found) throw new TestReportParseError("the test command printed no JSON report");
  if (found.error) {
    throw new TestReportParseError(`the test command's JSON report could not be read: ${found.error.message}`, { cause: found.error });
  }
  const document = found.document;
  const files = (document as { testResults?: unknown }).testResults;
  if (!Array.isArray(files)) throw new TestReportParseError("the JSON report has no testResults array");

  const failures: ObservedFailure[] = [];
  const passed: string[] = [];
  for (const entry of files as RawFile[]) {
    const absolute = typeof entry.name === "string" ? entry.name : "";
    const file = isAbsolute(absolute) ? relative(root, absolute) : absolute;
    const assertions = Array.isArray(entry.assertionResults) ? entry.assertionResults as RawAssertion[] : [];
    for (const assertion of assertions) {
      const name = typeof assertion.fullName === "string" && assertion.fullName !== ""
        ? assertion.fullName
        : String(assertion.title ?? "");
      if (assertion.status === "passed") {
        passed.push(name);
        continue;
      }
      const messages = strings(assertion.failureMessages);
      const message = messages.join("\n");
      failures.push({
        file: locate(message, file),
        testName: name,
        // A test the runner never ran says nothing about the behaviour, which
        // is a different answer from one that ran and disagreed.
        kind: assertion.status === "failed" ? classifyFailure(message) : "not_executed",
        assertion: firstLine(message),
        actual: actualOf(message),
        scenarioIds: scenarioMarkers(`${name} ${message}`),
      });
    }
  }
  return { failures, passed };
}
