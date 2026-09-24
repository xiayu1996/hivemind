import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Execution state. Product knowledge (contract, architecture, plan, progress)
 * lives in the target repository under `.hivemind/`; this database only
 * records where each requirement is and what every agent session cost.
 *
 * This file is the single source of truth for the schema: migrations under
 * `drizzle/` are generated from it (`npm run db:generate`) and CI refuses a
 * schema change without its migration. Constraints live here, in the
 * database, so a bug in the loop cannot write a state the design forbids.
 */

export const requirements = sqliteTable(
  "requirements",
  {
    id: text("id").primaryKey(),
    boardRef: text("board_ref").notNull().unique(),
    repo: text("repo").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    recipe: text("recipe").notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    /** Sessions of the current step whose result was not accepted, and the findings of the last one. */
    stepAttempts: integer("step_attempts").notNull().default(0),
    stepFindings: text("step_findings"),
    status: text("status", { enum: ["active", "waiting", "stopped", "done"] }).notNull(),
    /** JSON describing what a waiting requirement waits for. */
    waiting: text("waiting"),
    stopReason: text("stop_reason", { enum: ["no_progress", "budget"] }),
    stopDetail: text("stop_detail"),
    budgetUsd: real("budget_usd").notNull(),
    branch: text("branch").notNull(),
    /**
     * The last commit of the integration branch that every gate accepted.
     * Attempts build on top of it, are squashed into one commit when they
     * pass, and are thrown away when the item is replanned.
     */
    trunkSha: text("trunk_sha"),
    inputCursor: text("input_cursor"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("requirements_status", sql`${table.status} IN ('active', 'waiting', 'stopped', 'done')`),
    check("requirements_stop_reason", sql`${table.stopReason} IS NULL OR ${table.stopReason} IN ('no_progress', 'budget')`),
    check("requirements_stopped_has_reason", sql`(${table.status} = 'stopped') = (${table.stopReason} IS NOT NULL)`),
    check("requirements_waiting_has_subject", sql`(${table.status} = 'waiting') = (${table.waiting} IS NOT NULL)`),
    check("requirements_waiting_is_json", sql`${table.waiting} IS NULL OR json_valid(${table.waiting})`),
    check("requirements_step_index", sql`${table.stepIndex} >= 0 AND ${table.stepAttempts} >= 0`),
    check("requirements_step_findings_is_json", sql`${table.stepFindings} IS NULL OR json_valid(${table.stepFindings})`),
    check("requirements_budget", sql`${table.budgetUsd} >= 0`),
  ],
);

export const items = sqliteTable(
  "items",
  {
    requirementId: text("requirement_id").notNull().references(() => requirements.id),
    id: text("id").notNull(),
    kind: text("kind", { enum: ["enabling", "feature", "fix"] }).notNull(),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    status: text("status", { enum: ["pending", "passed", "blocked"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    replans: integer("replans").notNull().default(0),
    /** JSON array of findings from the last failed attempt, handed to the next one. */
    feedback: text("feedback"),
    passedSha: text("passed_sha"),
    /** Digest of the acceptance items it covered when it passed; a different digest later means the contract changed under it. */
    contractDigest: text("contract_digest"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.requirementId, table.id] }),
    check("items_kind", sql`${table.kind} IN ('enabling', 'feature', 'fix')`),
    check("items_status", sql`${table.status} IN ('pending', 'passed', 'blocked')`),
    check("items_attempts", sql`${table.attempts} >= 0 AND ${table.replans} >= 0`),
    check(
      "items_passed_has_sha",
      sql`(${table.status} = 'passed') = (${table.passedSha} IS NOT NULL) AND (${table.status} = 'passed') = (${table.contractDigest} IS NOT NULL)`,
    ),
    check("items_feedback_is_json", sql`${table.feedback} IS NULL OR json_valid(${table.feedback})`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    requirementId: text("requirement_id").notNull().references(() => requirements.id),
    itemId: text("item_id"),
    step: text("step").notNull(),
    role: text("role", { enum: ["planner", "builder", "evaluator"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    /** interrupted: the process ended during the run; its usage was never reported. */
    outcome: text("outcome", { enum: ["running", "submitted", "no_submit", "error", "timeout", "interrupted"] }).notNull(),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** API-equivalent price, recorded for subscriptions too: a flat-rate plan is still money. */
    costUsd: real("cost_usd").notNull().default(0),
    billing: text("billing", { enum: ["subscription", "metered"] }).notNull(),
    turns: integer("turns").notNull().default(0),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => [
    index("runs_requirement").on(table.requirementId),
    check("runs_role", sql`${table.role} IN ('planner', 'builder', 'evaluator')`),
    check("runs_outcome", sql`${table.outcome} IN ('running', 'submitted', 'no_submit', 'error', 'timeout', 'interrupted')`),
    check("runs_billing", sql`${table.billing} IN ('subscription', 'metered')`),
    check("runs_prompt_sha", sql`length(${table.promptSha256}) = 64`),
    check("runs_running_is_open", sql`(${table.outcome} = 'running') = (${table.endedAt} IS NULL)`),
    check(
      "runs_usage",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.cacheReadTokens} >= 0 AND ${table.cacheWriteTokens} >= 0 AND ${table.costUsd} >= 0 AND ${table.turns} >= 0`,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    requirementId: text("requirement_id"),
    runId: text("run_id"),
    type: text("type").notNull(),
    data: text("data").notNull(),
  },
  (table) => [
    index("events_requirement").on(table.requirementId),
    check("events_data_is_json", sql`json_valid(${table.data})`),
  ],
);

export const inputs = sqliteTable(
  "inputs",
  {
    sourceId: text("source_id").primaryKey(),
    requirementId: text("requirement_id").notNull().references(() => requirements.id),
    kind: text("kind", { enum: ["approval", "comment"] }).notNull(),
    gate: text("gate", { enum: ["product", "architecture", "milestone"] }),
    revision: text("revision"),
    author: text("author"),
    body: text("body"),
    at: text("at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (table) => [
    index("inputs_requirement").on(table.requirementId),
    check("inputs_kind", sql`${table.kind} IN ('approval', 'comment')`),
    check("inputs_approval_has_revision", sql`(${table.kind} = 'approval') = (${table.revision} IS NOT NULL AND ${table.gate} IS NOT NULL)`),
  ],
);

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  requirementId: text("requirement_id").notNull().references(() => requirements.id),
  body: text("body").notNull(),
  options: text("options").notNull(),
  askedAt: text("asked_at").notNull(),
  answer: text("answer"),
  answeredAt: text("answered_at"),
});

export const approvals = sqliteTable(
  "approvals",
  {
    requirementId: text("requirement_id").notNull().references(() => requirements.id),
    gate: text("gate", { enum: ["product", "architecture", "milestone"] }).notNull(),
    revision: text("revision").notNull(),
    requestedAt: text("requested_at").notNull(),
    decision: text("decision", { enum: ["approved", "revise"] }),
    decidedAt: text("decided_at"),
  },
  (table) => [
    primaryKey({ columns: [table.requirementId, table.gate, table.revision] }),
    check("approvals_gate", sql`${table.gate} IN ('product', 'architecture', 'milestone')`),
    check("approvals_decision", sql`(${table.decision} IS NULL) = (${table.decidedAt} IS NULL)`),
  ],
);

export const providerHealth = sqliteTable(
  "provider_health",
  {
    provider: text("provider").primaryKey(),
    state: text("state", { enum: ["closed", "open", "half_open"] }).notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    openedAt: integer("opened_at"),
    retryAt: integer("retry_at"),
    needsHuman: integer("needs_human", { mode: "boolean" }).notNull(),
    lastErrorClass: text("last_error_class"),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("provider_health_state", sql`${table.state} IN ('closed', 'open', 'half_open')`)],
);

/** One row per singleton role. The fence only grows, so a holder that lost the lease cannot renew it. */
export const leases = sqliteTable(
  "leases",
  {
    name: text("name").primaryKey(),
    holder: text("holder").notNull(),
    fence: integer("fence").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [check("leases_fence", sql`${table.fence} > 0`)],
);
