// retention.test.ts -- compactOnce drops old events in chunks, leaves recent
// events alone, and never touches the sessions table.
//
// We open an isolated SQLite under a tmpdir and seed it via raw INSERT so the
// test is independent of the reducer / spool tailer paths.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { compactOnce } from '../src/retention.ts';
import { closeDb, openDb } from '../src/store/db.ts';

interface Tmp {
  root: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}

async function mkTmp(): Promise<Tmp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-retention-'));
  const dbPath = path.join(root, 'events.db');
  return {
    root,
    dbPath,
    cleanup: async () => {
      closeDb();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

let active: Tmp | null = null;
afterEach(async () => {
  if (active) {
    await active.cleanup();
    active = null;
  }
});

// Seed N events for one synthetic session at the given observed_at_ms.
function seedEvents(dbPath: string, sessionKey: string, count: number, atMs: number): void {
  const db = openDb(dbPath);
  // Need a sessions row first (FK).
  db.prepare(
    `INSERT OR IGNORE INTO sessions (
      key, provider, session_id, transcript_path, cwd, model, cli_version,
      pid, process_start_unix, started_at_ms, last_event_at_ms,
      prior_state, state, current_tool, last_prompt, observed_parent_pid,
      observed_parent_starttime
    ) VALUES (?, 'claude', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 'thinking', NULL, NULL, NULL, NULL)`,
  ).run(sessionKey, sessionKey, atMs, atMs);

  const insert = db.prepare(
    `INSERT INTO events (session_key, observed_at_ms, provider_ts, source, source_path, source_offset, kind, payload_json)
     VALUES (?, ?, NULL, 'hook', ?, ?, 'user_prompt', NULL)`,
  );
  // Wrap in a transaction so seed of 5000 rows is fast.
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    insert.run(sessionKey, atMs, `/tmp/seed-${sessionKey}.jsonl`, i);
  }
  db.exec('COMMIT');
}

describe('compactOnce', () => {
  test('drops events older than maxAgeDays in chunked transactions', async () => {
    active = await mkTmp();

    const now = 10 * 24 * 60 * 60 * 1000; // 10 days into the epoch
    const oldAt = now - 8 * 24 * 60 * 60 * 1000; // 8d ago: gets dropped
    const newAt = now - 1 * 24 * 60 * 60 * 1000; // 1d ago: kept

    seedEvents(active.dbPath, 'sess-old', 2500, oldAt);
    seedEvents(active.dbPath, 'sess-new', 500, newAt);

    const stats = await compactOnce({
      maxAgeDays: 7,
      batchSize: 1000,
      nowMs: now,
    });

    // 2500 old rows deleted in 3 batches (1000, 1000, 500), then a 0-row pass
    // terminates the loop; the 0-row pass is NOT counted as a batch.
    expect(stats.rowsDeleted).toBe(2500);
    expect(stats.batches).toBe(3);

    // Sanity: the 500 recent rows are intact.
    const db = openDb(active.dbPath);
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM events')
      .get() as { c: number };
    expect(remaining.c).toBe(500);
  });

  test('does not touch the sessions table', async () => {
    active = await mkTmp();

    const now = 10 * 24 * 60 * 60 * 1000;
    const oldAt = now - 30 * 24 * 60 * 60 * 1000;

    seedEvents(active.dbPath, 'sess-stale', 50, oldAt);

    // Confirm the session row exists pre-compact.
    const db = openDb(active.dbPath);
    const before = db
      .prepare('SELECT COUNT(*) AS c FROM sessions')
      .get() as { c: number };
    expect(before.c).toBe(1);

    await compactOnce({ maxAgeDays: 7, batchSize: 100, nowMs: now });

    const after = db
      .prepare('SELECT COUNT(*) AS c FROM sessions')
      .get() as { c: number };
    expect(after.c).toBe(1);
    // And events for that session were all dropped.
    const evCount = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_key = ?')
      .get('sess-stale') as { c: number };
    expect(evCount.c).toBe(0);
  });

  test('zero-event DB: returns rowsDeleted=0 batches=0', async () => {
    active = await mkTmp();
    openDb(active.dbPath); // create the schema, no seed
    const stats = await compactOnce({ maxAgeDays: 7, nowMs: Date.now() });
    expect(stats.rowsDeleted).toBe(0);
    expect(stats.batches).toBe(0);
  });

  test('all events recent: nothing deleted', async () => {
    active = await mkTmp();
    const now = 100_000_000_000;
    seedEvents(active.dbPath, 'sess-recent', 1000, now - 60_000); // 1 min ago

    const stats = await compactOnce({ maxAgeDays: 7, batchSize: 100, nowMs: now });
    expect(stats.rowsDeleted).toBe(0);
    expect(stats.batches).toBe(0);

    const db = openDb(active.dbPath);
    const c = db
      .prepare('SELECT COUNT(*) AS c FROM events')
      .get() as { c: number };
    expect(c.c).toBe(1000);
  });
});

// Silences the unused-import warning. fs is used for the tmp setup elsewhere.
void fs;
