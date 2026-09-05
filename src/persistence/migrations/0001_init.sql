-- Central execution truth source. Notion is where human input is born; every
-- system-owned fact lives here.
--
-- Conventions:
--   * timestamps are epoch milliseconds (INTEGER), matching pi's own expires field
--   * enum-like columns are TEXT with CHECK constraints so bad states cannot land
--   * every table that a worker writes goes through the orchestrator API, so there
--     is exactly one writer process per row

-- A fuzzy requirement's whole lifecycle, from the ten-sentence card a human
-- creates to scenario-level acceptance. Epics born from it link back through
-- epics.requirement_id; acceptance is gated on every linked Epic being DONE.
CREATE TABLE IF NOT EXISTS requirements (
  id                TEXT PRIMARY KEY,
  notion_page_id    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'CLARIFY','PRD_CONFIRM','DECOMPOSING','EXECUTING','ACCEPTANCE','DONE','HUMAN_PARKED','FAILED')),
  original_request  TEXT NOT NULL,
  clarify_rounds    INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT CHECK (stop_reason IS NULL OR stop_reason = 'blocking_question'),
  resume_state      TEXT CHECK (resume_state IS NULL OR resume_state IN (
                      'CLARIFY','PRD_CONFIRM','DECOMPOSING','EXECUTING','ACCEPTANCE')),
  repo              TEXT,
  notion_status_shadow TEXT,
  human_wins_until  INTEGER,
  last_human_action_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirements_state ON requirements(state);

-- One row per question batch the PM posted. Answers arrive as page comments;
-- the loop marks the round answered only after it has read them back, so a
-- crash between posting and reading replays the read, never the questions.
CREATE TABLE IF NOT EXISTS requirement_clarify_rounds (
  requirement_id  TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  round           INTEGER NOT NULL CHECK (round > 0),
  questions       TEXT NOT NULL CHECK (json_valid(questions)),
  asked_at        INTEGER NOT NULL,
  answered_at     INTEGER,
  answers         TEXT CHECK (answers IS NULL OR json_valid(answers)),
  PRIMARY KEY (requirement_id, round),
  CHECK ((answered_at IS NULL) = (answers IS NULL))
);

-- The PRD freezes on confirmation. A rewrite after human feedback supersedes
-- the old revision instead of editing it, so what the human approved is always
-- reconstructible.
CREATE TABLE IF NOT EXISTS requirement_prds (
  requirement_id  TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  body            TEXT NOT NULL CHECK (json_valid(body)),
  status          TEXT NOT NULL CHECK (status IN ('draft','confirmed','superseded')),
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  PRIMARY KEY (requirement_id, revision),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (status <> 'draft' OR confirmed_at IS NULL)
);

-- Scenario-level acceptance: one row per PRD scenario, judged by the human in
-- business language. A gap spawns incremental work instead of reopening code.
CREATE TABLE IF NOT EXISTS requirement_acceptance_items (
  requirement_id  TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  prd_scenario_id TEXT NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','gap')),
  notion_block_id TEXT UNIQUE,
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (requirement_id, item_id),
  CHECK ((status = 'open') = (decided_at IS NULL))
);

-- Webhook and polling deliveries name the same event id, so only the first
-- delivery of a PRD confirmation or acceptance decision can act.
CREATE TABLE IF NOT EXISTS requirement_approval_events (
  event_id       TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('prd_confirm','prd_revision','acceptance')),
  source         TEXT NOT NULL CHECK (source IN ('comment','drag')),
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirement_approval_events ON requirement_approval_events(requirement_id);

-- Anchor blocks for the requirement page's owned sections, so a redelivery
-- updates in place instead of appending a second copy.
CREATE TABLE IF NOT EXISTS requirement_notion_sections (
  requirement_id  TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  section         TEXT NOT NULL CHECK (section IN ('metadata','original','clarify','prd','acceptance')),
  anchor_block_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (requirement_id, section)
);

