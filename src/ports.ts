/**
 * Every boundary between the main loop and the outside world. The loop and the
 * decision code import only these types; the implementations live in
 * `src/adapters/` and are wired together in exactly one place, `src/main.ts`.
 * Removing a capability means deleting its adapter and one line there.
 */

import type { ToolPolicy } from "./gates/tool-guard.ts";

// ---------------------------------------------------------------------------
// Board: the human channel. Four touchpoints only: a person submits a
// requirement, approves the product contract, approves the architecture, and
// reviews a milestone (answering blocking questions on the way).
// ---------------------------------------------------------------------------

export type Gate = "product" | "architecture" | "milestone";

export interface Submission {
  /** Stable board-side identifier (a Notion page id, a local file name). */
  ref: string;
  title: string;
  body: string;
  /** Name of a repository registered in the instance configuration. */
  repo: string;
  /** Recipe the submitter asked for; null lets the loop choose. */
  recipe: string | null;
  author: string | null;
  submittedAt: string;
}

export interface ApprovalRequest {
  gate: Gate;
  /** Commit sha of the product files being approved. An approval binds to it. */
  revision: string;
  title: string;
  summary: string;
  documents: readonly { name: string; content: string }[];
}

export interface Question {
  id: string;
  body: string;
  options: readonly string[];
}

export interface Report {
  id: string;
  title: string;
  body: string;
}

export type HumanInput =
  | {
      kind: "approval";
      /** Unique per gesture; the store deduplicates on it. */
      sourceId: string;
      gate: Gate;
      revision: string;
      author: string | null;
      at: string;
    }
  | {
      kind: "comment";
      sourceId: string;
      body: string;
      author: string | null;
      at: string;
    };

export type BoardStatus = "queued" | "working" | "needs_input" | "stopped" | "done";

/**
 * Every write is idempotent on its natural key (ref + gate + revision, question
 * id, report id), because the loop re-issues a write it cannot prove landed
 * rather than keeping an outbox. Reads never block on a person.
 */
export interface Board {
  /** Submissions the system has not accepted yet. Accepting one is `setStatus(ref, "working")`. */
  pollSubmissions(): Promise<readonly Submission[]>;
  requestApproval(ref: string, request: ApprovalRequest): Promise<void>;
  ask(ref: string, question: Question): Promise<void>;
  report(ref: string, report: Report): Promise<void>;
  /** Human inputs newer than the cursor. Inputs may repeat; callers deduplicate on `sourceId`. */
  pollInputs(ref: string, cursor: string | null): Promise<{ inputs: readonly HumanInput[]; cursor: string | null }>;
  /** The system-owned status field. Nothing a person writes is ever overwritten by it. */
  setStatus(ref: string, status: BoardStatus, note: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** Null when the process never started or was killed by a signal. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started at all (ENOENT, EACCES). */
  spawnError: string | null;
  timedOut: boolean;
  durationMs: number;
}

export interface RunCommandOptions {
  cwd: string;
  /** The complete environment of the child. Nothing is inherited implicitly. */
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
  input?: string;
  /** Output beyond this many bytes per stream is dropped from the middle. */
  maxOutputBytes?: number;
}

/** Never throws: every failure, including a missing executable, is a result. */
export type RunCommand = (argv: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface RepositoryConfig {
  name: string;
  url: string;
  defaultBranch: string;
  /** Push the integration branch after every merge and open a pull request at the end. */
  push: boolean;
  /** Recipe for a submission that names none: greenfield for a repository with no product yet, feature otherwise. */
  recipe: string;
}

export type RebaseResult = { ok: true } | { ok: false; conflicts: readonly string[]; detail: string };

/**
 * Git operations the loop needs, all non-interactive. Paths are absolute.
 * Methods that can fail for reasons the loop must act on return a result;
 * anything else (a corrupt repository, a missing git binary) throws.
 */
export interface Git {
  /** Clones once (atomically) and fetches on every later call. Returns the local repository path. */
  sync(repo: RepositoryConfig): Promise<string>;
  /** Resolves a ref to a sha, or null when it does not exist. */
  resolve(repoPath: string, ref: string): Promise<string | null>;
  /** Creates `branch` at `startPoint` unless it already exists. */
  ensureBranch(repoPath: string, branch: string, startPoint: string): Promise<void>;
  /** Checks `branch` out at `path`, replacing any stale worktree registered there. */
  addWorktree(repoPath: string, path: string, branch: string): Promise<void>;
  removeWorktree(repoPath: string, path: string): Promise<void>;
  head(worktree: string): Promise<string>;
  /** Paths changed since the merge base with `base`: committed, staged, unstaged and untracked. */
  changedPaths(worktree: string, base: string): Promise<readonly string[]>;
  /** Puts `paths` back to their state at `base`; files that did not exist there are deleted. */
  restorePaths(worktree: string, base: string, paths: readonly string[]): Promise<void>;
  /**
   * Moves the checked-out branch to `ref`. soft keeps the tree and the index
   * (used to squash attempts into one commit); hard also discards every
   * uncommitted change and untracked file that is not ignored.
   */
  reset(worktree: string, ref: string, mode: "soft" | "hard"): Promise<void>;
  /** Stages everything (or only `paths`) and commits. Returns the new sha, or null when nothing changed. */
  commit(worktree: string, message: string, paths?: readonly string[]): Promise<string | null>;
  rebase(worktree: string, onto: string): Promise<RebaseResult>;
  /** Fast-forwards the branch checked out at `worktree` to `ref`. False when that is not a fast-forward. */
  fastForward(worktree: string, ref: string): Promise<boolean>;
  push(worktree: string, branch: string): Promise<void>;
  /** Opens (or finds the open) pull request from `head` into `base`. Returns its URL. */
  openPullRequest(repoPath: string, input: { head: string; base: string; title: string; body: string }): Promise<string>;
}

// ---------------------------------------------------------------------------
// The application under evaluation
// ---------------------------------------------------------------------------

export interface StartAppInput {
  cwd: string;
  /** Argv with an optional `{port}` placeholder, replaced by a free port. */
  start: readonly string[];
  /** Path polled until it answers with anything below 400. */
  readyPath: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface RunningApp {
  origin: string;
  port: number;
  /** Tail of the application's combined output, for diagnosis. */
  output(): string;
  stop(): Promise<void>;
}

export type StartAppResult = { ok: true; app: RunningApp } | { ok: false; reason: string; output: string };

export type StartApp = (input: StartAppInput) => Promise<StartAppResult>;

// ---------------------------------------------------------------------------
// Agent sessions. The loop describes a session (who, which models in which
// order, what it may touch, what it must hand back); the adapter runs it on
// whatever model runtime is wired in. Nothing here names a provider or model.
// ---------------------------------------------------------------------------

export type Role = "planner" | "builder" | "evaluator";

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  provider: string;
  model: string;
  effort: Effort;
}

export type BuiltinTool = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface ToolOutput {
  text: string;
  images?: readonly { data: string; mimeType: string }[];
  /** End the session after this turn; set by the tool that receives the session's result. */
  endsSession?: boolean;
}

/** A tool the loop provides (result submission, browser actions). Throwing reports an error result to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments, shown to the model and checked before `execute`. */
  parameters: Record<string, unknown>;
  execute(args: unknown, signal?: AbortSignal): Promise<ToolOutput>;
}

export interface SessionRequest {
  /** Also the provider-side session id, so a provider that caches per session keeps one cache per run. */
  runId: string;
  role: Role;
  cwd: string;
  /** Tried in order; a provider whose breaker is open is skipped, one that fails mid-session hands over to the next. */
  candidates: readonly ModelChoice[];
  systemPrompt: string;
  builtinTools: readonly BuiltinTool[];
  tools: readonly ToolSpec[];
  policy: ToolPolicy;
  /** The complete environment of commands the agent runs. Nothing is inherited implicitly. */
  env: Readonly<Record<string, string>>;
  maxTurns: number;
  timeoutMs: number;
}

export type SessionOutcome =
  /** A tool ended the session, normally the one receiving its result. */
  | { kind: "ended" }
  /** The model stopped on its own without a tool ending the session. */
  | { kind: "stopped"; text: string }
  | { kind: "error"; errorClass: string; message: string; needsHuman: boolean }
  | { kind: "timeout" }
  | { kind: "turn_limit" };

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** API-equivalent price of every request, whatever the billing of the provider that served it. */
  costUsd: number;
  turns: number;
}

