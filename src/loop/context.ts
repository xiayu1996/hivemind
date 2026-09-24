import { join } from "node:path";
import type { ModelsFile } from "../agents/models.ts";
import type { PromptLibrary } from "../agents/prompt.ts";
import { runAgent, type AgentRun, type AgentTask } from "../agents/run.ts";
import type { Recipe } from "../domain/recipe.ts";
import type { Limits } from "../domain/stop.ts";
import type { AgentSessions, Board, Git, OpenEvaluatorBrowser, ReplayScriptRunner, RepositoryConfig, Role, RunCommand, StartApp } from "../ports.ts";
import type { RequirementRow, Store } from "../store/store.ts";
import type { Messages } from "./messages.ts";

export interface SessionLimits {
  maxTurns: number;
  timeoutMinutes: number;
}

export interface LoopConfig {
  workRoot: string;
  repositories: ReadonlyMap<string, RepositoryConfig>;
  models: ModelsFile;
  recipes: ReadonlyMap<string, Recipe>;
  limits: Limits;
  /** Per requirement, at API-equivalent prices. Zero means no ceiling. */
  defaultBudgetUsd: number;
  sessions: Readonly<Record<Role, SessionLimits>>;
  /** The environment of every command the loop or a session runs: an allowlist, never this process's. */
  childEnv(extra?: Readonly<Record<string, string>>): Record<string, string>;
}

/** Everything the loop touches, wired once in `src/main.ts`. */
export interface LoopContext {
  store: Store;
  board: Board;
  git: Git;
  sessions: AgentSessions;
  run: RunCommand;
  startApp: StartApp;
  openBrowser: OpenEvaluatorBrowser;
  replay: ReplayScriptRunner;
  prompts: PromptLibrary;
  messages: Messages;
  config: LoopConfig;
  now(): number;
  log(event: string, data: Record<string, unknown>): void;
}

export function worktreeOf(context: LoopContext, requirement: RequirementRow): string {
  return join(context.config.workRoot, "worktrees", requirement.id);
}

export function artifactsOf(context: LoopContext, requirement: RequirementRow, runLabel: string): string {
  return join(context.config.workRoot, "artifacts", requirement.id, runLabel);
}

export function repositoryOf(context: LoopContext, requirement: RequirementRow): RepositoryConfig {
  const repository = context.config.repositories.get(requirement.repo);
  if (repository === undefined) throw new Error(`requirement ${requirement.id} targets repository ${requirement.repo}, which is not configured`);
  return repository;
}

export function sessionLimits(context: LoopContext, role: Role): { maxTurns: number; timeoutMs: number } {
  const limits = context.config.sessions[role];
  return { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000 };
}

export function runSession<T>(context: LoopContext, task: AgentTask<T>): Promise<AgentRun<T>> {
  return runAgent(
    {
      sessions: context.sessions,
      log: context.store,
      billing: (provider) => context.config.models.providers[provider]?.billing ?? "metered",
    },
    task,
  );
}
