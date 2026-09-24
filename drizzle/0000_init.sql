CREATE TABLE `approvals` (
	`requirement_id` text NOT NULL,
	`gate` text NOT NULL,
	`revision` text NOT NULL,
	`requested_at` text NOT NULL,
	`decision` text,
	`decided_at` text,
	PRIMARY KEY(`requirement_id`, `gate`, `revision`),
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_gate" CHECK("approvals"."gate" IN ('product', 'architecture', 'milestone')),
	CONSTRAINT "approvals_decision" CHECK(("approvals"."decision" IS NULL) = ("approvals"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`requirement_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "events_data_is_json" CHECK(json_valid("events"."data"))
);
--> statement-breakpoint
CREATE INDEX `events_requirement` ON `events` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `inputs` (
	`source_id` text PRIMARY KEY NOT NULL,
	`requirement_id` text NOT NULL,
	`kind` text NOT NULL,
	`gate` text,
	`revision` text,
	`author` text,
	`body` text,
	`at` text NOT NULL,
	`consumed_at` text,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inputs_kind" CHECK("inputs"."kind" IN ('approval', 'comment')),
	CONSTRAINT "inputs_approval_has_revision" CHECK(("inputs"."kind" = 'approval') = ("inputs"."revision" IS NOT NULL AND "inputs"."gate" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `inputs_requirement` ON `inputs` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`requirement_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`replans` integer DEFAULT 0 NOT NULL,
	`feedback` text,
	`passed_sha` text,
	`contract_digest` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`requirement_id`, `id`),
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "items_kind" CHECK("items"."kind" IN ('enabling', 'feature', 'fix')),
	CONSTRAINT "items_status" CHECK("items"."status" IN ('pending', 'passed', 'blocked')),
	CONSTRAINT "items_attempts" CHECK("items"."attempts" >= 0 AND "items"."replans" >= 0),
	CONSTRAINT "items_passed_has_sha" CHECK(("items"."status" = 'passed') = ("items"."passed_sha" IS NOT NULL) AND ("items"."status" = 'passed') = ("items"."contract_digest" IS NOT NULL)),
	CONSTRAINT "items_feedback_is_json" CHECK("items"."feedback" IS NULL OR json_valid("items"."feedback"))
);
--> statement-breakpoint
CREATE TABLE `leases` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`fence` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "leases_fence" CHECK("leases"."fence" > 0)
);
--> statement-breakpoint
CREATE TABLE `provider_health` (
	`provider` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`consecutive_failures` integer NOT NULL,
	`opened_at` integer,
	`retry_at` integer,
	`needs_human` integer NOT NULL,
	`last_error_class` text,
	`last_error` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "provider_health_state" CHECK("provider_health"."state" IN ('closed', 'open', 'half_open'))
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`requirement_id` text NOT NULL,
	`body` text NOT NULL,
	`options` text NOT NULL,
	`asked_at` text NOT NULL,
	`answer` text,
	`answered_at` text,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`board_ref` text NOT NULL,
	`repo` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`recipe` text NOT NULL,
	`step_index` integer DEFAULT 0 NOT NULL,
	`step_attempts` integer DEFAULT 0 NOT NULL,
	`step_findings` text,
	`status` text NOT NULL,
	`waiting` text,
	`stop_reason` text,
	`stop_detail` text,
	`budget_usd` real NOT NULL,
	`branch` text NOT NULL,
	`trunk_sha` text,
	`input_cursor` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "requirements_status" CHECK("requirements"."status" IN ('active', 'waiting', 'stopped', 'done')),
	CONSTRAINT "requirements_stop_reason" CHECK("requirements"."stop_reason" IS NULL OR "requirements"."stop_reason" IN ('no_progress', 'budget')),
	CONSTRAINT "requirements_stopped_has_reason" CHECK(("requirements"."status" = 'stopped') = ("requirements"."stop_reason" IS NOT NULL)),
	CONSTRAINT "requirements_waiting_has_subject" CHECK(("requirements"."status" = 'waiting') = ("requirements"."waiting" IS NOT NULL)),
	CONSTRAINT "requirements_waiting_is_json" CHECK("requirements"."waiting" IS NULL OR json_valid("requirements"."waiting")),
	CONSTRAINT "requirements_step_index" CHECK("requirements"."step_index" >= 0 AND "requirements"."step_attempts" >= 0),
	CONSTRAINT "requirements_step_findings_is_json" CHECK("requirements"."step_findings" IS NULL OR json_valid("requirements"."step_findings")),
	CONSTRAINT "requirements_budget" CHECK("requirements"."budget_usd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requirements_board_ref_unique` ON `requirements` (`board_ref`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`requirement_id` text NOT NULL,
	`item_id` text,
	`step` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`prompt_sha256` text NOT NULL,
	`outcome` text NOT NULL,
	`error_class` text,
	`error_message` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`billing` text NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_role" CHECK("runs"."role" IN ('planner', 'builder', 'evaluator')),
	CONSTRAINT "runs_outcome" CHECK("runs"."outcome" IN ('running', 'submitted', 'no_submit', 'error', 'timeout', 'interrupted')),
	CONSTRAINT "runs_billing" CHECK("runs"."billing" IN ('subscription', 'metered')),
	CONSTRAINT "runs_prompt_sha" CHECK(length("runs"."prompt_sha256") = 64),
	CONSTRAINT "runs_running_is_open" CHECK(("runs"."outcome" = 'running') = ("runs"."ended_at" IS NULL)),
	CONSTRAINT "runs_usage" CHECK("runs"."input_tokens" >= 0 AND "runs"."output_tokens" >= 0 AND "runs"."cache_read_tokens" >= 0 AND "runs"."cache_write_tokens" >= 0 AND "runs"."cost_usd" >= 0 AND "runs"."turns" >= 0)
);
--> statement-breakpoint
CREATE INDEX `runs_requirement` ON `runs` (`requirement_id`);