// Reducer tests. Uses the fixture files as the source of truth for the shapes
// the indexer will see in production. Each fixture is a sequence of hook
// envelopes that exercises the full state machine: start, prompt, tool calls,
// permission round-trip, turn completion, stop.
//
// We don't touch SQLite here -- reducer.ts accepts an in-memory `lookup`
// callback. Pure-function tests should not need a DB.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { reduce } from '../src/indexer/reducer.ts';
import type {
  HookEnvelope,
  NormalizedEventKind,
  SessionRow,
  SessionState,
} from '../src/types.ts';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;

function readFixture(name: string): { line: string; offset: number; env: HookEnvelope }[] {
  const buf = fs.readFileSync(path.join(FIXTURES_DIR, name));
  const out: { line: string; offset: number; env: HookEnvelope }[] = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const nl = buf.indexOf(0x0a, cursor);
    if (nl === -1) break;
    const lineStart = cursor;
    const lineBytes = buf.subarray(lineStart, nl);
    const trimmed = lineBytes.toString('utf8').trim();
    if (trimmed.length > 0) {
      out.push({
        line: trimmed,
        offset: lineStart,
        env: JSON.parse(trimmed) as HookEnvelope,
      });
    }
    cursor = nl + 1;
  }
  return out;
}

// In-memory session store mirroring what the SQLite upsert would produce.
// We keep just the columns the reducer/state-machine actually read.
function makeStore() {
  const sessions = new Map<string, SessionRow>();
  function lookup(key: string): SessionRow | null {
    return sessions.get(key) ?? null;
  }
  function findBySid(provider: string, sessionId: string): SessionRow | null {
    for (const s of sessions.values()) {
      if (s.provider === provider && s.session_id === sessionId) return s;
    }
    return null;
  }
  function applyPatch(patch: ReturnType<typeof reduce> extends infer T
    ? T extends { sessionPatch: infer P } ? P : never : never): void {
    if (!patch) return;
    const existing = sessions.get(patch.key);
    const merged: SessionRow = {
      key: patch.key,
      provider: patch.provider,
      session_id: patch.session_id,
      transcript_path: patch.transcript_path ?? existing?.transcript_path ?? null,
      cwd: patch.cwd ?? existing?.cwd ?? null,
      model: patch.model ?? existing?.model ?? null,
      cli_version: patch.cli_version ?? existing?.cli_version ?? null,
      pid: patch.pid ?? existing?.pid ?? null,
      process_start_unix:
        patch.process_start_unix ?? existing?.process_start_unix ?? null,
      started_at_ms: existing?.started_at_ms ?? patch.observed_at_ms,
      last_event_at_ms: Math.max(
        patch.observed_at_ms,
        existing?.last_event_at_ms ?? 0,
      ),
      prior_state: patch.prior_state,
      state: patch.state,
      current_tool: patch.current_tool,
      last_prompt: patch.last_prompt ?? existing?.last_prompt ?? null,
      observed_parent_pid:
        patch.observed_parent_pid ?? existing?.observed_parent_pid ?? null,
      observed_parent_starttime:
        patch.observed_parent_starttime ?? existing?.observed_parent_starttime ?? null,
      origin: existing?.origin ?? null,
      context_tokens_used: existing?.context_tokens_used ?? null,
      context_tokens_max: existing?.context_tokens_max ?? null,
      context_source: existing?.context_source ?? null,
    };
    sessions.set(patch.key, merged);
  }
  return { sessions, lookup, findBySid, applyPatch };
}

interface ExpectedStep {
  // Index of the line in the fixture (0-based).
  index: number;
  kind: NormalizedEventKind;
  state: SessionState;
  // If set, assert prior_state explicitly. Otherwise we don't check it.
  priorState?: SessionState | null;
  currentTool?: string | null;
}

function runFixture(name: string, expected: ExpectedStep[]): void {
  const lines = readFixture(name);
  const store = makeStore();
  const sourcePath = path.join(FIXTURES_DIR, name);

  for (let i = 0; i < lines.length; i++) {
    const { env, offset } = lines[i]!;
    const reduced = reduce(env, sourcePath, offset, {
      source: 'hook',
      lookup: store.lookup,
      findBySid: store.findBySid as never,
      markProcDone: () => 0,
    });
    expect(reduced).not.toBeNull();
    if (!reduced) continue;
    store.applyPatch(reduced.sessionPatch);

    const exp = expected.find((e) => e.index === i);
    if (!exp) continue;

    expect(reduced.event.kind).toBe(exp.kind);
    const sess = store.sessions.get(reduced.event.session_key);
    expect(sess).toBeDefined();
    if (!sess) continue;
    expect(sess.state).toBe(exp.state);
    if (exp.priorState !== undefined) {
      expect(sess.prior_state).toBe(exp.priorState);
    }
    if (exp.currentTool !== undefined) {
      expect(sess.current_tool).toBe(exp.currentTool);
    }
  }
}

