/**
 * Switchboard state store schema (spec §6), embedded as a string so it resolves
 * identically in dev (tsx), tests (vitest), and the bundled CLI (tsup) — no
 * runtime file lookup that a bundler would break. This module is the single
 * source of truth for the schema; it is applied idempotently at startup.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,          -- short id (also the tmux target suffix)
  client           TEXT NOT NULL,             -- 'claude' | 'codex'
  mode             TEXT NOT NULL,             -- 'deliverable' | 'interactive' | 'coordinated'
  role             TEXT,                      -- 'implementer'|'reviewer'|'decider'|'planner'|'solo'
  working_dir      TEXT NOT NULL,
  tmux_target      TEXT,                      -- 'session:window.pane' (interactive/attachable)
  status           TEXT NOT NULL,             -- starting|running|awaiting_input|awaiting_approval|done|failed|killed
  coordination_id  TEXT,                      -- FK -> coordination_plans.id
  egress_allowlist TEXT,                      -- JSON array of domains, optional
  summary          TEXT,                      -- final result summary (for deliverables)
  backend          TEXT,                      -- claude_sdk|claude_sdk_stream|claude_cli_console|codex_cli|ironcurtain (null=legacy)
  claude_session_id TEXT,                     -- SDK session id from the first system message (Inc4 resume)
  external_session_id TEXT,                   -- IronCurtain session UUID (sandboxed backend; durable across WS reconnects)
  backend_handle   TEXT,                      -- backend-specific handle JSON, e.g. {"label":3} for an IronCurtain WS session
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  FOREIGN KEY (coordination_id) REFERENCES coordination_plans (id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_coordination ON sessions (coordination_id);

CREATE TABLE IF NOT EXISTS coordination_plans (
  id                 TEXT PRIMARY KEY,
  command_audit_id   INTEGER NOT NULL,        -- originating command (FK -> audit_log.id)
  topology_json      TEXT NOT NULL,           -- model-authored, validated plan
  decider_session_id TEXT,
  phase              TEXT NOT NULL,           -- planning|implementing|reviewing|revising|deciding|done|replanning
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (command_audit_id) REFERENCES audit_log (id)
);

-- Append-only (Invariant 6). Enforced below by triggers, not just convention.
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  type            TEXT NOT NULL,
  session_id      TEXT,
  coordination_id TEXT,
  source          TEXT NOT NULL,
  payload_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log (type);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log (session_id);

-- The audit log is immutable: no row may ever be changed or removed. These
-- triggers make a violation a hard SQLite error, so a bug or an injected action
-- cannot quietly rewrite history (Invariant 6).
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only (Invariant 6): UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only (Invariant 6): DELETE forbidden');
END;

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  request_json TEXT NOT NULL,                 -- proposed action + resolved path/scope
  status       TEXT NOT NULL,                 -- pending|approved|denied|timeout
  decided_via  TEXT,                          -- signal|tty|dashboard|pane|policy_auto
  scope        TEXT NOT NULL DEFAULT 'once',   -- once|session (session = approve this tool for the rest of the session)
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER,
  notified_at  INTEGER,                        -- when the operator was pushed a prompt (survives restart)
  FOREIGN KEY (session_id) REFERENCES sessions (id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals (session_id);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  category      TEXT NOT NULL,                -- convention|task_pattern|feedback|policy_candidate
  proposed_text TEXT NOT NULL,
  target_file   TEXT,                         -- e.g. memory/conventions/sip.md
  status        TEXT NOT NULL,                -- pending|promoted|rejected
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions (id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON memory_proposals (status);

-- Inbound steering relay (§5.5 bidirectional). A vetted operator turn (from
-- Signal, the pane, or the dashboard) is enqueued here by the dispatcher and
-- drained IN ORDER by the in-pane streaming runner, which yields each row to the
-- SDK as an SDKUserMessage. The autoincrement id IS the total order. Steering
-- text is DATA (a model user-turn), never executed as a Switchboard command.
CREATE TABLE IF NOT EXISTS steering_inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  source      TEXT NOT NULL,             -- signal|pane|dashboard
  sender      TEXT,                      -- provenance (e.g. Signal E.164)
  body        TEXT NOT NULL,
  status      TEXT NOT NULL,             -- queued|consumed
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions (id)
);

CREATE INDEX IF NOT EXISTS idx_steering_session ON steering_inbox (session_id, status, id);

-- Outbound digest queue (the verbosity-split chokepoint). The streaming runner
-- enqueues ONLY status + final-result digests here (never token-by-token); the
-- daemon relays them to the operator over Signal. The full transcript stays in
-- the pane (and, in Inc3, a transcript table) — not on the phone.
CREATE TABLE IF NOT EXISTS session_outbound (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- status|result|notice
  body        TEXT NOT NULL,             -- Signal-ready digest line
  status      TEXT NOT NULL,             -- queued|sent
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions (id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_status ON session_outbound (status, id);

-- Durable conversation transcript (Inc3). The streaming runner appends the full
-- conversation here (user turns, assistant text, results, status) so the dashboard
-- can show it without the lossy/ANSI tmux capturePane snapshot. Append-only, like
-- audit_log: a transcript is display DATA (Invariant 4) and is never read back as
-- instruction or mutated.
CREATE TABLE IF NOT EXISTS transcript (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,             -- user|assistant|result|status
  source     TEXT NOT NULL,             -- pane|signal|dashboard|model|session
  text       TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript (session_id, seq);

CREATE TRIGGER IF NOT EXISTS transcript_no_update
  BEFORE UPDATE ON transcript
BEGIN
  SELECT RAISE(ABORT, 'transcript is append-only');
END;

CREATE TRIGGER IF NOT EXISTS transcript_no_delete
  BEFORE DELETE ON transcript
BEGIN
  SELECT RAISE(ABORT, 'transcript is append-only');
END;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('version', '2')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
`;
