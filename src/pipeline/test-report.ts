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
 * Parses a runner's JSON output into the report the SPECIFY exit reads.
 *
 * `root` makes the file paths repository-relative, because that is what the
 * contract names and what a person reads on the card.
 */
export function parseTestReport(output: string, root: string): TestRunReport {
  const start = output.indexOf("{");
  if (start < 0) throw new TestReportParseError("the test command printed no JSON report");
  let document: unknown;
  try {
    document = JSON.parse(output.slice(start)) as unknown;
  } catch (cause) {
    throw new TestReportParseError(`the test command's JSON report could not be read: ${(cause as Error).message}`, { cause });
  }
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