describe('reducer: claude fixture', () => {
  test('full sequence maps to expected normalized kinds and states', () => {
    runFixture('claude-hook-sample.jsonl', [
      // SessionStart -> session_start, state=waiting
      { index: 0, kind: 'session_start', state: 'waiting' },
      // UserPromptSubmit -> user_prompt, state=thinking
      { index: 1, kind: 'user_prompt', state: 'thinking' },
      // PreToolUse -> tool_call_start, state=tool, tool=Bash
      { index: 2, kind: 'tool_call_start', state: 'tool', currentTool: 'Bash' },
      // PostToolUse -> tool_call_end, state=thinking
      { index: 3, kind: 'tool_call_end', state: 'thinking', currentTool: null },
      // Notification (permission) -> permission_request, state=permission, prior=thinking
      {
        index: 4,
        kind: 'permission_request',
        state: 'permission',
        priorState: 'thinking',
      },
      // PreToolUse during permission -> tool_call_start, state=tool (escape)
      { index: 5, kind: 'tool_call_start', state: 'tool', currentTool: 'Bash' },
      // PostToolUse -> tool_call_end -> thinking
      { index: 6, kind: 'tool_call_end', state: 'thinking' },
      // Notification (idle) -> user_attention; state UNCHANGED (still thinking)
      { index: 7, kind: 'user_attention', state: 'thinking' },
      // TurnComplete -> turn_complete -> waiting
      { index: 8, kind: 'turn_complete', state: 'waiting' },
      // Stop hook fires on each turn end (NOT session end) -> turn_complete
      // -> waiting. Empirically validated against live Claude Code; there is
      // no reliable session-end hook on the agent side.
      { index: 9, kind: 'turn_complete', state: 'waiting' },
    ]);
  });
});

describe('reducer: codex fixture', () => {
  test('full sequence maps to expected normalized kinds and states', () => {
    runFixture('codex-hook-sample.jsonl', [
      { index: 0, kind: 'session_start', state: 'waiting' },
      { index: 1, kind: 'user_prompt', state: 'thinking' },
      { index: 2, kind: 'tool_call_start', state: 'tool', currentTool: 'shell' },
      { index: 3, kind: 'tool_call_end', state: 'thinking' },
      // Codex PermissionRequest (explicit) -> permission, prior=thinking
      {
        index: 4,
        kind: 'permission_request',
        state: 'permission',
        priorState: 'thinking',
      },
      { index: 5, kind: 'tool_call_start', state: 'tool', currentTool: 'shell' },
      { index: 6, kind: 'tool_call_end', state: 'thinking' },
      { index: 7, kind: 'turn_complete', state: 'waiting' },
      // Codex Stop fires on turn end too, same as Claude.
      { index: 8, kind: 'turn_complete', state: 'waiting' },
    ]);
  });
});

describe('reducer: notification disambiguation', () => {
  test('Notification with permission_request payload -> permission_request', () => {
    const env: HookEnvelope = {
      provider: 'claude',
      event: 'Notification',
      session_id: 's1',
      observed_at_ms: 1,
      payload: { permission_request: { tool: 'Bash' } },
    };
    const r = reduce(env, '/tmp/x.jsonl', 0, {
      lookup: () => null,
      findBySid: () => null,
      markProcDone: () => 0,
    });
    expect(r?.event.kind).toBe('permission_request');
  });

  test('Notification without permission shape -> user_attention', () => {
    const env: HookEnvelope = {
      provider: 'claude',
      event: 'Notification',
      session_id: 's1',
      observed_at_ms: 1,
      payload: { type: 'idle', message: 'Claude is waiting' },
    };
    const r = reduce(env, '/tmp/x.jsonl', 0, {
      lookup: () => null,
      findBySid: () => null,
      markProcDone: () => 0,
    });
    expect(r?.event.kind).toBe('user_attention');
  });
});

