// Reducer: HookEnvelope -> { NormalizedEvent, optional sessionPatch }.
//
// Mostly deterministic on inputs. It consults existing session rows to merge
// hook events that omit transcript_path, and retires temporary proc-discovery
// placeholders once a real hook identifies the same parent process.
//
// The mapping table mirrors the "Normalized Event Kinds" table in the plan.
// Anything we can't map confidently is dropped (returns null) -- the indexer
// logs and moves on. Errors should never pass silently, but unrecognized hook
// names are not errors, they're just out of scope.

import { sessionKey } from '../paths.ts';
import { nextState, type StatePatch } from '../state-machine.ts';

// Looser sanity check: session_id must be non-empty and all printable ASCII.
// We accept synthetic test ids like "s1" or "claude-test-1"; we reject the
// real-world corruption case where a hook payload truncated mid-UTF-8 yields
// a session_id ending in U+FFFD (e.g. `<uuid>\xef\xbf\xbd`).
const SAFE_SID_RE = /^[\x20-\x7e]+$/;
import {
  findSessionByProviderAndId,
  getSessionByKey,
  markProcPlaceholdersDone,
} from '../store/queries.ts';
import type {
  EventMeta,
  HookEnvelope,
  NormalizedEvent,
  NormalizedEventKind,
  Provider,
  SessionRow,
} from '../types.ts';

// What the spool/reconciler hands us to persist.
export interface ReducedEvent {
  event: NormalizedEvent;
  // Patch to merge into the sessions row. Includes the keys the upsert needs
  // (key, provider, session_id, observed_at_ms, state) plus whatever the
  // reducer learned from the payload (cwd, model, last_prompt, ...).
  sessionPatch: SessionUpsertPatch;
}

export interface SessionUpsertPatch {
  key: string;
  provider: Provider;
  session_id: string;
  observed_at_ms: number;
  // Derived state (post state-machine).
  state: SessionRow['state'];
  prior_state: SessionRow['prior_state'];
  current_tool: SessionRow['current_tool'];
  // Metadata learned from the payload (only set when present).
  transcript_path: string | null;
  cwd: string | null;
  model: string | null;
  cli_version: string | null;
  pid: number | null;
  process_start_unix: number | null;
  last_prompt: string | null;
  observed_parent_pid: number | null;
  observed_parent_starttime: number | null;
}

// --- payload shape helpers ---------------------------------------------------

// Hook payloads can be arbitrary JSON. We treat them as an opaque record and
// pull fields by name with safe coercion. No assumptions about which keys
// will be present.
type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function firstString(v: unknown): string | null {
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
}

// --- Notification ambiguity --------------------------------------------------
//
// Claude's `Notification` hook fires for permission prompts, idle reminders,
// and assorted user-attention pings. The plan: only map to permission_request
// when the payload confirms a permission prompt; otherwise user_attention.
//
// We look for any of:
//  - `type` field that mentions "permission" or "tool_use" approval
//  - `permission_request` / `tool_permission` keys
//  - a `message` string containing "permission"
//
// Default is user_attention -- conservative, since misclassifying a stray
// notification as permission_request would freeze the session in `permission`
// until an escape event arrived.
function isPermissionNotification(payload: Json | null): boolean {
  if (!payload) return false;

  if (payload.permission_request != null) return true;
  if (payload.tool_permission != null) return true;
  if (payload.permission_prompt != null) return true;
  if (payload.requires_permission === true) return true;

  const type = asString(payload.type) ?? asString(payload.notification_type);
  if (type) {
    const t = type.toLowerCase();
    if (t.includes('permission')) return true;
    if (t === 'tool_use_permission' || t === 'permission_request') return true;
  }

  const msg = asString(payload.message) ?? asString(payload.title);
  if (msg) {
    const m = msg.toLowerCase();
    if (m.includes('permission') || m.includes('approve')) return true;
  }

  return false;
}

