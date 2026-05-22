// All SQL lives here. Other modules call typed functions, never raw SQL.

import { prepare } from './db.ts';
import type { EventRow, NormalizedEvent, SessionRow, SessionState } from '../types.ts';

// --- sessions ----------------------------------------------------------------

// Upsert a session. New rows must come with a starting `state`; existing rows
// only update fields the caller actually set (COALESCE keeps prior values when
// the patch leaves a column undefined / null).
//
// Plan: started_at_ms is set once at first event; last_event_at_ms always moves
// forward to the latest observed_at_ms.
export interface SessionUpsert {
  key: string;
  provider: SessionRow['provider'];
  session_id: string;
  observed_at_ms: number;
  state: SessionState;
  transcript_path?: string | null;
  cwd?: string | null;
  model?: string | null;
  cli_version?: string | null;
  pid?: number | null;
  process_start_unix?: number | null;
  prior_state?: SessionState | null;
  current_tool?: string | null;
  last_prompt?: string | null;
  observed_parent_pid?: number | null;
  observed_parent_starttime?: number | null;
  origin?: string | null;
  context_tokens_used?: number | null;
  context_tokens_max?: number | null;
  context_source?: SessionRow['context_source'];
}

const SQL_UPSERT_SESSION = `
INSERT INTO sessions (
  key, provider, session_id, transcript_path, cwd, model, cli_version,
  pid, process_start_unix, started_at_ms, last_event_at_ms,
  prior_state, state, current_tool, last_prompt, observed_parent_pid,
  observed_parent_starttime, origin,
  context_tokens_used, context_tokens_max, context_source
) VALUES (
  $key, $provider, $session_id, $transcript_path, $cwd, $model, $cli_version,
  $pid, $process_start_unix, $observed_at_ms, $observed_at_ms,
  $prior_state, $state, $current_tool, $last_prompt, $observed_parent_pid,
  $observed_parent_starttime, $origin,
  $context_tokens_used, $context_tokens_max, $context_source
)
ON CONFLICT(key) DO UPDATE SET
  transcript_path     = COALESCE(excluded.transcript_path, sessions.transcript_path),
  cwd                 = COALESCE(excluded.cwd,             sessions.cwd),
  model               = COALESCE(excluded.model,           sessions.model),
  cli_version         = COALESCE(excluded.cli_version,     sessions.cli_version),
  pid                 = COALESCE(excluded.pid,             sessions.pid),
  process_start_unix  = COALESCE(excluded.process_start_unix, sessions.process_start_unix),
  last_event_at_ms    = MAX(excluded.last_event_at_ms, sessions.last_event_at_ms),
  prior_state         = excluded.prior_state,
  state               = excluded.state,
  current_tool        = excluded.current_tool,
  last_prompt         = COALESCE(excluded.last_prompt,     sessions.last_prompt),
  observed_parent_pid = COALESCE(excluded.observed_parent_pid, sessions.observed_parent_pid),
  observed_parent_starttime = COALESCE(excluded.observed_parent_starttime, sessions.observed_parent_starttime),
  origin              = COALESCE(excluded.origin,          sessions.origin),
  context_tokens_used = COALESCE(excluded.context_tokens_used, sessions.context_tokens_used),
  context_tokens_max  = COALESCE(excluded.context_tokens_max,  sessions.context_tokens_max),
  context_source      = COALESCE(excluded.context_source,      sessions.context_source)
`;

export function upsertSession(row: SessionUpsert): void {
  prepare(SQL_UPSERT_SESSION).run({
    $key: row.key,
    $provider: row.provider,
    $session_id: row.session_id,
    $transcript_path: row.transcript_path ?? null,
    $cwd: row.cwd ?? null,
    $model: row.model ?? null,
    $cli_version: row.cli_version ?? null,
    $pid: row.pid ?? null,
    $process_start_unix: row.process_start_unix ?? null,
    $observed_at_ms: row.observed_at_ms,
    $prior_state: row.prior_state ?? null,
    $state: row.state,
    $current_tool: row.current_tool ?? null,
    $last_prompt: row.last_prompt ?? null,
    $observed_parent_pid: row.observed_parent_pid ?? null,
    $observed_parent_starttime: row.observed_parent_starttime ?? null,
    $origin: row.origin ?? null,
    $context_tokens_used: row.context_tokens_used ?? null,
    $context_tokens_max: row.context_tokens_max ?? null,
    $context_source: row.context_source ?? null,
  });
}