describe('reducer: session_resume on existing key', () => {
  test('SessionStart for an already-known session is normalized to session_resume', () => {
    const env: HookEnvelope = {
      provider: 'claude',
      event: 'SessionStart',
      session_id: 's1',
      observed_at_ms: 100,
      payload: { cwd: '/x', transcript_path: '/t' },
    };
    // First call: no existing session -> session_start.
    const first = reduce(env, '/tmp/x.jsonl', 0, {
      lookup: () => null,
      findBySid: () => null,
      markProcDone: () => 0,
    });
    expect(first?.event.kind).toBe('session_start');

    // Second call: pretend the session row exists -> session_resume, recovered.
    const fakeRow: SessionRow = {
      key: first!.sessionPatch.key,
      provider: 'claude',
      session_id: 's1',
      transcript_path: '/t',
      cwd: '/x',
      model: null,
      cli_version: null,
      pid: null,
      process_start_unix: null,
      started_at_ms: 50,
      last_event_at_ms: 90,
      prior_state: null,
      state: 'waiting',
      current_tool: null,
      last_prompt: null,
      observed_parent_pid: null,
      observed_parent_starttime: null,
      origin: null,
      context_tokens_used: null,
      context_tokens_max: null,
      context_source: null,
    };
    const second = reduce(env, '/tmp/x.jsonl', 100, {
      lookup: () => fakeRow,
      findBySid: () => fakeRow,
      markProcDone: () => 0,
    });
    expect(second?.event.kind).toBe('session_resume');
    expect(second?.sessionPatch.state).toBe('recovered');
  });

  test('stores hook parent pid and starttime from envelope', () => {
    const env: HookEnvelope = {
      provider: 'codex',
      event: 'SessionStart',
      session_id: 's1',
      observed_at_ms: 100,
      parent_pid: 1234,
      parent_starttime: 987654,
      payload: { cwd: '/x', transcript_path: '/t' },
    };
    const r = reduce(env, '/tmp/x.jsonl', 0, {
      lookup: () => null,
      findBySid: () => null,
      markProcDone: () => 0,
    });
    expect(r?.sessionPatch.observed_parent_pid).toBe(1234);
    expect(r?.sessionPatch.observed_parent_starttime).toBe(987654);
  });

  test('agy payload recovers conversationId, cwd, transcriptPath, and toolCall name', () => {
    const env: HookEnvelope = {
      provider: 'agy',
      event: 'PreToolUse',
      session_id: 'unknown',
      observed_at_ms: 100,
      payload: {
        conversationId: '2000470b-86e9-458b-9b2d-ed78d134e92a',
        workspacePaths: ['/home/chenyi/tools/todo_apps/agent-monitor'],
        transcriptPath:
          '/home/chenyi/.gemini/antigravity-cli/brain/2000470b-86e9-458b-9b2d-ed78d134e92a/.system_generated/logs/transcript.jsonl',
        toolCall: { name: 'list_dir', args: {} },
      },
    };
    const r = reduce(env, '/tmp/agy.jsonl', 0, {
      lookup: () => null,
      findBySid: () => null,
      markProcDone: () => 0,
    });
    expect(r?.sessionPatch.session_id).toBe('2000470b-86e9-458b-9b2d-ed78d134e92a');
    expect(r?.sessionPatch.cwd).toBe('/home/chenyi/tools/todo_apps/agent-monitor');
    expect(r?.sessionPatch.transcript_path).toContain('/brain/2000470b-86e9-458b-9b2d-ed78d134e92a/');
    expect(r?.sessionPatch.current_tool).toBe('list_dir');
    expect(r?.sessionPatch.state).toBe('tool');
  });

  test('agy PostToolUse with null toolCall is turn_complete', () => {
    const env: HookEnvelope = {
      provider: 'agy',
      event: 'PostToolUse',
      session_id: 'unknown',
      observed_at_ms: 100,
      payload: {
        conversationId: '2000470b-86e9-458b-9b2d-ed78d134e92a',
        workspacePaths: ['/repo'],
        toolCall: null,
      },
    };
    const r = reduce(env, '/tmp/agy.jsonl', 0, {
      lookup: () => null,
      findBySid: () => null,
      markProcDone: () => 0,
    });
    expect(r?.event.kind).toBe('turn_complete');
    expect(r?.sessionPatch.state).toBe('waiting');
  });
});
