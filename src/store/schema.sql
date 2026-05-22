-- Schema for events.db. Indexer is the only writer. WAL for concurrent reads.
-- Mirrors the "Data Model" section of the v1 plan exactly. Do not add columns.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
  key                      TEXT PRIMARY KEY,    -- provider ':' session_id ':' transcript_path_hash
  provider                 TEXT NOT NULL,       -- 'claude' | 'codex' | 'agy'
  session_id               TEXT NOT NULL,
  transcript_path          TEXT,
  cwd                      TEXT,
  model                    TEXT,
  cli_version              TEXT,
  pid                      INTEGER,
  process_start_unix       INTEGER,             -- PID reuse guard
  started_at_ms            INTEGER NOT NULL,    -- our observed_at at first event
  last_event_at_ms         INTEGER NOT NULL,
  prior_state              TEXT,                -- for permission -> resume
  state                    TEXT NOT NULL,       -- derived; see state-machine.ts
  current_tool             TEXT,                -- when state='tool'
  last_prompt              TEXT,                -- truncated last user prompt, for display
  observed_parent_pid      INTEGER,             -- $PPID of the hook process
  observed_parent_starttime INTEGER,            -- /proc/$PPID/stat field 22; PID reuse guard
  origin                   TEXT,                -- codex session_meta source: 'cli' | 'exec' | 'mcp'
  context_tokens_used      INTEGER,             -- current context load, not lifetime
  context_tokens_max       INTEGER,
  context_source           TEXT                 -- 'reported' | 'model_lookup'
);

CREATE TABLE IF NOT EXISTS events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,  -- CANONICAL ORDER
  session_key              TEXT NOT NULL REFERENCES sessions(key),
  observed_at_ms           INTEGER NOT NULL,    -- our wall clock at ingest (display + freshness only)
  provider_ts              TEXT,                -- ISO, as-reported; display only
  source                   TEXT NOT NULL,       -- 'hook' | 'rollout'
  source_path              TEXT NOT NULL,       -- spool file or rollout file (dedup key)
  source_offset            INTEGER NOT NULL,    -- byte offset at start of this record (dedup key)
  kind                     TEXT NOT NULL,       -- normalized; see table in plan
  payload_json             TEXT                 -- compact JSON (or metadata marker when truncated)
);

CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_key, id);
CREATE INDEX IF NOT EXISTS events_dedup_idx   ON events(source_path, source_offset);
CREATE INDEX IF NOT EXISTS sessions_state_idx ON sessions(state, last_event_at_ms);