const SQL_GET_SESSION_BY_KEY = `SELECT * FROM sessions WHERE key = $key`;

export function getSessionByKey(key: string): SessionRow | null {
  const row = prepare<SessionRow, [{ $key: string }]>(SQL_GET_SESSION_BY_KEY).get({
    $key: key,
  });
  return (row as SessionRow | null) ?? null;
}

// Find an existing session by (provider, session_id), regardless of which
// transcript_path-derived key it lives under. Hooks often emit events without
// the transcript_path field after SessionStart, so the reducer uses this to
// recover the canonical key.
const SQL_FIND_SESSION_BY_PROVIDER_SID = `
SELECT * FROM sessions WHERE provider = $provider AND session_id = $session_id
ORDER BY started_at_ms DESC LIMIT 1
`;

export function findSessionByProviderAndId(
  provider: SessionRow['provider'],
  sessionId: string,
): SessionRow | null {
  const row = prepare<SessionRow, [{ $provider: string; $session_id: string }]>(
    SQL_FIND_SESSION_BY_PROVIDER_SID,
  ).get({ $provider: provider, $session_id: sessionId });
  return (row as SessionRow | null) ?? null;
}

const SQL_FIND_REAL_SESSION_BY_PARENT = `
SELECT * FROM sessions
WHERE provider = $provider
  AND observed_parent_pid = $pid
  AND observed_parent_starttime = $starttime
  AND COALESCE(origin, '') != 'proc'
  AND session_id NOT LIKE 'proc-%'
  AND state NOT IN ('done', 'dead')
ORDER BY last_event_at_ms DESC
LIMIT 1
`;

export function findRealSessionByObservedParent(
  provider: SessionRow['provider'],
  pid: number,
  starttime: number,
): SessionRow | null {
  const row = prepare<SessionRow, [{ $provider: string; $pid: number; $starttime: number }]>(
    SQL_FIND_REAL_SESSION_BY_PARENT,
  ).get({ $provider: provider, $pid: pid, $starttime: starttime });
  return (row as SessionRow | null) ?? null;
}

const SQL_MARK_PROC_PLACEHOLDERS_DONE = `
UPDATE sessions
SET
  state = 'done',
  prior_state = NULL,
  current_tool = NULL,
  last_event_at_ms = MAX(last_event_at_ms, $observed_at_ms)
WHERE provider = $provider
  AND observed_parent_pid = $pid
  AND observed_parent_starttime = $starttime
  AND (origin = 'proc' OR session_id LIKE 'proc-%')
  AND state NOT IN ('done', 'dead')
`;

export function markProcPlaceholdersDone(
  provider: SessionRow['provider'],
  pid: number,
  starttime: number,
  observedAtMs: number,
): number {
  const info = prepare(SQL_MARK_PROC_PLACEHOLDERS_DONE).run({
    $provider: provider,
    $pid: pid,
    $starttime: starttime,
    $observed_at_ms: observedAtMs,
  });
  return info.changes;
}

