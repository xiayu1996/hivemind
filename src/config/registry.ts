import { z } from "zod";
import { snapshotModelIds } from "../runner/catalog-snapshot.js";
import { THINKING_LEVELS } from "../runner/model-resolver.js";

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

const modelTier = z.enum(["brain", "standard", "cheap"]);

/**
 * A provider hivemind may spawn. Model ids are cross-checked against the
 * recorded catalogue (`fixtures/model-catalogs/`) rather than only at spawn
 * time: validation runs inside this schema and cannot await a pi spawn, so
 * without the recording a typo is accepted here and only surfaces later as a
 * card that cannot start. A provider with no recording yet is left to the
 * startup assertion, which does have the live catalogue.
 */
const providerProfiles = z.record(
  z.string().min(1),
  z.object({
    authType: z.enum(["api_key", "oauth"]),
    /** The environment variable pi reads the key from; see pi's docs/providers.md. */
    envKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    /**
     * Whether this provider's tokens cost money as they are spent. It decides
     * what the per-card ceiling counts: a flat-rate plan costs the same
     * whether a card uses it or not, so charging a card pi's notional price
     * for it would park it short of the money it was actually allowed to
     * spend. Omitted means it follows `authType`, which is right for both
     * providers configured today and wrong for a pay-as-you-go OAuth account,
     * which has to say so here.
     */
    billing: z.enum(["subscription", "metered"]).optional(),
    tiers: z.partialRecord(modelTier, z.string().min(1)),
  }).refine(
    (profile) => profile.authType !== "api_key" || profile.envKey !== undefined,
    { message: "an api_key provider must name the environment variable holding its key", path: ["envKey"] },
  ),
).superRefine((profiles, ctx) => {
  for (const [provider, profile] of Object.entries(profiles)) {
    const known = snapshotModelIds(provider);
    if (known.length === 0) continue; // no recording for this provider yet
    for (const [tier, id] of Object.entries(profile.tiers)) {
      if (!known.includes(id)) {
        ctx.addIssue({
          code: "custom",
          path: [provider, "tiers", tier],
          message: `${provider} does not advertise the model ${id}`,
        });
      }
    }
  }
});

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
  "retry.promptTimeoutMs": def({
    schema: positiveInt.max(6 * 3_600_000),
    default: 900_000,
    scope: "global",
    reload: "next-spawn",
    description: "How long one prompt may run before the turn is abandoned and resumed with a continue; a phase that needs longer than this is resumed, not failed.",
  }),
  "retry.maxRegressionReopens": def({
    schema: positiveInt.max(10),
    default: 2,
    scope: "global",
    reload: "hot",
    description: "Maximum times the E2E regression loop may reopen the same story.",
  }),
  "requirement.maxClarifyRounds": def({
    schema: positiveInt.max(20),
    default: 5,
    scope: "global",
    reload: "hot",
    description: "Question batches the product manager may put to a person before the requirement stops for a human decision.",
  }),
  "requirement.maxQuestionsPerRound": def({
    schema: positiveInt.max(20),
    default: 6,
    scope: "global",
    reload: "hot",
    description: "Questions in one batch; a longer list reads as an interrogation and gets answered carelessly.",
  }),

  // --- scheduling ---
  "schedule.activeSetPollMs": def({
    schema: positiveInt.min(5_000),
    default: 60_000,
    scope: "global",
    reload: "hot",
    description: "Polling interval for the active card set; the convergence guarantee behind webhooks.",
  }),
  "schedule.epicBranchFreshnessMs": def({
    schema: positiveInt.min(60_000),
    default: 86_400_000,
    scope: "global",
    reload: "hot",
    description: "Minimum interval between successful merges of main into an active Epic integration branch.",
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
  "model.providers": def({
    schema: providerProfiles,
    default: {
      // The flat-rate plan the standard and cheap tiers run on first, and the
      // brain tier falls back to. It declares a brain model even though the id
      // is flash-class: a requirement phase running on a weaker model is worse
      // than one running on gpt-5.6-sol and far better than a board that stops
      // until a usage window reopens. Which provider gets a tier *first* is
      // `model.tierFailoverChains`, not this record.
      "command-code": {
        authType: "api_key",
        envKey: "COMMAND_CODE_API_KEY",
        // A monthly plan with a credit allowance and no overage: the month
        // costs the same whether a card spends the allowance or not, so the
        // per-card ceiling must not charge a card pi's notional token price
        // for it. `authType` alone would infer metered and park cards short of
        // what they were allowed to spend.
        billing: "subscription",
        // One id for both tiers while deepseek-v4.1-flash is the discounted
        // one on the plan: it reasons, reads images and carries a 1M window, so
        // a second id would only spend more of the allowance for nothing. Which
        // id serves a tier is a price decision that moves, so it is decided
        // here or in the console and never in a call site; glm-5.3-flash stays
        // declared to pi so switching is a config write, not a redeploy.
        tiers: {
          brain: "deepseek/deepseek-v4.1-flash",
          standard: "deepseek/deepseek-v4.1-flash",
          cheap: "deepseek/deepseek-v4.1-flash",
        },
      },
      "openai-codex": {
        authType: "oauth",
        // Every tier is a 5.6-or-newer id on purpose: a ChatGPT subscription
        // rejects gpt-5.4, gpt-5.4-mini and gpt-5.3-codex-spark outright even
        // though pi lists all three, so a cheaper-looking id would fail the
        // capacity probe on every subscription host.
        tiers: { brain: "gpt-5.6-sol", standard: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
      },
      deepseek: {
        authType: "api_key",
        envKey: "DEEPSEEK_API_KEY",
        // One id for all three tiers: deepseek-flash is the only model this
        // account is meant to spend on, and it reasons, reads images and
        // carries a 1M window, so a separate brain id would only cost more for
        // nothing. Tiers still differ here, through model.purposeThinking.
        tiers: { brain: "deepseek-flash", standard: "deepseek-flash", cheap: "deepseek-flash" },
      },
    },
    scope: "global",
    reload: "hot",
    dangerous: true,
    description: "Every provider hivemind may spawn: how it authenticates, and which model serves each tier. Adding a provider or changing a model is a data change made here or in the console, never a code change. Ids are checked against the recorded catalogue on write and against the live one at startup, because pi accepts an unknown id with only a warning and then invents pricing for it.",
  }),
  "model.purposeTiers": def({
    schema: z.record(
      z.enum([
        "product_manager", "decompose", "design", "code", "verify", "ui_review",
        "merge", "capacity_probe", "triage", "distiller",
      ]),
      z.enum(["brain", "standard", "cheap"]),
    ),
    default: {
      product_manager: "brain",
      decompose: "brain",
      design: "brain",
      code: "standard",
      verify: "standard",
      // The product manager's acceptance of a screen is a judgment call about
      // what a person asked for, read off images: the same kind of work the
      // brain tier serves for the requirement phases.
      ui_review: "brain",
      merge: "standard",
      capacity_probe: "cheap",
      triage: "cheap",
      distiller: "cheap",
    },
    scope: "global",
    reload: "hot",
    description: "What each call site is for, and which tier serves it. Overriding a purpose here is the only way to move it between tiers.",
  }),
  "model.purposeThinking": def({
    schema: z.record(
      z.enum([
        "product_manager", "decompose", "design", "code", "verify", "ui_review",
        "merge", "capacity_probe", "triage", "distiller",
      ]),
      z.enum(THINKING_LEVELS),
    ),
    default: {
      product_manager: "high",
      decompose: "high",
      design: "high",
      code: "medium",
      verify: "medium",
      ui_review: "medium",
      merge: "low",
      capacity_probe: "off",
      triage: "low",
      distiller: "off",
    },
    scope: "global",
    reload: "hot",
    description: "Reasoning effort per call site. A level is only passed to a model whose catalogue row advertises thinking; the rest are spawned at pi's own default, because pi accepts an unusable argument without complaint.",
  }),
  "model.failoverChain": def({
    schema: z.array(z.string()).min(1),
    // Every provider hivemind may fall back to, in the order that serves a tier
    // with no ordering of its own. Subscriptions first, metered API behind
    // them: a flat-rate plan costs the same whether a card uses it or not, so
    // every turn one of them serves is a turn deepseek is not billed for.
    // deepseek is last and is the only provider that can run out of money, so
    // it is also the only reason the board may stop for want of a model.
    default: ["command-code", "openai-codex", "deepseek"],
    scope: "global",
    reload: "hot",
    description: "Every provider cards may run on, and the order tried when one is circuit-broken. It is also the provider universe: credentials, captured failure wordings and health are checked per entry. Order is a cost decision: flat-rate subscriptions come before metered APIs.",
  }),
  "model.tierFailoverChains": def({
    schema: z.partialRecord(modelTier, z.array(z.string()).min(1)),
    // The brain tier is the one place where order is not a cost decision: the
    // requirement phases read a person's words and judge a screen, and
    // gpt-5.6-sol is the only configured model bought for that, so it leads
    // however cheap the alternatives are. The rest of the chain exists so that
    // a spent ChatGPT window degrades the brain tier instead of stopping it:
    // command-code next because its plan is already paid for, deepseek behind
    // it because a metered API keeps answering when both windows are shut.
    // Tiers named here override the global order; the others inherit it.
    default: { brain: ["openai-codex", "command-code", "deepseek"] },
    scope: "global",
    reload: "hot",
    description: "Per-tier provider order, overriding model.failoverChain for the tiers it names. It may only name providers that are in the chain, because the chain is what gets credentials, captured failure wordings and health tracking.",
  }),
  "alert.requireOutOfBandChannel": def({
    schema: z.boolean(),
    default: true,
    scope: "global",
    reload: "drain-restart",
    description: "Refuse to start without a Feishu or SMTP channel. A Notion @mention raises no push notification (PoC R2), so the board is not a notification surface and needs_input would otherwise reach nobody.",
    dangerous: true,
  }),
  "retry.providerAutoRetries": def({
    schema: z.number().int().min(0).max(10),
    default: 0,
    scope: "global",
    reload: "hot",
    description: "pi's own provider-level retry count. Must stay 0: hivemind owns the failover decision, and a retry inside pi re-runs part of a phase on a model the orchestrator did not choose. Startup refuses a non-zero value.",
  }),
  "provider.failureThreshold": def({
    schema: positiveInt.max(20),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "Consecutive transient failures on one provider before its breaker opens and the chain drops that node.",
  }),
  "provider.transientOpenMs": def({
    schema: positiveInt.max(3_600_000),
    default: 60_000,
    scope: "global",
    reload: "hot",
    description: "How long a breaker stays open after transient failures, before a probe may run.",
  }),
  "provider.rateLimitOpenMs": def({
    schema: positiveInt.max(3_600_000),
    default: 30_000,
    scope: "global",
    reload: "hot",
    description: "How long a breaker stays open after a rate limit that named no window of its own.",
  }),
  "provider.quotaHoldMs": def({
    schema: positiveInt.max(24 * 3_600_000),
    default: 30 * 60_000,
    scope: "global",
    reload: "hot",
    description: "How long a breaker stays open after a subscription usage limit that named no window; a credentials probe cannot tell when the window reopens, so a real dispatch after this hold is the test.",
  }),
  "provider.credentialRefreshIntervalMs": def({
    schema: positiveInt.max(24 * 3_600_000),
    default: 600_000,
    scope: "per-host",
    reload: "hot",
    description: "How often the single refresher may rotate the shared credential file. Every other process probes read-only, so this is the only write to it.",
  }),
  "provider.quotaHoldMaxMs": def({
    schema: positiveInt.max(24 * 3_600_000),
    default: 4 * 3_600_000,
    scope: "global",
    reload: "hot",
    description: "Ceiling for the doubling hold after repeated usage limits that named no window; without a cap the backoff would outlive any real window.",
  }),
  "model.deferIfResetWithinMin": def({
    schema: positiveInt.max(180),
    default: 15,
    scope: "global",
    reload: "hot",
    description: "Usage-limit windows shorter than this are waited out; longer ones fail over to the next provider.",
  }),

  // --- cost guardrails ---
  "cost.perCardUsdCeiling": def({
    schema: z.number().positive(),
    default: 5,
    scope: "global",
    reload: "hot",
    dangerous: true,
    description: "Spend on metered providers that one card may reach before it stops and asks for more. USD, because that is what pi reports; 5 is roughly 35 CNY. Subscription usage is flat-rate and never counted. This is a spend limit, not a loop bound: the round ceilings in retry.* answer whether the system is going in circles, and neither question is a good proxy for the other.",
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
  // --- regression pools (03 doc section 4) ---
  "regression.windowSize": def({
    schema: positiveInt.max(200),
    default: 10,
    scope: "global",
    reload: "hot",
    description: "How many recent runs of one scenario a regression judgement looks at.",
  }),
  "regression.failureRateThreshold": def({
    schema: z.number().gt(0).max(1),
    default: 0.5,
    scope: "global",
    reload: "hot",
    description: "Failures below this share of the window are treated as flakiness rather than a break.",
  }),
  "regression.minFailures": def({
    schema: positiveInt.max(50),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "A break needs this many failures of the same signature before it earns a card.",
  }),
  "regression.epicPoolIntervalMs": def({
    schema: positiveInt.max(86_400_000),
    default: 900_000,
    scope: "global",
    reload: "hot",
    description: "How stale an active Epic's scenario may get before the epic pool re-runs it.",
  }),
  "regression.mainPoolIntervalMs": def({
    schema: positiveInt.max(604_800_000),
    default: 86_400_000,
    scope: "global",
    reload: "hot",
    description: "How stale a delivered scenario may get before the main pool re-runs it.",
  }),
  "regression.batchSize": def({
    schema: positiveInt.max(100),
    default: 5,
    scope: "global",
    reload: "hot",
    description: "How many scenarios one regression sweep takes, so a sweep cannot occupy the host indefinitely.",
  }),
  "schedule.maxConcurrentStories": def({
    schema: positiveInt.max(16),
    default: 1,
    scope: "per-host",
    reload: "hot",
    description: "How many Stories one host runs at once. The scheduler decides which Stories may run together; this decides how many of them fit on this machine. Kept at 1 while several concurrent pi processes still share one credential file: their OAuth refreshes rotate the same token and invalidate each other.",
  }),
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
  "verify.uiReview": def({
    schema: z.boolean(),
    default: true,
    scope: "global",
    reload: "hot",
    description: "Run the product manager's UI acceptance after a round the functional lane accepted: a separate session that reads the screens as images and may drive the browser, judging the Story against what a person asked for. It costs one extra brain-tier turn per accepted round of a Story that declares ui or e2e scenarios, and it needs a model whose catalogue row advertises image input; a host without one skips the lane rather than reviewing screens it cannot see.",
  }),
  "verify.chromiumSandbox": def({
    schema: z.boolean(),
    default: true,
    scope: "per-host",
    reload: "next-spawn",
    description: "Run the browser lane's Chromium with its process sandbox. Turn off only on a host that cannot build one (a container, or Ubuntu's user-namespace restriction that preflight reports) after the kernel fix is ruled out.",
    dangerous: true,
  }),
  "verify.appStartCommand": def({
    schema: z.array(z.string().trim().min(1)),
    default: [],
    scope: "per-repo",
    reload: "hot",
    description: "How to start the repository's application for the UI acceptance review, as argv run in the Story worktree. The reviewer needs a running page with data on it, not only the functional lane's screenshots; empty means there is no application to start and the review judges from screenshots alone.",
  }),
  "verify.appReadyUrl": def({
    schema: z.string().trim(),
    default: "",
    scope: "per-repo",
    reload: "hot",
    description: "URL polled until it answers 2xx or 3xx before the UI acceptance review starts, and handed to the reviewer as where the application is. Empty means do not wait.",
  }),
  "verify.appReadyTimeoutMs": def({
    schema: positiveInt,
    default: 60_000,
    scope: "per-repo",
    reload: "hot",
    description: "How long the application under review may take to answer at verify.appReadyUrl before the review is recorded inconclusive for lack of an application.",
  }),
  "verify.seedCommand": def({
    schema: z.array(z.string().trim().min(1)),
    default: [],
    scope: "per-repo",
    reload: "hot",
    description: "Argv run once per reviewed scenario that declares a seed, in the Story worktree, to put the sample data the scenario's given needs into the running application. It receives the seed text in HIVEMIND_SEED and the scenario id in HIVEMIND_SCENARIO. Empty means scenarios are reviewed against whatever data the application starts with.",
  }),
  "guard.e2eHostAllowlist": def({
    schema: z.array(z.string()),
    default: ["localhost", "127.0.0.1"],
    scope: "global",
    reload: "next-spawn",
    description: "Hosts an E2E run may navigate to. Anything else, including file://, is blocked.",
  }),
  "decompose.maxStoriesPerEpic": def({
    schema: positiveInt.max(20),
    default: 4,
    scope: "global",
    reload: "hot",
    description: "Stories one Epic may contain. A longer list is nearly always one feature cut by layer, which produces cards that cannot be verified or delivered on their own (03 doc section 8.5).",
  }),

  // --- deterministic CODE exit (03 doc section 8.1) ---
  "codeExit.projectChecks": def({
    schema: z.array(z.object({
      name: z.string().trim().min(1),
      command: z.array(z.string().trim().min(1)).min(1),
    }).strict()),
    default: [],
    scope: "per-repo",
    reload: "hot",
    description: "The repository's own gate commands (format, lint, typecheck, tests) as argv, run at the CODE exit. Declared per repository because hivemind does not get to decide how somebody else's repository is checked; empty means the exit rests on the commit, evidence and marker checks alone.",
  }),
  "codeExit.maxRounds": def({
    schema: positiveInt.max(10),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "How many times the CODE exit findings are handed back to the same session before the phase gives up. The findings cost no inner-loop round and no reentry; this only bounds the handback.",
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
