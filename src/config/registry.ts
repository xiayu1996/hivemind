import { z } from "zod";
import { snapshotModelIds } from "../runner/catalog-snapshot.js";
import { THINKING_LEVELS } from "../runner/model-resolver.js";
import { MODEL_PURPOSES, MODEL_TIERS } from "../pipeline/phase.js";

/** The surface of a call site that only reads. */
const READ_ONLY_TOOLS = ["find", "grep", "ls", "read"];

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

const modelTier = z.enum(MODEL_TIERS);

/**
 * Purposes are matched partially on purpose. `z.record` over a closed enum
 * demands every member, so a stored overlay naming one purpose would fail
 * validation whole and be dropped back to the defaults silently, and adding a
 * purpose would invalidate every overlay already in the database. Completeness
 * is carried by the defaults below instead, and a purpose nobody declared is
 * still rejected because the key set is closed.
 */
const modelPurpose = z.enum(MODEL_PURPOSES);

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
    default: 3,
    scope: "global",
    reload: "hot",
    description: "Rounds one Story may spend in the CODE<->VERIFY<->MERGE inner loop before it stops and asks a person. A rejected verification costs one; so does a merge whose re-verification failed on something this Story introduced. A crash, an environment-only verification, and a head that was already red cost nothing. Three rounds is what a Story that can be finished normally needs; a card that wants more is telling you something the next round will not fix.",
  }),
  "retry.maxPhaseReentries": def({
    schema: positiveInt.max(20),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "How many times one phase may be dispatched again after its run died, counting failover, crash recovery and cross-host rebuild together. The count is per phase, not per card: it clears as soon as the card moves forward, because a run that died in SHAPE says nothing about DESIGN. This is the crash safety net, not the work's round budget - that is retry.maxInnerLoopRounds.",
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
    schema: z.partialRecord(modelPurpose, modelTier),
    default: {
      product_manager: "brain",
      decompose: "brain",
      // SHAPE and SPECIFY each hold half of the acceptance bar: one reads a
      // sentence of requirement into scenarios that can be judged true or
      // false, the other turns a business-language `then` into assertions that
      // tell "done" from "not done" apart. Both outputs are short.
      shape: "brain",
      design: "brain",
      specify: "brain",
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
    schema: z.partialRecord(modelPurpose, z.enum(THINKING_LEVELS)),
    default: {
      product_manager: "high",
      decompose: "high",
      shape: "high",
      design: "high",
      specify: "high",
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
    description: "How many Stories one host runs at once, across every provider. The scheduler decides which Stories may run together; this decides how many of them fit on this machine. The binding limit is usually per-provider rather than per-host: one account throttles concurrent streams (roughly two to three before 429s, with no Retry-After to back off on), so schedule.maxConcurrentPerProvider is the bucket that matters and this is only the machine-wide cap. Sharing one credential file is not what constrains it; copying the file is, because an OAuth refresh rotates the token and invalidates every copy.",
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
  "prototype.root": def({
    schema: z.string().trim().min(1),
    default: "docs/prototype",
    scope: "per-repo",
    reload: "hot",
    description: "Where the repository keeps the interface contract a requirement with screens is built against: the token table, the component inventory and the runnable page prototypes. It is read from the branch a round runs on and injected into the phases that build screens, so a repository that keeps it elsewhere says so here rather than having two copies.",
  }),
  "guard.e2eHostAllowlist": def({
    schema: z.array(z.string()),
    default: ["localhost", "127.0.0.1"],
    scope: "global",
    reload: "next-spawn",
    description: "Hosts an E2E run may navigate to. Anything else, including file://, is blocked.",
  }),
  "decompose.planApproval": def({
    schema: z.boolean(),
    default: false,
    scope: "global",
    reload: "hot",
    description: "Whether a person reviews how an Epic was split before its Stories exist. Off by default: attention is the scarce resource, and it is spent where a delivery is judged (Epic acceptance), not on how the work was cut. On, the Epic waits in the board's planned column until somebody drags or comments it through, exactly as it always did.",
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
      /** Globs deciding whether this check is relevant to the round's changes;
       * absent means always run. */
      when: z.array(z.string().trim().min(1)).optional(),
      /** Names of checks that must pass first, for generator-then-consumer orders. */
      requires: z.array(z.string().trim().min(1)).optional(),
      /** Paths that must be unchanged after the check ran. A suite can stay
       * green while quietly rewriting the snapshots it is checked against, so
       * exit code zero is necessary and not sufficient. */
      assertCleanPaths: z.array(repositoryRelativePath).optional(),
    }).strict()),
    default: [],
    scope: "per-repo",
    reload: "hot",
    description: "The repository's own gate commands (format, lint, typecheck, tests) as argv, run at the CODE exit. Declared per repository because hivemind does not get to decide how somebody else's repository is checked; empty means the exit rests on the commit, evidence and marker checks alone. A check may name the file globs that make it relevant (when), the checks that must run before it (requires), and the generated paths it must leave untouched (assertCleanPaths).",
  }),
  "codeExit.protectedPaths": def({
    schema: z.array(repositoryRelativePath),
    default: [],
    scope: "per-repo",
    reload: "next-spawn",
    description: "Generated outputs no phase may edit by hand; they are fenced in the guard and re-checked at the CODE exit. Regenerating them through the repository's own command is how they are meant to change.",
  }),
  "codeExit.testPathPatterns": def({
    schema: z.array(z.string().trim().min(1)).min(1),
    default: ["**/*.test.*", "**/*.spec.*", "test/**", "tests/**", "__tests__/**"],
    scope: "per-repo",
    reload: "hot",
    description: "What counts as a test path. SPECIFY may write only these, its tree-pin reverts everything else it did not declare as scaffolding, and CODE is fenced out of them from the moment they are frozen.",
  }),
  "specifyExit.testCommand": def({
    schema: z.array(z.string().trim().min(1)),
    default: [],
    scope: "per-repo",
    reload: "hot",
    description: "The command whose JSON report proves SPECIFY's tests fail, as argv (for example npx vitest run --reporter=json). Declared per repository for the same reason the gate commands are: hivemind does not get to decide how somebody else's tests are run. Empty means SPECIFY cannot prove a red and refuses to freeze, which is the honest outcome -- a frozen contract nothing was measured against is worth less than no contract.",
  }),
  "codeExit.maxRounds": def({
    schema: positiveInt.max(10),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "How many times the CODE exit findings are handed back to the same session before the phase gives up. The findings cost no inner-loop round and no reentry; this only bounds the handback.",
  }),
  "specifyExit.maxRounds": def({
    schema: positiveInt.max(10),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "How many times the SPECIFY exit findings are handed back to the same session before the phase gives up. A contract in the wrong mode, or tests that do not fail for the reason they claim, is a work item the session that wrote it can fix in one turn; refusing it into a new run costs a whole phase and reads downstream as a crash. The findings cost no inner-loop round and no reentry; this only bounds the handback.",
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
  // --- agent runtime (07 doc section 2.2) ---
  // Seven keys rather than one, for two reasons: each carries its own reload
  // semantics, and a schema change to one must not put every stored overlay of
  // the others back through validation, which silently drops them.
  "agent.purposeTools": def({
    schema: z.partialRecord(modelPurpose, z.array(z.string().trim().min(1))),
    // One tool set for every phase. Per-phase tool surfaces bought nothing:
    // the forgery they were meant to stop (a file:// screenshot passed off as
    // e2e evidence) uses only read operations, and what actually stops it is
    // the navigation allowlist and the evidence check. Meanwhile a differing
    // tool block is a cache-prefix break at the very front of every request.
    // The write-capable set is the code default (`DEFAULT_AGENT_TOOLS`), named
    // in one place only; what is declared here is the exception to it. The
    // product manager and the decomposer write nothing: their whole output is
    // text a person approves, and either one editing the tree would be doing
    // the work it is supposed to be describing.
    default: { product_manager: READ_ONLY_TOOLS, decompose: READ_ONLY_TOOLS },
    scope: "global",
    reload: "next-spawn",
    description: "Tools each call site may use. The default is one set for every purpose: tool definitions lead the cached prefix, so a per-purpose surface breaks the cache for every request behind it, and phase discipline is carried by the prompt and the deterministic exits instead. Order is stable and must stay that way; one reordering invalidates every downstream cache entry.",
    dangerous: true,
  }),
  "agent.purposePrompts": def({
    schema: z.partialRecord(modelPurpose, z.object({
      /** Replaces the phase layer wholesale; absent uses the repository file. */
      text: z.string().min(1).optional(),
      /** Appended after the phase layer, for per-provider wording. */
      append: z.string().min(1).optional(),
    }).strict()),
    default: {},
    scope: "global",
    reload: "next-spawn",
    description: "Prompt text overrides per call site. The structure of a prompt is code; its wording is data, and this is where the wording can change without a release. An empty entry leaves the repository's prompt file in charge.",
  }),
  "agent.purposeGuard": def({
    schema: z.partialRecord(modelPurpose, z.object({
      fencedPatterns: z.array(z.string().min(1)).optional(),
      e2eHostAllowlist: z.array(z.string().min(1)).optional(),
    }).strict()),
    default: {},
    scope: "global",
    reload: "next-spawn",
    description: "The runtime red lines per call site. With one tool set everywhere these are the only physical constraints left: the patterns CODE may not write (the frozen tests) and the hosts a browsing phase may navigate to. Neither touches a tool schema, so neither breaks the cached prefix.",
    dangerous: true,
  }),
  "agent.purposeContext": def({
    schema: z.partialRecord(modelPurpose, z.array(repositoryRelativePath)),
    default: {},
    scope: "per-repo",
    reload: "next-spawn",
    description: "Repository files loaded explicitly for a call site, by path. Per-purpose context and a shared cross-phase prefix pull against each other: anything listed for one purpose and not another is a prefix break, so the default is no per-purpose customisation at all.",
  }),
  "agent.purposeLimits": def({
    schema: z.partialRecord(modelPurpose, z.object({
      promptTimeoutMs: positiveInt.optional(),
      maxContinueRetries: positiveInt.max(32).optional(),
      toolOutputMaxBytes: positiveInt.optional(),
      toolOutputMaxLines: positiveInt.optional(),
    }).strict()),
    default: {},
    scope: "global",
    reload: "hot",
    description: "Per call site timeouts, continue budget and tool-output truncation. Absent fields fall back to the retry.* family and the phase's own defaults.",
  }),
  "agent.purposeSkills": def({
    schema: z.partialRecord(modelPurpose, z.array(z.string().trim().min(1))),
    default: {},
    scope: "global",
    reload: "next-spawn",
    description: "Skill files or directories loaded explicitly for a call site. Discovery is off in every spawn, so this list is the whole of what a phase can see: the host's personal skills were being appended to the system prompt, which both cost tokens and made the prompt differ between machines.",
    dangerous: true,
  }),
  "agent.purposeMcp": def({
    schema: z.partialRecord(modelPurpose, z.array(z.string().trim().min(1))),
    default: {},
    scope: "global",
    reload: "next-spawn",
    description: "MCP servers a call site may reach, by extension path. Empty everywhere today; the browser lane deliberately does not go through MCP (02 doc section 4.3).",
    dangerous: true,
  }),
  "schedule.maxConcurrentPerProvider": def({
    schema: z.record(z.string().min(1), positiveInt.max(16)),
    default: {},
    scope: "global",
    reload: "hot",
    description: "How many spawns one provider may serve at once. A provider with no entry gets a conservative default from its auth type: two for a subscription, four for a metered key, because one account throttles concurrent streams and returns 429 with no Retry-After to back off on. The bucket is taken per spawn and released when it ends, so a card that fails over to another provider gives its slot back; waiting for one is a scheduling state and costs no failure round.",
  }),
  "retry.oscillationLookback": def({
    schema: positiveInt.max(12),
    default: 3,
    scope: "global",
    reload: "hot",
    description: "How many past rounds the convergence check looks back over before it calls a loop oscillating. The invariant is that a round must not fail on a set it has already produced; repeating the round before it is the same rule at a window of one, which is why there is no separate stagnation setting. Kept equal to retry.maxInnerLoopRounds so every round inside one budget is compared.",
  }),
  "cache.keyScope": def({
    schema: z.enum(["card", "repo"]),
    default: "card",
    scope: "global",
    reload: "next-spawn",
    description: "What a provider cache key groups. Cards share a repository's context, so a repository-wide key would hit more often, at the cost of routing every concurrent card to one instance and fighting the per-provider buckets. Decided by measurement.",
  }),
  "cache.retention": def({
    schema: z.enum(["short", "long", "none"]),
    // pi defaults to the short window. Phases of one card are minutes to tens
    // of minutes apart, so the short window expires a prefix that the key and
    // the ordering went to some trouble to make reusable.
    default: "long",
    scope: "global",
    reload: "next-spawn",
    description: "How long a provider should hold a cached prompt prefix. Only the adapters that carry a retention field honour it (OpenAI Responses, Anthropic); on the ChatGPT subscription path it only decides whether caching happens at all, and the window belongs to the backend. `none` turns prefix caching off and is a diagnostic setting, not an operating one.",
  }),
  "console.enabled": def({
    schema: z.boolean(),
    default: true,
    scope: "global",
    reload: "next-spawn",
    description: "Whether the resident orchestrator also serves the operations console. It runs in the same process because everything it shows is a read of the same central store; a separate service would be a second thing to deploy and keep alive for no added truth.",
  }),
  "console.host": def({
    schema: z.string().min(1),
    default: "127.0.0.1",
    scope: "global",
    reload: "next-spawn",
    description: "Address the console binds. A public wildcard is refused outright; an intranet address has to be named explicitly.",
  }),
  "console.port": def({
    schema: z.number().int().min(1).max(65_535),
    default: 3210,
    scope: "global",
    reload: "next-spawn",
    description: "Port the console listens on.",
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