// Some provider approval flows can leave the session row on `permission` when
// the follow-up event lands only in the rollout stream or after a writer-lock
// handoff. On read, derive a display row from the newest later lifecycle event
// for that same session so the TUI does not keep showing a stale approval card.
const SQL_CLEAR_RESOLVED_PERMISSIONS = `
UPDATE sessions
SET
  state = CASE latest.kind
    WHEN 'tool_call_start' THEN 'tool'
    WHEN 'tool_call_end' THEN 'thinking'
    WHEN 'turn_complete' THEN 'waiting'
    WHEN 'user_prompt' THEN 'thinking'
    WHEN 'session_stop' THEN 'done'
    ELSE sessions.state
  END,
  prior_state = NULL,
  current_tool = CASE latest.kind
    WHEN 'tool_call_start' THEN COALESCE(
      json_extract(latest.payload_json, '$.tool_name'),
      json_extract(latest.payload_json, '$.toolName'),
      json_extract(latest.payload_json, '$.name'),
      sessions.current_tool
    )
    WHEN 'tool_call_end' THEN NULL
    WHEN 'turn_complete' THEN NULL
    WHEN 'user_prompt' THEN NULL
    WHEN 'session_stop' THEN NULL
    ELSE sessions.current_tool
  END,
  last_event_at_ms = MAX(sessions.last_event_at_ms, latest.observed_at_ms)
FROM (
  SELECT e.session_key, e.kind, e.observed_at_ms, e.payload_json
  FROM events e
  JOIN (
    SELECT session_key, MAX(observed_at_ms) AS observed_at_ms
    FROM events
    WHERE kind IN (
      'tool_call_start',
      'tool_call_end',
      'turn_complete',
      'user_prompt',
      'session_stop'
    )
    GROUP BY session_key
  ) m
    ON m.session_key = e.session_key
   AND m.observed_at_ms = e.observed_at_ms
  WHERE e.kind IN (
    'tool_call_start',
    'tool_call_end',
    'turn_complete',
    'user_prompt',
    'session_stop'
  )
  GROUP BY e.session_key
) AS latest
WHERE sessions.key = latest.session_key
  AND sessions.state = 'permission'
  AND latest.observed_at_ms > sessions.last_event_at_ms
`;

export function clearResolvedPermissions(): number {
  const info = prepare(SQL_CLEAR_RESOLVED_PERMISSIONS).run();
  return info.changes;
}

// "Active" = not done/dead/stale. Used by the doctor command and the TUI grid.
const SQL_ACTIVE_SESSIONS = `
SELECT * FROM sessions
WHERE state NOT IN ('done', 'dead', 'stale')
ORDER BY last_event_at_ms DESC
`;

export function getActiveSessions(): SessionRow[] {
  return prepare<SessionRow, []>(SQL_ACTIVE_SESSIONS).all() as SessionRow[];
}

const SQL_ALL_SESSION_STATE_COUNTS = `
SELECT state, COUNT(*) AS count FROM sessions GROUP BY state ORDER BY state
`;

// Per-session progress stats: turn count (number of user prompts handled) and
// subagent count (other sessions actively running under the parent's
// `<sid>/subagents/` directory). These are surfaced in the card UI so the
// user can confirm a session is progressing without opening detail.
//
// Turn count uses COUNT(DISTINCT observed_at_ms / 10000) — i.e. dedup by
// 10-second buckets — because the hook indexer and the rollout reconciler
// both emit a user_prompt event for the same actual user message, with
// different source_paths (so the (source_path, source_offset) unique index
// doesn't catch them). Bucketing is the cheapest way to avoid double-counts.
//
// Subagent count is reported as TWO numbers: how many are currently running
// (last_event within 90s) and how many have ever existed under this parent.
// The card UI renders `Nactive/Ntotal subs` when total > 0 — answers both
// "is fan-out happening right now?" and "did this session fan out at all?".
const SQL_ALL_SESSION_STATS = `
SELECT
  s.key AS key,
  (SELECT COUNT(DISTINCT observed_at_ms / 10000) FROM events e
     WHERE e.session_key = s.key AND e.kind = 'user_prompt') AS turns,
  (SELECT COUNT(*) FROM sessions c
     WHERE c.session_id != s.session_id
       AND c.transcript_path LIKE '%' || s.session_id || '/subagents/%') AS subagents_total,
  (SELECT COUNT(*) FROM sessions c
     WHERE c.session_id != s.session_id
       AND c.transcript_path LIKE '%' || s.session_id || '/subagents/%'
       AND c.last_event_at_ms > (CAST(strftime('%s','now') AS INTEGER) * 1000 - 90000)) AS subagents_active
FROM sessions s
`;