CREATE TABLE IF NOT EXISTS epics (
  id                TEXT PRIMARY KEY,
  notion_page_id    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'INTAKE','DECOMPOSE','PLAN_APPROVAL','EXECUTING','EPIC_ACCEPT','DONE','BLOCKED','FAILED')),
  requirement_id    TEXT REFERENCES requirements(id),
  repo              TEXT,
  integration_branch TEXT,
  mr_url            TEXT,
  notion_status_shadow TEXT,
  human_wins_until  INTEGER,
  last_human_action_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id                TEXT PRIMARY KEY,
  epic_id           TEXT REFERENCES epics(id) ON DELETE CASCADE,
  notion_page_id    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  requirement       TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'QUEUED','DESIGN','CODE','VERIFY','MERGE','DELIVERED',
                      'REGRESSION_FIX','NEEDS_INPUT','HUMAN_PARKED','FAILED')),
  phase             TEXT,
  priority          INTEGER NOT NULL DEFAULT 2,
  repo              TEXT,
  branch            TEXT,
  target_branch     TEXT,
  mr_url             TEXT,
  capabilities      TEXT NOT NULL DEFAULT '[]',
  depends_on        TEXT NOT NULL DEFAULT '[]',
  predicted_footprint TEXT NOT NULL DEFAULT '[]',
  actual_footprint  TEXT,
  inner_loop_rounds INTEGER NOT NULL DEFAULT 0,
  phase_reentries   INTEGER NOT NULL DEFAULT 0,
  regression_reopens INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT CHECK (stop_reason IS NULL OR stop_reason IN (
                      'blocking_question','verify_loop_exceeded','retry_limit_exceeded')),
  resume_state      TEXT CHECK (resume_state IS NULL OR resume_state IN (
                      'QUEUED','DESIGN','CODE','VERIFY','MERGE','REGRESSION_FIX','NEEDS_INPUT')),
  notion_ai_status_shadow TEXT,
  human_wins_until  INTEGER,
  last_human_action_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_state ON stories(state);
CREATE INDEX IF NOT EXISTS idx_stories_epic ON stories(epic_id);

