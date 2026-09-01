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
const URL_KEYS = ["url", "uri", "href"] as const;

function extractUrl(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const source = input as Record<string, unknown>;
  for (const key of URL_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) =>
    entry.startsWith(".") ? hostname.endsWith(entry) : hostname === entry);
}

/**
 * Decides one navigation. Two things are refused whatever the phase asked for:
 * a page loaded off the local disk, which is how a browser run is made to pass
 * against something that was never deployed, and a host nobody put on the list.
 */
function decideNavigation(url: string, policy: GuardPolicy): GuardDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { block: true, reason: "navigation target is not a URL", target: url };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      block: true,
      reason: `${parsed.protocol}// is not a running system; E2E evidence must come from one`,
      target: url,
    };
  }
  if (policy.e2eHostAllowlist.length === 0) {
    return { block: true, reason: `the ${policy.phase} phase may not drive a browser`, target: url };
  }
  if (!hostAllowed(parsed.hostname, policy.e2eHostAllowlist)) {
    return { block: true, reason: `host ${parsed.hostname} is not on the E2E allowlist`, target: url };
  }
  return { block: false, target: url };
}

/**
 * Commands that put a page in front of a browser. The browser reaches pi
 * through the shell rather than through a tool of its own, so this is where a
 * navigation is visible: `playwright-cli goto ...`, a Playwright or Cypress
 * run given a URL on the command line.
 */
const BROWSER_DRIVERS = /(?:^|[\s;|&(])(?:npx\s+)?(?:playwright-cli|playwright|puppeteer|cypress|selenium-side-runner|chromium|google-chrome)(?:\s|$)/i;
const SCHEME_URL = /[a-z][\w+.-]*:\/\/\S+/gi;
/** The target of a navigation subcommand, which may be written without a scheme. */
const NAVIGATION_ARGUMENT = /\b(?:open|goto|navigate)\s+(?!-)(\S+)/gi;

function navigationTargets(command: string): string[] {
  if (!BROWSER_DRIVERS.test(command)) return [];
  const targets = [...command.matchAll(SCHEME_URL)].map((match) => match[0]);
  for (const match of command.matchAll(NAVIGATION_ARGUMENT)) {
    const argument = match[1]!;
    if (argument.includes("://")) continue;
    // A bare host is what the CLI accepts as shorthand; anything else on that
    // position is a flag or a file and is left to the path rules.
    if (/^(?:localhost|[\d.]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/\S*)?$/i.test(argument)) {
      targets.push(`https://${argument}`);
    }
  }
  return targets;
}

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
  bannedBashPatterns: RegExp[] = [],
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
    if (verdict.deny) return { block: true, reason: verdict.reason, target: command };
    if (bannedBashPatterns.some((pattern) => pattern.test(command))) {
      return { block: true, reason: `shell write is forbidden in ${policy.phase}`, target: command };
    }
    for (const target of navigationTargets(command)) {
      const navigation = decideNavigation(target, policy);
      if (navigation.block) return navigation;
    }
    return { block: false, target: command };
  }

  // Browser tools reach pi through the MCP adapter, so they are named by the
  // server rather than known here; what identifies them is that they carry a
  // navigation target.
  const url = extractUrl(event.input);
  if (url !== undefined) return decideNavigation(url, policy);

  if (READ_ONLY_TOOLS.has(event.toolName)) {
    return { block: false, target: extractPath(event.input) };
  }

  const path = extractPath(event.input);
  if (path === undefined) return { block: false };

  const verdict = checkFilePath(path, policy.worktreePath, policy.extraWriteRoots, fencedPatterns);
  return { block: verdict.deny, reason: verdict.reason, target: path };
}