// --- raw hook event name -> normalized kind ----------------------------------
//
// The set of raw names is open (each provider sends its own), so we centralize
// the mapping here and return null for "don't care".
function mapHookEventToKind(
  env: HookEnvelope,
  payload: Json | null,
): NormalizedEventKind | null {
  switch (env.event) {
    case 'SessionStart':
      // We can't tell `session_resume` apart from `session_start` purely from
      // the hook name -- both fire SessionStart. The spool tailer disambiguates
      // by checking whether we already have a session row for this key. Done
      // in `reduce()` below, not here.
      return 'session_start';
    case 'UserPromptSubmit':
      return 'user_prompt';
    case 'PreToolUse':
      return 'tool_call_start';
    case 'PostToolUse':
      if (env.provider === 'agy' && payload?.toolCall == null) return 'turn_complete';
      return 'tool_call_end';
    case 'Notification':
      return isPermissionNotification(payload) ? 'permission_request' : 'user_attention';
    case 'PermissionRequest':
      // Codex hook (per plan); explicit permission signal, no ambiguity.
      return 'permission_request';
    case 'Stop':
      // Empirical: Claude Code's `Stop` hook fires when the assistant's TURN
      // completes (response finished, awaiting next prompt) -- not when the
      // session terminates. Codex `Stop` behaves identically. We therefore
      // map it to `turn_complete`, which transitions the session to `waiting`
      // rather than `done`. There is no reliable session-end hook on either
      // provider in v1; sessions disappear from "active" view via state-age
      // staleness instead.
      return 'turn_complete';
    case 'TurnComplete':
    case 'turn_complete':
      return 'turn_complete';
    default:
      return null;
  }
}

// --- payload metadata extraction --------------------------------------------
//
// Pull cwd/model/cli_version/pid/transcript_path/tool_name/user_prompt out of
// payloads. We try common shapes for both providers; missing fields are fine.
function extractMeta(env: HookEnvelope, payload: Json | null): EventMeta {
  const meta: EventMeta = {};
  if (!payload) return meta;

  // cwd: top-level on Claude rollout rows; sometimes nested under `payload`.
  const cwd =
    asString(payload.cwd) ??
    asString(asObject(payload.context)?.cwd) ??
    firstString(payload.workspacePaths);
  if (cwd) meta.cwd = cwd;

  // model: may be a string or an object with `id`.
  const modelRaw = payload.model;
  const model =
    asString(modelRaw) ?? asString(asObject(modelRaw)?.id) ?? asString(payload.model_id);
  if (model) meta.model = model;

  // cli_version: Claude uses `version`; Codex uses `cli_version`.
  const cliVersion = asString(payload.cli_version) ?? asString(payload.version);
  if (cliVersion) meta.cli_version = cliVersion;

  const pid = asNumber(payload.pid);
  if (pid != null) meta.pid = pid;

  const startUnix = asNumber(payload.process_start_unix) ?? asNumber(payload.started_at);
  if (startUnix != null) meta.process_start_unix = startUnix;

  const transcript =
    asString(payload.transcript_path) ??
    asString(payload.transcriptPath) ??
    asString(payload.session_file);
  if (transcript) meta.transcript_path = transcript;

  const toolName =
    asString(payload.tool_name) ??
    asString(asObject(payload.tool)?.name) ??
    asString(asObject(payload.toolCall)?.name) ??
    asString(payload.name);
  if (toolName) meta.tool_name = toolName;

  // User prompt: Claude's UserPromptSubmit puts it in `prompt`; rollout user
  // rows put it in `message.content`; Codex's `user_message` payload uses
  // `text`. We accept all three.
  const prompt =
    asString(payload.prompt) ??
    asString(asObject(payload.message)?.content) ??
    asString(payload.text);
  if (prompt) meta.user_prompt = prompt;

  return meta;
}

// --- payload_json (storage form) --------------------------------------------
//
// We persist a compact JSON of the original payload for debugging. If the hook
// already truncated it, we store the truncation marker instead -- no point
// re-serializing a prefix string.
function serializePayload(env: HookEnvelope): string | null {
  if (env.payload_truncated) {
    return JSON.stringify({
      payload_truncated: true,
      payload_bytes: env.payload_bytes ?? null,
      payload_prefix: env.payload_prefix ?? null,
    });
  }
  if (env.payload === undefined) return null;
  try {
    return JSON.stringify(env.payload);
  } catch {
    // Circular ref or BigInt or similar -- shouldn't happen with hook output
    // but we'd rather degrade than throw.
    return null;
  }
}

// --- main entry --------------------------------------------------------------

// Pure-ish reduce. The only impurity is the lookup of the existing session row
// (needed for three things: deciding session_start vs session_resume on a
// SessionStart hook, computing the state transition from prev.state, and
// recovering a known transcript_path when later events drop it). Tests pass
// `lookup` and `findBySid` to substitute an in-memory store for the DB.
export type SessionLookup = (key: string) => SessionRow | null;
export type FindSessionBySid = (
  provider: HookEnvelope['provider'],
  sessionId: string,
) => SessionRow | null;
export type MarkProcPlaceholdersDone = (
  provider: HookEnvelope['provider'],
  pid: number,
  starttime: number,
  observedAtMs: number,
) => number;