export interface AgentSession {
  /** The model currently serving the session; it changes when a provider fails over. */
  readonly model: ModelChoice;
  /** Sends one user message and runs until the session ends, stops, fails or hits a limit. */
  send(message: string): Promise<SessionOutcome>;
  usage(): SessionUsage;
  close(): void;
}

export type OpenedSession =
  | { ok: true; session: AgentSession }
  /** No candidate can serve right now. `retryAt` is the soonest one can again, or null when only a person can fix it. */
  | { ok: false; reason: string; retryAt: number | null };

export interface AgentSessions {
  open(request: SessionRequest): Promise<OpenedSession>;
}

// ---------------------------------------------------------------------------
// Browser: how the evaluator drives the running product, and how a scenario
// that passed once is replayed later without a model.
// ---------------------------------------------------------------------------

/** One recorded action. Elements are addressed the way a person names them: by role and accessible name. */
export type ReplayStep =
  | { action: "open"; path: string }
  | { action: "click"; role: string; name: string }
  | { action: "fill"; role: string; name: string; value: string }
  | { action: "press"; key: string }
  | { action: "snapshot" };

export interface ReplayScript {
  scenarioId: string;
  /** The page the scenario is judged on; the final snapshot must be taken there. */
  page: string;
  steps: readonly ReplayStep[];
}

export type CapturedEvidence =
  | { id: string; kind: "snapshot"; scenarioId: string | null; path: string; text: string }
  | { id: string; kind: "output"; scenarioId: string | null; command: string; text: string }
  | { id: string; kind: "screenshot"; scenarioId: string | null; path: string; file: string };

export interface BrowserSessionInput {
  /** Origin of the running product, e.g. http://127.0.0.1:41234. Navigation elsewhere is refused. */
  origin: string;
  /** Directory where screenshots are written. */
  artifactsDir: string;
  /** Runs the fixture a scenario declares before the evaluator starts on it. */
  seed(scenarioId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Runs a command-line scenario's command in the product's worktree. */
  runCommand(command: string): Promise<{ code: number | null; output: string }>;
}

export interface EvaluatorBrowser {
  /** begin_scenario, open_page, click, fill, press, snapshot, screenshot, run_command. */
  tools(): readonly ToolSpec[];
  /** Everything captured so far, by evidence id. */
  evidence(): ReadonlyMap<string, CapturedEvidence>;
  /** The actions taken for a scenario since it began, ending at its last snapshot. */
  script(scenarioId: string): ReplayScript | null;
  close(): Promise<void>;
}

export type OpenEvaluatorBrowser = (input: BrowserSessionInput) => Promise<EvaluatorBrowser>;

/** Replays a script against a running product and returns the final snapshot for the caller to judge. */
export type ReplayScriptRunner = (input: { origin: string; script: ReplayScript }) => Promise<{ ok: true; snapshot: string } | { ok: false; detail: string }>;