export interface SessionStats {
  turns: number;
  subagentsActive: number;
  subagentsTotal: number;
}

export function getAllSessionStats(): Map<string, SessionStats> {
  const rows = prepare<
    { key: string; turns: number; subagents_active: number; subagents_total: number },
    []
  >(SQL_ALL_SESSION_STATS).all() as {
    key: string;
    turns: number;
    subagents_active: number;
    subagents_total: number;
  }[];
  const out = new Map<string, SessionStats>();
  for (const r of rows) {
    out.set(r.key, {
      turns: r.turns,
      subagentsActive: r.subagents_active,
      subagentsTotal: r.subagents_total,
    });
  }
  return out;
}

export function getSessionStateCounts(): { state: SessionState; count: number }[] {
  return prepare<{ state: SessionState; count: number }, []>(
    SQL_ALL_SESSION_STATE_COUNTS,
  ).all() as { state: SessionState; count: number }[];
}

// --- events ------------------------------------------------------------------

const SQL_INSERT_EVENT = `
INSERT INTO events (
  session_key, observed_at_ms, provider_ts, source, source_path, source_offset, kind, payload_json
) VALUES (
  $session_key, $observed_at_ms, $provider_ts, $source, $source_path, $source_offset, $kind, $payload_json
)
`;

// Returns the new row's auto-increment id. The indexer uses this to confirm
// inserts and (later) to associate downstream computations with canonical order.
export function insertEvent(ev: NormalizedEvent): number {
  const info = prepare(SQL_INSERT_EVENT).run({
    $session_key: ev.session_key,
    $observed_at_ms: ev.observed_at_ms,
    $provider_ts: ev.provider_ts ?? null,
    $source: ev.source,
    $source_path: ev.source_path,
    $source_offset: ev.source_offset,
    $kind: ev.kind,
    $payload_json: ev.payload_json ?? null,
  });
  return Number(info.lastInsertRowid);
}

// Order by observed_at_ms primarily so the user sees events in chronological
// order regardless of which source (hook vs rollout) ingested first; fall back
// to id for deterministic tie-breaking. Was id-only — Codex flagged that
// timestamps in the detail view appeared non-monotonic.
const SQL_RECENT_EVENTS_FOR_SESSION = `
SELECT * FROM events
WHERE session_key = $key
ORDER BY observed_at_ms DESC, id DESC
LIMIT $limit
`;

export function getRecentEventsForSession(key: string, limit = 50): EventRow[] {
  return prepare<EventRow, [{ $key: string; $limit: number }]>(
    SQL_RECENT_EVENTS_FOR_SESSION,
  ).all({ $key: key, $limit: limit }) as EventRow[];
}

// Spool/rollout resume: largest already-ingested byte offset for a path.
// NULL means "we have never seen this file" -- caller treats as 0.
const SQL_MAX_OFFSET_FOR_PATH = `
SELECT MAX(source_offset) AS max_offset FROM events WHERE source_path = $path
`;

export function getMaxOffsetForPath(sourcePath: string): number | null {
  const row = prepare<{ max_offset: number | null }, [{ $path: string }]>(
    SQL_MAX_OFFSET_FOR_PATH,
  ).get({ $path: sourcePath }) as { max_offset: number | null } | null;
  return row?.max_offset ?? null;
}

// Distinct source paths we've already ingested from. doctor uses it to surface
// which spool files are known to the DB.
const SQL_DISTINCT_SOURCE_PATHS = `SELECT DISTINCT source_path FROM events ORDER BY source_path`;

export function getKnownSourcePaths(): string[] {
  const rows = prepare<{ source_path: string }, []>(SQL_DISTINCT_SOURCE_PATHS).all() as {
    source_path: string;
  }[];
  return rows.map((r) => r.source_path);
}
