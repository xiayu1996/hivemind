import { relative, resolve } from "node:path";
import { checkBash, checkFilePath, joinLineContinuations, toPosixPath } from "./danger-rules.ts";
import { matchesGlob } from "./path-glob.ts";

/**
 * Decides one tool call against a session's policy. Called from the agent's
 * `beforeToolCall` hook with the validated arguments; a refusal does not end
 * the session, the model reads the reason and carries on, so every reason says
 * what to do instead.
 *
 * Pure: no filesystem, no clock, no environment, so the whole decision table is
 * unit-testable. Paths are judged lexically: a symlink inside the workspace
 * that points out of it is not followed, and the shell of a session that may
 * write files is not path-bounded at all. The guard is the entrance; holding a
 * session to its policy in the end takes a look at what actually changed.
 */

export interface ToolPolicy {
  /** Tool names this session may call; anything else is refused. */
  allowedTools: readonly string[];
  /**
   * Absolute workspace root, and the cwd pi's file tools were created with:
   * write and edit paths are resolved against it the way those tools resolve
   * them, and escaping it is refused.
   */
  root: string;
  /** Repo-relative globs write/edit may touch. An empty list means no file writes at all. */
  writable: readonly string[];
  /**
   * Repo-relative globs that may never be written; checked before `writable`,
   * and matched case-insensitively. The default fences in danger-rules apply on
   * top of these in every session.
   */
  fenced: readonly string[];
}

export type ToolDecision = { allow: true } | { allow: false; reason: string };

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * The only tools judged against the write fence, by the names pi gives them.
 * Every other tool passes on the allowlist and the command rule: read, grep,
 * find and ls only observe, and the tools this system defines (browser, result
 * submission) enforce their own rules. An observing tool judged against the
 * fence cannot list the directory its session owns, which is how the first
 * drawing session had `ls` and `find` refused on its own contract root.
 *
 * Reads are deliberately not bounded by the workspace: an agent legitimately
 * reads conventions and toolchain files that live above it, and a fenced file
 * is fenced against writes, not against being understood.
 */
const WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * Shell writes refused in a session that may not write files. That session
 * still needs a shell to build and test, so the writes cannot be removed with
 * the tool allowlist; this deliberately small set is backed by the tree pin for
 * the forms it cannot enumerate.
 */
const SHELL_WRITES: readonly RegExp[] = [
  // A redirect starts a word: `cmd > file`, `cmd >file`, `2>file`. A `>` inside
  // a word (`=>`, `->`, `<unset>`) is not one; inline scripts and quoted text
  // are full of those and must stay runnable.
  /(?:^|[\s;|&])\d?(?:>>|>)(?![>&])\s*\S+/i,
  /\bsed\s+[^\n]*?-i(?:[^\s]*)?(?:\s|$)/i,
  /(?:^|[|;]\s*)tee(?:\s|$)/i,
  /\bgit\s+commit\b/i,
];

const REDIRECT = /(?:^|[\s;|&])\d?(?:>>|>)(?![>&])\s*(\S+)/g;
const DISCARD_TARGET = /^\/dev\/(?:null|stdout|stderr)$/;

/**
 * A session that may not write is the one judging the running system. A
 * browser told to answer the page's requests itself would be judging a
 * fixture the session wrote, not the product.
 */
const ROUTE_INTERCEPTION = /\bplaywright-cli\b[^|;&\n]*\s(?:un)?route(?:\s|$)/;

/** What pi's path normalisation turns into a plain space before resolving. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const ALLOW: ToolDecision = { allow: true };

function refuse(reason: string): ToolDecision {
  return { allow: false, reason };
}

/**
 * Removes redirects that write no file, so the heuristics only see the ones
 * that would touch the tree. Shell quoting is stripped first because it is how
 * a model usually writes the target.
 */
