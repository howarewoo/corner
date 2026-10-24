CREATE TABLE workspace_state (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE mutation_receipts (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  revision BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX mutation_receipts_user_revision ON mutation_receipts (user_id, revision);
CREATE TABLE corner_ai_runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, reference_date TEXT NOT NULL,
  base_revision BIGINT NOT NULL, result TEXT, error TEXT, error_code TEXT, error_status INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (user_id, kind, request_id)
);
CREATE INDEX corner_ai_runs_owner ON corner_ai_runs (user_id, created_at);
CREATE TABLE corner_subscription_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE corner_subscription_accounts (
  user_id TEXT PRIMARY KEY, encrypted TEXT NOT NULL, version BIGINT NOT NULL DEFAULT 1,
  refresh_owner TEXT, refresh_until BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE corner_subscription_attempts (
  state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
  encrypted TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX corner_subscription_attempt_owner ON corner_subscription_attempts (user_id);
CREATE TABLE corner_subscription_generations (user_id TEXT PRIMARY KEY, generation BIGINT NOT NULL);
