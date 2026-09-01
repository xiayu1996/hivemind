/**
 * Wire contract between the runner and the in-process pi guard extension.
 *
 * The policy travels as JSON in an environment variable because the extension
 * is loaded by pi, not by us: there is no other channel that is set before the
 * first tool call and cannot be reached by the model.
 */

export const POLICY_ENV_VAR = "PI_GUARD_POLICY";

export interface GuardPolicy {
  /** Phase whose rules apply, used for audit and denial messages. */
  phase: string;
  cardId: string;
  runId: string;
  /** Absolute worktree root; writes outside it are denied. */
  worktreePath: string;
  /** Absolute roots that may also be written, such as the card's evidence directory. */
  extraWriteRoots: string[];
  /** Tool names this phase may not call at all. */
  disallowedTools: string[];
  /** Extra fenced path patterns as regex sources, merged with the defaults. */
  fencedPatterns: string[];
  /** Phase-specific shell write patterns, applied after unconditional red lines. */
  bannedBash: string[];
  /** Absolute path of the local append-only tool audit. */
  auditPath: string;
  /**
   * Hosts a browser-driving tool may navigate to. Empty means this phase is not
   * expected to drive a browser at all, and any navigation is refused.
   */
  e2eHostAllowlist: string[];
}

export type GuardPhase =
  | "DESIGN"
  | "DECOMPOSE"
  | "CODE"
  | "REGRESSION_FIX"
  | "VERIFY"
  | "E2E"
  | "MERGE"
  | "DISTILL"
  | "REPORT";

export interface GuardPolicyInput {
  phase: GuardPhase;
  cardId: string;
  runId: string;
  worktreePath: string;
  evidencePath?: string;
  auditPath: string;
  fencedPatterns?: string[];
  /** Hosts the E2E evidence may come from; ignored by phases that do not browse. */
  e2eHostAllowlist?: string[];
}

const READ_ONLY_PHASES = new Set<GuardPhase>([
  "DESIGN",
  "DECOMPOSE",
  "VERIFY",
  "E2E",
  "MERGE",
  "DISTILL",
  "REPORT",
]);

/**
 * Phases that may drive a browser: VERIFY produces the evidence a person will
 * be shown, and E2E exists for nothing else. Any other phase navigating a
 * browser is doing something nobody asked it to do.
 */
const BROWSING_PHASES = new Set<GuardPhase>(["VERIFY", "E2E"]);

/** Built-in write-capable tools that must not exist in a read-only phase. */
export const WRITE_TOOLS = ["apply_patch", "edit", "notebook_edit", "powershell", "write"] as const;

/**
 * Bash writes that cannot be removed with a tool allowlist because VERIFY still
 * needs a shell to build and test. Tree-pin remains the backstop for forms this
 * deliberately small heuristic set cannot enumerate.
 */
export const READ_ONLY_BASH_PATTERNS = [
  "(?:^|[^>])(?:>>|>)(?![>&])\\s*\\S+",
  "\\bsed\\s+[^\\n]*?-i(?:[^\\s]*)?(?:\\s|$)",
  "(?:^|[|;]\\s*)tee(?:\\s|$)",
  "\\bgit\\s+commit\\b",
] as const;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((a, b) => a.localeCompare(b, "en"));
}

/** Creates the complete, deterministic policy injected before a phase starts. */
export function assembleGuardPolicy(input: GuardPolicyInput): GuardPolicy {
  const readOnly = READ_ONLY_PHASES.has(input.phase);
  return {
    phase: input.phase,
    cardId: input.cardId,
    runId: input.runId,
    worktreePath: input.worktreePath,
    extraWriteRoots: input.evidencePath ? [input.evidencePath] : [],
    disallowedTools: readOnly ? [...WRITE_TOOLS] : [],
    fencedPatterns: sortedUnique(input.fencedPatterns ?? []),
    bannedBash: readOnly ? [...READ_ONLY_BASH_PATTERNS] : [],
    auditPath: input.auditPath,
    e2eHostAllowlist: BROWSING_PHASES.has(input.phase) ? sortedUnique(input.e2eHostAllowlist ?? []) : [],
  };
}

export class GuardPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardPolicyError";
  }
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw new GuardPolicyError(`${key} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GuardPolicyError(`${key} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Parses a policy, throwing on anything unexpected.
 *
 * A guard that silently falls back to a permissive default is worse than no
 * guard, so every field is required and a malformed policy is an error the
 * caller must turn into a denial.
 */
export function parseGuardPolicy(raw: string): GuardPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GuardPolicyError(`policy is not valid JSON: ${(cause as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GuardPolicyError("policy must be a JSON object");
  }
  const source = parsed as Record<string, unknown>;
  return {
    phase: requireString(source, "phase"),
    cardId: requireString(source, "cardId"),
    runId: requireString(source, "runId"),
    worktreePath: requireString(source, "worktreePath"),
    auditPath: requireString(source, "auditPath"),
    extraWriteRoots: requireStringArray(source, "extraWriteRoots"),
    disallowedTools: requireStringArray(source, "disallowedTools"),
    fencedPatterns: requireStringArray(source, "fencedPatterns"),
    bannedBash: requireStringArray(source, "bannedBash"),
    e2eHostAllowlist: requireStringArray(source, "e2eHostAllowlist"),
  };
}

export function serializeGuardPolicy(policy: GuardPolicy): string {
  return JSON.stringify(policy);
}

/**
 * Compiles the policy's extra fenced patterns.
 *
 * Case-insensitive to match the defaults: on macOS and Windows a pattern that
 * only matches one casing is bypassable.
 */
export function compileFencedPatterns(sources: string[]): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, "i");
    } catch (cause) {
      throw new GuardPolicyError(`invalid fenced pattern ${source}: ${(cause as Error).message}`);
    }
  });
}

export function compileBannedBashPatterns(sources: string[]): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, "i");
    } catch (cause) {
      throw new GuardPolicyError(`invalid bash pattern ${source}: ${(cause as Error).message}`);
    }
  });
}