export function reduce(
  env: HookEnvelope,
  sourcePath: string,
  sourceOffset: number,
  opts: {
    source?: 'hook' | 'rollout';
    lookup?: SessionLookup;
    findBySid?: FindSessionBySid;
    markProcDone?: MarkProcPlaceholdersDone;
  } = {},
): ReducedEvent | null {
  const lookup = opts.lookup ?? getSessionByKey;
  const findBySid = opts.findBySid ?? findSessionByProviderAndId;
  const markProcDone = opts.markProcDone ?? markProcPlaceholdersDone;
  const source = opts.source ?? 'hook';
  const payload = asObject(env.payload);
  const payloadSessionId =
    asString(payload?.session_id) ??
    asString(payload?.conversationId) ??
    asString(payload?.conversation_id);
  const sessionId =
    env.session_id && env.session_id !== 'unknown'
      ? env.session_id
      : payloadSessionId ?? env.session_id;

  // Defensive: skip events whose session_id has non-printable bytes. Hook
  // scripts can emit corrupted ids when stdin is truncated mid-UTF-8 — those
  // values produce phantom rows like `claude:<uuid>\xef\xbf\xbd` that the
  // indexer can never reconcile away. Quietly drop them.
  if (!SAFE_SID_RE.test(sessionId)) return null;

  let kind = mapHookEventToKind(env, payload);
  if (!kind) return null; // unrecognized hook event -- skip.

  const meta = extractMeta(env, payload);

  // Hook events after SessionStart often omit transcript_path; recover it from
  // any existing session row for this (provider, session_id) so all events for
  // a single session share the same key. Falls back to whatever was in the
  // payload (or null) if we have no prior knowledge.
  let transcriptPath: string | null = meta.transcript_path ?? null;
  if (!transcriptPath) {
    const prior = findBySid(env.provider, sessionId);
    if (prior?.transcript_path) transcriptPath = prior.transcript_path;
  }
  const key = sessionKey(env.provider, sessionId, transcriptPath);

  // SessionStart -> if we've seen this key before, treat as resume (the agent
  // restarted or the user reopened the same session_id). The plan calls this
  // out specifically: "SessionStart hook w/ existing key" -> session_resume.
  const existing = lookup(key);
  if (kind === 'session_start' && existing) {
    kind = 'session_resume';
  }

  const observed = env.observed_at_ms;
  const event: NormalizedEvent = {
    session_key: key,
    observed_at_ms: observed,
    source,
    source_path: sourcePath,
    source_offset: sourceOffset,
    kind,
    payload_json: serializePayload(env) ?? undefined,
    meta,
  };

  // State machine: feed prev row + event -> patch.
  const eventForSm: NormalizedEvent = { ...event };
  const statePatch: StatePatch = nextState(existing, eventForSm);

  // Compose the session upsert. State is required; if the state-machine didn't
  // touch it, fall back to existing or initial waiting.
  const sessionPatch: SessionUpsertPatch = {
    key,
    provider: env.provider,
    session_id: sessionId,
    observed_at_ms: observed,
    state: statePatch.state ?? existing?.state ?? 'waiting',
    prior_state:
      'prior_state' in statePatch ? statePatch.prior_state ?? null : existing?.prior_state ?? null,
    current_tool:
      'current_tool' in statePatch ? statePatch.current_tool ?? null : existing?.current_tool ?? null,
    transcript_path: transcriptPath,
    cwd: meta.cwd ?? null,
    model: meta.model ?? null,
    cli_version: meta.cli_version ?? null,
    pid: meta.pid ?? null,
    process_start_unix: meta.process_start_unix ?? null,
    last_prompt: statePatch.last_prompt ?? null,
    // M6: parent process metadata travels on the envelope (top-level), not the
    // payload. Stored on sessions so liveness can prove quiet processes alive.
    observed_parent_pid:
      typeof env.parent_pid === 'number' && Number.isFinite(env.parent_pid)
        ? env.parent_pid
        : null,
    observed_parent_starttime:
      typeof env.parent_starttime === 'number' && Number.isFinite(env.parent_starttime)
        ? env.parent_starttime
        : null,
  };

  if (
    sessionPatch.observed_parent_pid != null &&
    sessionPatch.observed_parent_starttime != null &&
    !sessionId.startsWith('proc-')
  ) {
    markProcDone(
      env.provider,
      sessionPatch.observed_parent_pid,
      sessionPatch.observed_parent_starttime,
      observed,
    );
  }

  return { event, sessionPatch };
}
