// Shared types across indexer, reconciler, state machine, and TUI.
// Single source of truth — agents working on different milestones import from here.

export type Provider = 'claude' | 'codex' | 'agy';

// Normalized event kinds — small closed set both providers map into.
// `thinking` is a derived state, not an event kind (see plan: dropped `assistant_thinking`).
export type NormalizedEventKind =
  | 'session_start'
  | 'session_resume'
  | 'user_prompt'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'permission_request'
  | 'user_attention'
  | 'turn_complete'
  | 'session_stop';

export type SessionState =
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'waiting'
  | 'idle'
  | 'stale'
  | 'dead'
  | 'done'
  | 'recovered';

// Hook envelope written to per-session spool files by provider hook scripts.
export interface HookEnvelope {
  provider: Provider;
  event: string; // raw hook event name: 'PreToolUse', 'Stop', 'UserPromptSubmit', ...
  session_id: string;
  observed_at_ms: number;
  payload?: unknown;
  payload_truncated?: true;
  payload_bytes?: number;
  payload_prefix?: string;
  parent_pid?: number; // $PPID of the hook process (M6, diagnostic only)
}

// Reducer output: a single normalized event plus optional session-row mutations.
export interface NormalizedEvent {
  session_key: string;
  observed_at_ms: number;
  provider_ts?: string;
  source: 'hook' | 'rollout';
  source_path: string;
  source_offset: number;
  kind: NormalizedEventKind;
  payload_json?: string;
  meta?: EventMeta;
}

// Optional metadata extracted from the payload by the reducer.
// Used to upsert the corresponding sessions row.
export interface EventMeta {
  cwd?: string;
  model?: string;
  cli_version?: string;
  pid?: number;
  process_start_unix?: number;
  transcript_path?: string;
  tool_name?: string;
  user_prompt?: string;
  observed_parent_pid?: number;
}

// SQLite sessions row.
export interface SessionRow {
  key: string;
  provider: Provider;
  session_id: string;
  transcript_path: string | null;
  cwd: string | null;
  model: string | null;
  cli_version: string | null;
  pid: number | null;
  process_start_unix: number | null;
  started_at_ms: number;
  last_event_at_ms: number;
  prior_state: SessionState | null;
  state: SessionState;
  current_tool: string | null;
  last_prompt: string | null;
  observed_parent_pid: number | null;
  // Codex sessions carry a `source` in session_meta: 'cli' (interactive),
  // 'exec' (one-shot codex exec), 'mcp' (spawned by another agent via MCP).
  // null when unknown (Claude sessions or pre-migration rows).
  origin: string | null;
  // Current context load, not lifetime tokens. Source is either provider-
  // reported (Codex) or inferred from the model table (Claude).
  context_tokens_used: number | null;
  context_tokens_max: number | null;
  context_source: 'reported' | 'model_lookup' | null;
}

// SQLite events row (after insert; id is auto-assigned).
export interface EventRow {
  id: number;
  session_key: string;
  observed_at_ms: number;
  provider_ts: string | null;
  source: 'hook' | 'rollout';
  source_path: string;
  source_offset: number;
  kind: NormalizedEventKind;
  payload_json: string | null;
}
