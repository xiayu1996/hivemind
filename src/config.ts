import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { checkRecipe, recipeSchema, type Recipe } from "./domain/recipe.ts";
import { DEFAULT_LIMITS, type Limits } from "./domain/stop.ts";
import type { RepositoryConfig, Role } from "./ports.ts";

/**
 * The instance configuration (`~/.hivemind/config.yaml`, or the file named by
 * HIVEMIND_CONFIG): where this machine keeps its state, which board and
 * repositories it serves, and its limits. What the service is made of
 * (models, recipes, prompts, the words it shows people) lives in the
 * repository under `config/` and `prompts/`, versioned with the code that
 * reads it; an instance may point at its own models file.
 */

/** The checkout this process runs from: `config/` and `prompts/` are read from here. */
export const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const repositorySchema = z
  .object({
    name: z.string().regex(NAME, "a repository name is also a directory name: letters, digits, dot, dash, underscore"),
    url: z.string().min(1),
    defaultBranch: z.string().min(1).default("main"),
    push: z.boolean().default(false),
    /** Recipe for submissions that name none. */
    recipe: z.string().min(1).default("feature"),
  })
  .strict();

const sessionLimitsSchema = z.object({ maxTurns: z.number().int().positive(), timeoutMinutes: z.number().positive() }).strict();

const DEFAULT_SESSIONS: Record<Role, z.infer<typeof sessionLimitsSchema>> = {
  planner: { maxTurns: 150, timeoutMinutes: 60 },
  builder: { maxTurns: 250, timeoutMinutes: 90 },
  evaluator: { maxTurns: 120, timeoutMinutes: 40 },
};

const boardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), root: z.string().min(1).default("~/.hivemind/board") }).strict(),
  z
    .object({
      kind: z.literal("notion"),
      dataSourceId: z.string().min(1),
      /** The integration's own user id: what it writes is never read back as a person's input. */
      botUserId: z.string().min(1),
      /** Name of the secret holding the integration token. */
      tokenSecret: z.string().min(1).default("NOTION_TOKEN"),
      /** Overrides of the property names in config/messages.yaml, for a data source named differently. */
      properties: z
        .object({ title: z.string().min(1), repository: z.string().min(1), status: z.string().min(1), recipe: z.string().min(1), note: z.string().min(1) })
        .partial()
        .strict()
        .default({}),
    })
    .strict(),
]);

export const instanceSchema = z
  .object({
    /** Repository checkouts, one worktree per requirement, evaluation artifacts and logs. */
    workRoot: z.string().min(1).default("~/.hivemind/work"),
    database: z.string().min(1).default("~/.hivemind/hivemind.db"),
    /** KEY=VALUE lines, mode 600. Read into memory only; never exported to this process or its children. */
    secrets: z.string().min(1).default("~/.hivemind/secrets.env"),
    /** pi's credential file, where subscription logins live and are refreshed. */
    piAuth: z.string().min(1).default("~/.pi/agent/auth.json"),
    /** A models file of this instance's own, instead of config/models.yaml. */
    models: z.string().min(1).optional(),
    board: boardSchema.prefault({ kind: "local" }),
    repositories: z.array(repositorySchema).default([]),
    /** Per requirement, at API-equivalent prices, subscriptions included. Zero means no ceiling. */
    budgetUsd: z.number().nonnegative().default(20),
    limits: z
      .object({
        maxItemAttempts: z.number().int().positive(),
        maxReplans: z.number().int().nonnegative(),
        maxAuthorSessions: z.number().int().positive(),
        maxInconclusive: z.number().int().positive(),
        maxHandbacks: z.number().int().nonnegative(),
      })
      .partial()
      .strict()
      .default({}),
    sessions: z.object({ planner: sessionLimitsSchema, builder: sessionLimitsSchema, evaluator: sessionLimitsSchema }).partial().strict().default({}),
    /** How long the loop sleeps when nothing was worked on and nothing is due sooner. */
    pollSeconds: z.number().int().positive().default(60),
    /**
     * Variables of this process handed to every command a session or check
     * runs, beyond the minimal base. For what the target product itself needs
     * to start; never list a credential the product does not need.
     */
    passEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  })
  .strict();

