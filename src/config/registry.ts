import { z } from "zod";

/**
 * How a changed value reaches a running process.
 *
 * `hot`           - applies to the next use, no restart
 * `next-spawn`    - applies to the next pi subprocess, running ones keep old policy
 * `drain-restart` - worker must finish its card and restart before it applies
 */
export type ReloadMode = "hot" | "next-spawn" | "drain-restart";

export type Scope = "global" | "per-host" | "per-repo";

export interface ConfigKeyDef<T> {
  schema: z.ZodType<T>;
  default: T;
  scope: Scope;
  reload: ReloadMode;
  description: string;
  /** High-risk keys require a second confirmation in the console. */
  dangerous?: boolean;
}

const def = <T>(d: ConfigKeyDef<T>): ConfigKeyDef<T> => d;

const positiveInt = z.number().int().positive();
const repositoryRelativePath = z.string().trim().min(1).refine(
  (path) => !path.startsWith("/") && !path.split("/").includes(".."),
  "must be a non-empty repository-relative path",
);

/**
 * Every dynamically configurable key. Defaults live here, in code, so the system
 * still runs with an empty config_entries table; the database only ever overlays.
 */
export const CONFIG_KEYS = {
  // --- retry ceilings (03 doc section 1.5) ---
  "retry.maxInnerLoopRounds": def({
    schema: positiveInt.max(50),
    default: 6,
    scope: "global",
    reload: "hot",
    description: "Maximum CODE<->VERIFY inner-loop rounds before the card is failed.",
  }),
  "retry.maxPhaseReentries": def({
    schema: positiveInt.max(20),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "Maximum re-entries of a single phase, counting failover, crash recovery and cross-host rebuild together.",
  }),
  "retry.maxContinueRetries": def({
    schema: positiveInt.max(50),
    default: 8,
    scope: "global",
    reload: "hot",
    description: "Maximum 'continue' retries after a stream interruption within one run.",
  }),
  "retry.maxRegressionReopens": def({
    schema: positiveInt.max(10),
    default: 2,
    scope: "global",
    reload: "hot",
    description: "Maximum times the E2E regression loop may reopen the same story.",
  }),

  // --- scheduling ---
  "schedule.activeSetPollMs": def({
    schema: positiveInt.min(5_000),
    default: 60_000,
    scope: "global",
    reload: "hot",
    description: "Polling interval for the active card set; the convergence guarantee behind webhooks.",
  }),
  "schedule.workerGraceMs": def({
    schema: positiveInt.min(60_000),
    default: 1_800_000,
    scope: "global",
    reload: "hot",
    description: "How long a worker may stay unreachable before its card lease is revoked and the card is requeued.",
  }),
  "schedule.concurrencyPerHost": def({
    schema: positiveInt.max(16),
    default: 2,
    scope: "per-host",
    reload: "drain-restart",
    description: "Cards a single worker may execute at once.",
  }),

  // --- model policy ---
  "model.tierMap": def({
    schema: z.record(
      z.enum(["brain", "standard", "cheap"]),
      z.record(z.string(), z.string()),
    ),
    default: {
      brain: { "openai-codex": "gpt-5.6-sol" },
      standard: { "openai-codex": "gpt-5.6-terra" },
      cheap: { "openai-codex": "gpt-5.4-mini" },
    },
    scope: "global",
    reload: "hot",
    description: "Tier to provider-model mapping. Model ids are validated against the provider catalogue at startup, because pi accepts an unknown id with only a warning.",
  }),
  "model.failoverChain": def({
    schema: z.array(z.string()).min(1),
    default: ["openai-codex"],
    scope: "global",
    reload: "hot",
    description: "Provider order tried when one is circuit-broken.",
  }),
  "model.deferIfResetWithinMin": def({
    schema: positiveInt.max(180),
    default: 15,
    scope: "global",
    reload: "hot",
    description: "Usage-limit windows shorter than this are waited out; longer ones fail over to the next provider.",
  }),

  // --- cost guardrails (alert only, never block) ---
  "cost.dailyUsdWarn": def({
    schema: z.number().positive(),
    default: 20,
    scope: "global",
    reload: "hot",
    description: "Daily spend that triggers an alert. Never blocks execution.",
  }),
  "cost.monthlyUsdWarn": def({
    schema: z.number().positive(),
    default: 300,
    scope: "global",
    reload: "hot",
    description: "Monthly spend that triggers an alert. Never blocks execution.",
  }),

  // --- parallel scheduling ---
  "schedule.hotspotPaths": def({
    schema: z.array(repositoryRelativePath),
    default: [],
    scope: "per-repo",
    reload: "hot",
    description: "Paths with a history of merge conflicts; stories touching them are serialised.",
  }),

  // --- guard ---
  "guard.extraWriteRoots": def({
    schema: z.array(z.string()),
    default: [],
    scope: "per-host",
    reload: "next-spawn",
    description: "Additional directories an agent may write to, beyond its worktree.",
  }),
  "guard.e2eHostAllowlist": def({
    schema: z.array(z.string()),
    default: ["localhost", "127.0.0.1"],
    scope: "global",
    reload: "next-spawn",
    description: "Hosts an E2E run may navigate to. Anything else, including file://, is blocked.",
  }),
  "guard.contextFilePolicy": def({
    schema: z.enum(["explicit", "inherit"]),
    default: "explicit",
    scope: "global",
    reload: "next-spawn",
    description: "'explicit' disables pi's upward CLAUDE.md/AGENTS.md discovery and loads only approved layers, preventing unrelated personal instructions from leaking into runs.",
  }),

  // --- stop switches ---
  "pause.intake": def({
    schema: z.boolean(),
    default: false,
    scope: "global",
    reload: "hot",
    description: "Stop claiming new cards. Work in flight continues.",
    dangerous: true,
  }),
  "pause.providers": def({
    schema: z.array(z.string()),
    default: [],
    scope: "global",
    reload: "hot",
    description: "Providers manually removed from the failover chain.",
    dangerous: true,
  }),
  "selfUpdate.pinnedVersion": def({
    schema: z.string().nullable(),
    default: null,
    scope: "global",
    reload: "hot",
    description: "Pin every worker to this version instead of rolling forward.",
    dangerous: true,
  }),
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;
export type ConfigValue<K extends ConfigKey> = (typeof CONFIG_KEYS)[K] extends ConfigKeyDef<infer T> ? T : never;

export const CONFIG_KEY_NAMES = Object.keys(CONFIG_KEYS) as ConfigKey[];
