import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Typed query surface over the hand-written migrations in ./migrations.
// The migrations are authoritative; schema.test.ts fails if the two drift apart.

const ms = (name: string) => integer(name, { mode: "number" });

export const epics = sqliteTable("epics", {
  id: text("id").primaryKey(),
  notionPageId: text("notion_page_id").notNull().unique(),
  title: text("title").notNull(),
  state: text("state").notNull(),
  repo: text("repo"),
  integrationBranch: text("integration_branch"),
  mrUrl: text("mr_url"),
  createdAt: ms("created_at").notNull(),
  updatedAt: ms("updated_at").notNull(),
});

export const stories = sqliteTable("stories", {
  id: text("id").primaryKey(),
  epicId: text("epic_id"),
  notionPageId: text("notion_page_id").notNull().unique(),
  title: text("title").notNull(),
  state: text("state").notNull(),
  phase: text("phase"),
  priority: integer("priority").notNull().default(2),
  repo: text("repo"),
  branch: text("branch"),
  capabilities: text("capabilities").notNull().default("[]"),
  dependsOn: text("depends_on").notNull().default("[]"),
  predictedFootprint: text("predicted_footprint").notNull().default("[]"),
  actualFootprint: text("actual_footprint"),
  innerLoopRounds: integer("inner_loop_rounds").notNull().default(0),
  phaseReentries: integer("phase_reentries").notNull().default(0),
  regressionReopens: integer("regression_reopens").notNull().default(0),
  stopReason: text("stop_reason"),
  createdAt: ms("created_at").notNull(),
  updatedAt: ms("updated_at").notNull(),
}, (t) => [index("idx_stories_state").on(t.state), index("idx_stories_epic").on(t.epicId)]);

export const leases = sqliteTable("leases", {
  cardId: text("card_id").primaryKey(),
  holder: text("holder").notNull(),
  fence: integer("fence").notNull(),
  acquiredAt: ms("acquired_at").notNull(),
  renewedAt: ms("renewed_at").notNull(),
  expiresAt: ms("expires_at").notNull(),
}, (t) => [index("idx_leases_expiry").on(t.expiresAt)]);

export const eventLog = sqliteTable("event_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  cardId: text("card_id"),
  phase: text("phase"),
  type: text("type").notNull(),
  ts: ms("ts").notNull(),
  data: text("data").notNull(),
}, (t) => [
  uniqueIndex("event_log_run_id_seq_unique").on(t.runId, t.seq),
  index("idx_event_log_card").on(t.cardId, t.ts),
]);

export const notionOutbox = sqliteTable("notion_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: text("card_id"),
  priority: integer("priority").notNull().default(2),
  operation: text("operation").notNull(),
  payload: text("payload").notNull(),
  payloadHash: text("payload_hash").notNull().unique(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ms("created_at").notNull(),
  sentAt: ms("sent_at"),
}, (t) => [index("idx_outbox_pending").on(t.state, t.priority, t.id)]);

export const costEntries = sqliteTable("cost_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  cardId: text("card_id"),
  phase: text("phase"),
  purpose: text("purpose"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  reasoningTokens: integer("reasoning_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  isSubscription: integer("is_subscription").notNull().default(0),
  ts: ms("ts").notNull(),
}, (t) => [index("idx_cost_card").on(t.cardId, t.ts), index("idx_cost_provider").on(t.provider, t.ts)]);

export const configEntries = sqliteTable("config_entries", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  updatedAt: ms("updated_at").notNull(),
});

export const configHistory = sqliteTable("config_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  valueJson: text("value_json").notNull(),
  updatedBy: text("updated_by").notNull(),
  ts: ms("ts").notNull(),
}, (t) => [index("idx_config_history_key").on(t.key, t.version)]);

export const commentWatermark = sqliteTable("comment_watermark", {
  pageId: text("page_id").primaryKey(),
  maxCreatedTime: ms("max_created_time").notNull(),
  anchorBlockIds: text("anchor_block_ids").notNull().default("[]"),
  lastPolledAt: ms("last_polled_at"),
});

export const ingestedComments = sqliteTable("ingested_comments", {
  commentId: text("comment_id").primaryKey(),
  pageId: text("page_id").notNull(),
  blockId: text("block_id"),
  discussionId: text("discussion_id"),
  author: text("author"),
  body: text("body").notNull(),
  createdTime: ms("created_time").notNull(),
  ingestedAt: ms("ingested_at").notNull(),
}, (t) => [index("idx_ingested_page").on(t.pageId, t.createdTime)]);

export const humanFeedback = sqliteTable("human_feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  commentId: text("comment_id").notNull().unique(),
  cardId: text("card_id"),
  specId: text("spec_id"),
  round: integer("round"),
  channel: text("channel").notNull(),
  body: text("body").notNull(),
  createdAt: ms("created_at").notNull(),
}, (t) => [index("idx_feedback_channel").on(t.channel, t.createdAt)]);

export const verifyRecords = sqliteTable("verify_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: text("card_id").notNull(),
  round: integer("round").notNull(),
  codeSessionId: text("code_session_id").notNull(),
  verifySessionId: text("verify_session_id").notNull(),
  verdict: text("verdict").notNull(),
  failedScenarios: text("failed_scenarios").notNull().default("[]"),
  evidenceDir: text("evidence_dir"),
  createdAt: ms("created_at").notNull(),
}, (t) => [
  uniqueIndex("verify_records_card_id_round_unique").on(t.cardId, t.round),
  index("idx_verify_card").on(t.cardId, t.round),
]);

export const schemaMigrations = sqliteTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: ms("applied_at").notNull(),
});

export const NOW = sql`(unixepoch() * 1000)`;