export type InstanceFile = z.infer<typeof instanceSchema>;

export interface Instance {
  path: string;
  workRoot: string;
  database: string;
  secrets: string;
  piAuth: string;
  modelsFile: string;
  board: InstanceFile["board"];
  repositories: ReadonlyMap<string, RepositoryConfig>;
  budgetUsd: number;
  limits: Limits;
  sessions: Record<Role, { maxTurns: number; timeoutMinutes: number }>;
  pollSeconds: number;
  passEnv: readonly string[];
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

export function instancePath(): string {
  return expandHome(process.env.HIVEMIND_CONFIG ?? "~/.hivemind/config.yaml");
}

/** Reads the instance configuration; a missing file means every default (a local board, no repositories). */
export async function loadInstance(path = instancePath()): Promise<Instance> {
  let raw: unknown = {};
  try {
    raw = parseYaml(await readFile(path, "utf8")) ?? {};
  } catch (error) {
    if (!isMissing(error)) throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = instanceSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a valid instance configuration:\n${z.prettifyError(parsed.error)}`);
  const file = parsed.data;
  const repositories = new Map<string, RepositoryConfig>();
  for (const repository of file.repositories) {
    if (repositories.has(repository.name)) throw new Error(`${path}: repository ${repository.name} is listed twice`);
    repositories.set(repository.name, repository);
  }
  return {
    path,
    workRoot: expandHome(file.workRoot),
    database: expandHome(file.database),
    secrets: expandHome(file.secrets),
    piAuth: expandHome(file.piAuth),
    modelsFile: file.models === undefined ? join(APP_ROOT, "config", "models.yaml") : expandHome(file.models),
    board: file.board.kind === "local" ? { ...file.board, root: expandHome(file.board.root) } : file.board,
    repositories,
    budgetUsd: file.budgetUsd,
    limits: { ...DEFAULT_LIMITS, ...definedOnly(file.limits) },
    sessions: { ...DEFAULT_SESSIONS, ...definedOnly(file.sessions) },
    pollSeconds: file.pollSeconds,
    passEnv: file.passEnv,
  };
}

/**
 * Reads the secrets file into memory. It must be private to its owner: the
 * file holds every provider key, and a copy readable by other users is a leak
 * whether or not anyone has read it yet. A missing file is an empty set.
 */
export async function loadSecrets(path: string): Promise<Map<string, string>> {
  let text: string;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw new Error(`${path} is readable by other users; run: chmod 600 ${path}`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw error;
  }
  const secrets = new Map<string, string>();
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    // The line is not echoed: a malformed one may still hold a key.
    if (match === null) throw new Error(`${path}: line ${index + 1} is not NAME=value`);
    const value = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    secrets.set(match[1] ?? "", value);
  }
  return secrets;
}

/** Every recipe under config/recipes/, each checked for the rules its schema cannot express. */
export async function loadRecipes(directory = join(APP_ROOT, "config", "recipes")): Promise<Map<string, Recipe>> {
  const recipes = new Map<string, Recipe>();
  const findings: string[] = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".yaml")).toSorted()) {
    const parsed = recipeSchema.safeParse(parseYaml(await readFile(join(directory, file), "utf8")));
    if (!parsed.success) {
      findings.push(`${file}: ${z.prettifyError(parsed.error)}`);
      continue;
    }
    if (`${parsed.data.name}.yaml` !== file) findings.push(`${file}: the recipe is named ${parsed.data.name}; name the file after it`);
    findings.push(...checkRecipe(parsed.data).map((finding) => `${file}: ${finding}`));
    recipes.set(parsed.data.name, parsed.data);
  }
  if (findings.length > 0) throw new Error(`the recipes are not usable:\n${findings.join("\n")}`);
  return recipes;
}

/** The entries of a partial override that were actually given, so spreading it never writes an undefined. */
export function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
