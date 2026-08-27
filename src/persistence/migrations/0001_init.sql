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
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id                TEXT PRIMARY KEY,
  epic_id           TEXT REFERENCES epics(id) ON DELETE CASCADE,
  notion_page_id    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN (
                      'QUEUED','DESIGN','CODE','VERIFY','MERGE','DELIVERED',
                      'REGRESSION_FIX','NEEDS_INPUT','HUMAN_PARKED','FAILED')),
  phase             TEXT,
  priority          INTEGER NOT NULL DEFAULT 2,
  repo              TEXT,
  branch            TEXT,
  capabilities      TEXT NOT NULL DEFAULT '[]',
  depends_on        TEXT NOT NULL DEFAULT '[]',
  predicted_footprint TEXT NOT NULL DEFAULT '[]',
  actual_footprint  TEXT,
  inner_loop_rounds INTEGER NOT NULL DEFAULT 0,
  phase_reentries   INTEGER NOT NULL DEFAULT 0,
  regression_reopens INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT CHECK (stop_reason IS NULL OR stop_reason IN (
                      'blocking_question','verify_loop_exceeded','retry_limit_exceeded')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_state ON stories(state);
CREATE INDEX IF NOT EXISTS idx_stories_epic ON stories(epic_id);

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

-- Transactional outbox: rows are written in the same transaction as the state
-- change, then delivered. payload_hash makes replay after a crash idempotent.
CREATE TABLE IF NOT EXISTS notion_outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       TEXT,
  priority      INTEGER NOT NULL DEFAULT 2,
  operation     TEXT NOT NULL,
  payload       TEXT NOT NULL,
  payload_hash  TEXT NOT NULL UNIQUE,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER
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
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
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
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL,
  value_json  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_history_key ON config_history(key, version);

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
  created_at        INTEGER NOT NULL,
  UNIQUE (card_id, round),
  CHECK (verify_session_id <> code_session_id)
);
CREATE INDEX IF NOT EXISTS idx_verify_card ON verify_records(card_id, round);
