import { checkBash, checkFilePath } from "./danger-rules.js";
import type { GuardPolicy } from "./policy.js";

export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

export interface GuardDecision {
  block: boolean;
  reason?: string | undefined;
  /** The path or command the decision was made about, for the audit trail. */
  target?: string | undefined;
}

/**
 * pi built-in tools that only observe the filesystem.
 *
 * Reads are deliberately not bounded by the worktree: an agent legitimately
 * reads the repository's own conventions and toolchain files that live above
 * it, and a fenced file is fenced against writes, not against being understood.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "list", "glob"]);

const PATH_KEYS = ["path", "file_path", "filePath"] as const;

function extractPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const source = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Decides a single tool call against a phase policy.
 *
 * Pure: no filesystem, no clock, no environment, so the whole decision table is
 * unit-testable and the extension around it stays a thin adapter.
 *
 * A tool whose target this function cannot see is allowed and audited. The lever
 * for those is `disallowedTools`, because guessing at an unknown tool's argument
 * names would give a false sense of coverage.
 */
export function decideToolCall(
  event: ToolCallEvent,
  policy: GuardPolicy,
  fencedPatterns: RegExp[],
): GuardDecision {
  if (policy.disallowedTools.includes(event.toolName)) {
    return {
      block: true,
      reason: `tool "${event.toolName}" is not available in the ${policy.phase} phase`,
      target: event.toolName,
    };
  }

  if (event.toolName === "bash") {
    const command = (event.input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") {
      return { block: true, reason: "bash call carried no command string" };
    }
    const verdict = checkBash(command);
    return { block: verdict.deny, reason: verdict.reason, target: command };
  }

  if (READ_ONLY_TOOLS.has(event.toolName)) {
    return { block: false, target: extractPath(event.input) };
  }

  const path = extractPath(event.input);
  if (path === undefined) return { block: false };

  const verdict = checkFilePath(path, policy.worktreePath, policy.extraWriteRoots, fencedPatterns);
  return { block: verdict.deny, reason: verdict.reason, target: path };
}
