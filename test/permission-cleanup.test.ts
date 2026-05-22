import { afterEach, describe, expect, test } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDb, db, openDb } from '../src/store/db.ts';
import {
  clearResolvedPermissions,
  insertEvent,
  upsertSession,
} from '../src/store/queries.ts';

let root: string | null = null;

afterEach(async () => {
  closeDb();
  if (root) {
    await fsp.rm(root, { recursive: true, force: true });
    root = null;
  }
});

async function setupDb(): Promise<string> {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-perm-'));
  const dbPath = path.join(root, 'events.db');
  openDb(dbPath);
  return dbPath;
}

describe('clearResolvedPermissions', () => {
  test('moves a stuck permission row to the latest later lifecycle event', async () => {
    await setupDb();
    upsertSession({
      key: 'claude:s1',
      provider: 'claude',
      session_id: 's1',
      observed_at_ms: 1000,
      state: 'permission',
      prior_state: 'tool',
      current_tool: 'Bash',
    });
    insertEvent({
      session_key: 'claude:s1',
      observed_at_ms: 2000,
      source: 'hook',
      source_path: '/tmp/spool.jsonl',
      source_offset: 10,
      kind: 'tool_call_start',
      payload_json: JSON.stringify({ tool_name: 'Read' }),
    });

    expect(clearResolvedPermissions()).toBe(1);
    const row = db()
      .query<{ state: string; prior_state: string | null; current_tool: string | null; last_event_at_ms: number }, []>(
        "SELECT state, prior_state, current_tool, last_event_at_ms FROM sessions WHERE key = 'claude:s1'",
      )
      .get();
    expect(row).toEqual({
      state: 'tool',
      prior_state: null,
      current_tool: 'Read',
      last_event_at_ms: 2000,
    });
  });

  test('ignores later user_attention events', async () => {
    await setupDb();
    upsertSession({
      key: 'claude:s1',
      provider: 'claude',
      session_id: 's1',
      observed_at_ms: 1000,
      state: 'permission',
      prior_state: 'thinking',
      current_tool: 'Bash',
    });
    insertEvent({
      session_key: 'claude:s1',
      observed_at_ms: 2000,
      source: 'hook',
      source_path: '/tmp/spool.jsonl',
      source_offset: 10,
      kind: 'user_attention',
    });

    expect(clearResolvedPermissions()).toBe(0);
    const row = db()
      .query<{ state: string; prior_state: string | null; current_tool: string | null; last_event_at_ms: number }, []>(
        "SELECT state, prior_state, current_tool, last_event_at_ms FROM sessions WHERE key = 'claude:s1'",
      )
      .get();
    expect(row).toEqual({
      state: 'permission',
      prior_state: 'thinking',
      current_tool: 'Bash',
      last_event_at_ms: 1000,
    });
  });
});
