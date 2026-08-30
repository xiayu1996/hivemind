-- Central execution truth source. Notion is where human input is born; every
-- system-owned fact lives here.
--
-- Conventions:
--   * timestamps are epoch milliseconds (INTEGER), matching pi's own expires field
--   * enum-like columns are TEXT with CHECK constraints so bad states cannot land
--   * every table that a worker writes goes through the orchestrator API, so there
--     is exactly one writer process per row

CREATE TABLE IF NOT EXISTS epics (
  id                TEXT PRIMARY KEY,
  notion_page_id    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'INTAKE','DECOMPOSE','PLAN_APPROVAL','EXECUTING','EPIC_ACCEPT','DONE','BLOCKED','FAILED')),
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
  state         TEXT NOT NULL CHECK (state IN ('pending','dispatched')),
  created_at    INTEGER NOT NULL,
  dispatched_at INTEGER
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