-- Capture is durable before Git fast-forward; recovery applies it only after the
-- recorded Story revision is an ancestor of the integration branch.
CREATE TABLE IF NOT EXISTS actual_footprint_captures (
  story_id           TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  integration_branch TEXT NOT NULL,
  base_revision      TEXT NOT NULL,
  story_revision     TEXT NOT NULL,
  actual_footprint   TEXT NOT NULL CHECK (json_valid(actual_footprint)),
  state              TEXT NOT NULL CHECK (state IN ('pending','applied')),
  created_at         INTEGER NOT NULL,
  applied_at         INTEGER,
  CHECK ((state = 'pending' AND applied_at IS NULL) OR (state = 'applied' AND applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_actual_footprint_captures_pending ON actual_footprint_captures(state, story_id);

-- Which scenarios exist, who owns them, and which pool re-verifies them. The
-- epic pool runs against the Epic head while its Stories are still landing; a
-- delivered Story's scenarios move to the main pool and are re-verified there.
CREATE TABLE IF NOT EXISTS scenario_registry (
  scenario_id      TEXT PRIMARY KEY,
  story_id         TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  epic_id          TEXT,
  pool             TEXT NOT NULL CHECK (pool IN ('epic','main')),
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenario_registry_pool ON scenario_registry(pool, last_verified_at);

-- Every regression observation, kept per revision so a failure can be judged
-- against a window instead of on its own.
CREATE TABLE IF NOT EXISTS regression_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id       TEXT NOT NULL,
  pool              TEXT NOT NULL CHECK (pool IN ('epic','main')),
  revision          TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('passed','failed')),
  failure_signature TEXT,
  ts                INTEGER NOT NULL,
  CHECK ((outcome = 'failed' AND failure_signature IS NOT NULL) OR
         (outcome = 'passed' AND failure_signature IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_regression_runs_scenario ON regression_runs(scenario_id, ts);

-- One card per distinct failure, so a deterministic break does not raise a new
-- card on every sweep.
CREATE TABLE IF NOT EXISTS regression_cards (
  scenario_id       TEXT NOT NULL,
  failure_signature TEXT NOT NULL,
  attributed_story  TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (scenario_id, failure_signature)
);

-- Provider health is central, not per process: one account per vendor means the
-- usage window and the concurrency limit are shared by every host, so a breaker
-- one machine opens must be visible to the others.
CREATE TABLE IF NOT EXISTS provider_health (
  provider             TEXT PRIMARY KEY,
  state                TEXT NOT NULL CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            INTEGER,
  retry_at             INTEGER,
  needs_human          INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0,1)),
  last_error_class     TEXT,
  last_error           TEXT,
  last_probe_at        INTEGER,
  updated_at           INTEGER NOT NULL,
  CHECK ((state = 'closed' AND opened_at IS NULL) OR (state <> 'closed' AND opened_at IS NOT NULL))
);

-- An accepted decomposition stays immutable behind this human approval gate.
CREATE TABLE IF NOT EXISTS epic_plans (
  epic_id       TEXT PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Both webhook and polling deliveries name the same event id, so only the first
-- delivery can open the gate.
CREATE TABLE IF NOT EXISTS epic_approval_events (
  event_id      TEXT PRIMARY KEY,
  epic_id       TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('comment','drag')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epic_approval_events_epic ON epic_approval_events(epic_id);

-- This durable dispatch intent is consumed by the normal Story scheduler.
CREATE TABLE IF NOT EXISTS execution_dispatches (
  story_id      TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  epic_id       TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  state         TEXT NOT NULL CHECK (state IN ('pending','dispatched','integrated')),
  created_at    INTEGER NOT NULL,
  dispatched_at INTEGER,
  integrated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_execution_dispatches_pending ON execution_dispatches(state, created_at);

CREATE TABLE IF NOT EXISTS phase_runs (
  run_id            TEXT PRIMARY KEY,
  card_id           TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  phase              TEXT NOT NULL CHECK (phase IN (
                     'DESIGN','CODE','VERIFY','MERGE','REGRESSION_FIX')),
  round              INTEGER NOT NULL CHECK (round > 0),
  session_id         TEXT,
  prompt_sha256      TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  status             TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  failure            TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  UNIQUE (card_id, phase, round),
  CHECK ((status = 'running' AND ended_at IS NULL) OR
         (status <> 'running' AND ended_at IS NOT NULL)),
  CHECK (status = 'failed' OR failure IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_phase_runs_card ON phase_runs(card_id, started_at);

CREATE TABLE IF NOT EXISTS phase_artifacts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL REFERENCES phase_runs(run_id) ON DELETE CASCADE,
  card_id            TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  phase              TEXT NOT NULL CHECK (phase IN (
                     'DESIGN','CODE','VERIFY','MERGE','REGRESSION_FIX')),
  round              INTEGER NOT NULL CHECK (round > 0),
  kind               TEXT NOT NULL,
  body               TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (run_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_phase_artifacts_card ON phase_artifacts(card_id, phase, round);

CREATE TABLE IF NOT EXISTS story_specs (
  spec_id          TEXT PRIMARY KEY,
  story_id         TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  text              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','passed','failed','withdrawn')),
  notion_block_id   TEXT UNIQUE,
  UNIQUE (story_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_story_specs_story ON story_specs(story_id, seq);

CREATE TABLE IF NOT EXISTS notion_sections (
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  section            TEXT NOT NULL CHECK (section IN (
                     'metadata','requirement','specification','design','verification','questions')),
  anchor_block_id    TEXT NOT NULL UNIQUE,
  content_block_id   TEXT,
  PRIMARY KEY (story_id, section)
);

CREATE TABLE IF NOT EXISTS notion_verification_rounds (
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  round             INTEGER NOT NULL,
  toggle_block_id   TEXT NOT NULL UNIQUE,
  summary           TEXT NOT NULL,
  archived_page_id  TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (story_id, round)
);

-- Card-level lease. Held by a host for the whole card (host stickiness); renewed
-- at phase boundaries. Acquisition and renewal are compare-and-swap on the
-- (holder, fence) pair so a stale holder can never overwrite a newer one.
CREATE TABLE IF NOT EXISTS leases (
  card_id      TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  fence        INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL,
  renewed_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(expires_at);

-- Append-only canonical event log. seq is monotonic per run.
CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  card_id    TEXT,
  phase      TEXT,
  type       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  data       TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_event_log_card ON event_log(card_id, ts);

-- Each Epic branch refresh is observable across scheduler restarts. The source
-- revision names main's lineage; this table never records a write to main.
CREATE TABLE IF NOT EXISTS epic_branch_refresh_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id        TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  outcome        TEXT NOT NULL CHECK (outcome IN ('attempted','succeeded','skipped','failed')),
  source_revision TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_epic_branch_refresh_events_epic ON epic_branch_refresh_events(epic_id, ts, id);

-- Transactional outbox: rows are written in the same transaction as the state
-- change, then delivered. payload_hash makes replay after a crash idempotent.
CREATE TABLE IF NOT EXISTS notion_outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       TEXT,
  priority      INTEGER NOT NULL DEFAULT 2,
  operation     TEXT NOT NULL,
  target        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  UNIQUE (target, payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notion_outbox(state, priority, id);

-- Four mutually exclusive token buckets, normalised at the provider adapter
-- boundary. reasoning is a subset of output and is never added on top.
CREATE TABLE IF NOT EXISTS cost_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  card_id        TEXT,
  phase          TEXT,
  purpose        TEXT,
  tier           TEXT,
  provider       TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  host_id        TEXT,
  prompt_version TEXT,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  is_subscription INTEGER NOT NULL DEFAULT 0,
  ts             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_card ON cost_entries(card_id, ts);
CREATE INDEX IF NOT EXISTS idx_cost_provider ON cost_entries(provider, ts);

-- One row per assistant turn, so prompt-cache losses can be told apart from the
-- structural ceiling that a whole-run ratio hides.
CREATE TABLE IF NOT EXISTS turn_usage (
  run_id            TEXT NOT NULL,
  turn              INTEGER NOT NULL,
  card_id           TEXT,
  phase             TEXT,
  provider          TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_loss_tokens INTEGER NOT NULL DEFAULT 0,
  ts                INTEGER NOT NULL,
  PRIMARY KEY (run_id, turn),
  CHECK (turn >= 1)
);
CREATE INDEX IF NOT EXISTS idx_turn_usage_card ON turn_usage(card_id, ts);

-- Code defaults are the fallback truth; these rows are an overlay on top.
CREATE TABLE IF NOT EXISTS config_entries (
  scope_id    TEXT NOT NULL DEFAULT 'global',
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope_id, key)
);

CREATE TABLE IF NOT EXISTS config_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id    TEXT NOT NULL DEFAULT 'global',
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL,
  value_json  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_history_key ON config_history(scope_id, key, version);

-- Comment ingest watermark. Block-anchored comments are invisible to a page-level
-- query, so anchor_block_ids records which blocks must be polled per page.
CREATE TABLE IF NOT EXISTS comment_watermark (
  page_id             TEXT PRIMARY KEY,
  max_created_time    INTEGER NOT NULL,
  anchor_block_ids    TEXT NOT NULL DEFAULT '[]',
  last_polled_at      INTEGER
);

CREATE TABLE IF NOT EXISTS ingested_comments (
  comment_id   TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL,
  block_id     TEXT,
  discussion_id TEXT,
  author       TEXT,
  body         TEXT NOT NULL,
  created_time INTEGER NOT NULL,
  ingested_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingested_page ON ingested_comments(page_id, created_time);

-- Names for the people Notion only ever names by id. Cached because every
-- ingested comment would otherwise cost a lookup, and a name a person reads on
-- their own requirement page must not depend on that lookup succeeding.
CREATE TABLE IF NOT EXISTS notion_users (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS human_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  TEXT NOT NULL UNIQUE REFERENCES ingested_comments(comment_id),
  card_id     TEXT,
  spec_id     TEXT,
  round       INTEGER,
  channel     TEXT NOT NULL CHECK (channel IN ('answer','rework','defect','preference','unclassified')),
  body        TEXT NOT NULL,
  applied_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_channel ON human_feedback(channel, created_at);

-- Builder and verifier must be different sessions. Enforced here rather than in
-- application code so no future code path can quietly bypass it.
CREATE TABLE IF NOT EXISTS verify_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id           TEXT NOT NULL,
  round             INTEGER NOT NULL,
  code_session_id   TEXT NOT NULL,
  verify_session_id TEXT NOT NULL,
  verdict           TEXT NOT NULL CHECK (verdict IN ('accepted','rejected','inconclusive')),
  failed_scenarios  TEXT NOT NULL DEFAULT '[]',
  evidence_dir      TEXT,
  screenshots       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(screenshots)),
  created_at        INTEGER NOT NULL,
  UNIQUE (card_id, round),
  CHECK (verify_session_id <> code_session_id)
);
CREATE INDEX IF NOT EXISTS idx_verify_card ON verify_records(card_id, round);

CREATE TABLE IF NOT EXISTS notion_media_delivery (
  evidence_id       TEXT PRIMARY KEY,
  card_id           TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  round             INTEGER NOT NULL CHECK (round >= 1),
  scenario_id       TEXT NOT NULL,
  local_path        TEXT NOT NULL,
  target_block_id   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','placeholder')),
  upload_id         TEXT,
  failure           TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((status = 'uploaded' AND upload_id IS NOT NULL AND failure IS NULL) OR
         (status = 'placeholder' AND upload_id IS NULL AND failure IS NOT NULL) OR
         (status = 'pending' AND upload_id IS NULL AND failure IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_notion_media_pending ON notion_media_delivery(status, created_at);