function withoutDiscardedOutput(command: string): string {
  return command.replaceAll(REDIRECT, (match: string, target: string) =>
    DISCARD_TARGET.test(target.replaceAll(/^["']+|["']+$/g, "")) ? " " : match,
  );
}

/**
 * Judges one shell command, whichever tool carries it: the red lines for every
 * session, and the read-only rules for a session that may not write files.
 */
function decideCommand(policy: ToolPolicy, command: string): ToolDecision {
  const redLine = checkBash(command);
  if (redLine.deny) return refuse(redLine.reason);
  if (policy.writable.length > 0) return ALLOW;
  const joined = joinLineContinuations(command);
  const writing = withoutDiscardedOutput(joined);
  if (SHELL_WRITES.some((pattern) => pattern.test(writing))) {
    return refuse(
      "this session may not write files, and this command writes one (a redirect, sed -i, tee or git commit); print to standard output instead, or discard output with > /dev/null",
    );
  }
  if (ROUTE_INTERCEPTION.test(joined)) {
    return refuse(
      "request interception fakes the system under test; judge the application by what it actually answers",
    );
  }
  return ALLOW;
}

/**
 * Judges the file a write or edit will touch. pi's file tools rewrite the path
 * before resolving it: unicode spaces become spaces, one leading `@` is
 * dropped, `~` is the home directory and a file:// URL is converted. The guard
 * mirrors that so it judges the file the tool actually writes; without it
 * `@CLAUDE.md` walks past the fence and `~/x` past the workspace.
 */
function decideWrite(policy: ToolPolicy, tool: string, rawPath: unknown): ToolDecision {
  if (typeof rawPath !== "string" || rawPath === "") {
    return refuse(`${tool} needs a "path" string naming the file to write`);
  }
  const path = rawPath.replaceAll(UNICODE_SPACES, " ").replace(/^@/, "");
  if (path === "~" || path.startsWith("~/")) {
    return refuse(
      `cannot write "${rawPath}": ~ is the home directory, outside the workspace; give the path relative to the workspace root`,
    );
  }
  if (path.startsWith("file://")) {
    return refuse(`cannot write "${rawPath}": give a plain path relative to the workspace root, not a file:// URL`);
  }
  const unconditional = checkFilePath(path, policy.root);
  if (unconditional.deny) return refuse(`cannot write "${rawPath}": ${unconditional.reason}`);

  const workspace = resolve(policy.root);
  const target = toPosixPath(relative(workspace, resolve(workspace, path)));
  if (target === "") return refuse(`cannot write "${rawPath}": that is the workspace root itself; name a file inside it`);
  const fence = policy.fenced.find((glob) => matchesGlob(target, glob, { ignoreCase: true }));
  if (fence !== undefined) {
    return refuse(
      `cannot write "${target}": this session may not change files matching ${fence}; leave it unchanged, and if it truly has to change, say so in your result`,
    );
  }
  if (policy.writable.length === 0) {
    return refuse(`cannot write "${target}": this session may not write files; report what you found in your result instead`);
  }
  // Case-sensitive, unlike the fences: a narrower allow is the safe direction,
  // and on Linux `.Hivemind/` is a different directory from `.hivemind/`.
  if (!policy.writable.some((glob) => matchesGlob(target, glob))) {
    return refuse(
      `cannot write "${target}": this session may only write paths matching ${policy.writable.join(", ")}; keep the change within those`,
    );
  }
  return ALLOW;
}

export function decideToolCall(policy: ToolPolicy, call: ToolCall): ToolDecision {
  if (!policy.allowedTools.includes(call.name)) {
    const available = policy.allowedTools.length > 0 ? `use one of: ${policy.allowedTools.join(", ")}` : "it has no tools";
    return refuse(`tool "${call.name}" is not available in this session; ${available}`);
  }
  // The hook's arguments are typed unknown; a shape this guard cannot read is
  // judged as carrying nothing, which refuses bash and write rather than
  // waving them through.
  const args: Record<string, unknown> = typeof call.args === "object" && call.args !== null ? call.args : {};

  // Any tool that carries a command is judged as a shell call, not only bash:
  // a command riding along with another tool must not get past the shell rules
  // by changing seats. A command that is present but not a string is a shape
  // this guard cannot judge, so it is refused rather than ignored.
  const command = args.command;
  if (command !== undefined) {
    if (typeof command !== "string") {
      return refuse(`"command" must be a string holding the shell command; pass the command as text`);
    }
    const decision = decideCommand(policy, command);
    if (!decision.allow) return decision;
  } else if (call.name === "bash") {
    return refuse(`bash needs a "command" string; pass the shell command as text`);
  }

  if (WRITE_TOOLS.has(call.name)) return decideWrite(policy, call.name, args.path);
  return ALLOW;
}
