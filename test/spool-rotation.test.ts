// spool-rotation.test.ts -- exhaustive coverage of the conservative delete
// rules. Each scenario builds a synthetic spool dir + isolated DB, then runs
// rotateSpoolOnce and asserts which files remained on disk.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { rotateSpoolOnce } from '../src/spool-rotation.ts';
import { closeDb, openDb } from '../src/store/db.ts';

interface Tmp {
  root: string;
  spool: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}

async function mkTmp(): Promise<Tmp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-rotate-'));
  const spool = path.join(root, 'spool');
  fs.mkdirSync(spool, { recursive: true });
  const dbPath = path.join(root, 'events.db');
  return {
    root,
    spool,
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

// Insert N events into a synthetic session for source_path. The events table
// is the dedup-by-(source_path, source_offset) source of truth that
// rotateSpoolOnce consults.
function seedEvents(
  dbPath: string,
  sourcePath: string,
  offsets: number[],
): void {
  const db = openDb(dbPath);
  db.prepare(
    `INSERT OR IGNORE INTO sessions (
      key, provider, session_id, transcript_path, cwd, model, cli_version,
      pid, process_start_unix, started_at_ms, last_event_at_ms,
      prior_state, state, current_tool, last_prompt, observed_parent_pid,
      observed_parent_starttime
    ) VALUES (?, 'claude', 'sid', NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 'thinking', NULL, NULL, NULL, NULL)`,
  ).run('sk');
  const insert = db.prepare(
    `INSERT INTO events (session_key, observed_at_ms, provider_ts, source, source_path, source_offset, kind, payload_json)
     VALUES ('sk', 0, NULL, 'hook', ?, ?, 'user_prompt', NULL)`,
  );
  db.exec('BEGIN');
  for (const off of offsets) insert.run(sourcePath, off);
  db.exec('COMMIT');
}

// Backdate a file's mtime/ctime so it's older than the rotation cutoff.
function setOldTimes(filePath: string, daysAgo: number): void {
  const past = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(filePath, past, past);
}

describe('rotateSpoolOnce', () => {
  test('deletes a complete, fully-ingested, sufficiently-old file', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'sess', '20250101.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'line1\nline2\nline3\n'); // 3 newline-terminated lines
    setOldTimes(file, 5);

    // 3 events at the line offsets so eventCount >= lineCount.
    const offsets = [0, 6, 12];
    seedEvents(active.dbPath, file, offsets);

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
    });
    expect(stats.filesDeleted).toBe(1);
    expect(stats.filesKept).toBe(0);
    expect(stats.reasons.deleted).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('keeps file with partial trailing line (no final newline)', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'sess', '20250101.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Two complete lines, then an unterminated trailing chunk.
    fs.writeFileSync(file, 'line1\nline2\npartial');
    setOldTimes(file, 5);
    seedEvents(active.dbPath, file, [0, 6]); // not enough offsets, but won't be reached

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
    });
    expect(stats.filesDeleted).toBe(0);
    expect(stats.filesKept).toBe(1);
    expect(stats.reasons['kept-partial-line']).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('keeps a never-ingested file (no events for source_path)', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'codex', 'sess', '20250101.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a\nb\n');
    setOldTimes(file, 5);
    // DB exists (we openDb implicitly via rotateSpoolOnce -> getMaxOffsetForPath)
    // but no events row references this path.
    openDb(active.dbPath);

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
    });
    expect(stats.filesDeleted).toBe(0);
    expect(stats.filesKept).toBe(1);
    expect(stats.reasons['kept-no-events']).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('keeps a too-young file even if otherwise eligible', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'sess', '20260425.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a\n');
    // Don't backdate -- file is "today".
    seedEvents(active.dbPath, file, [0]);

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
    });
    expect(stats.filesDeleted).toBe(0);
    expect(stats.filesKept).toBe(1);
    expect(stats.reasons['kept-too-young']).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('keeps file when event count is less than line count', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'sess', '20250101.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a\nb\nc\n'); // 3 lines
    setOldTimes(file, 5);
    seedEvents(active.dbPath, file, [0, 2]); // only 2 events

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
    });
    expect(stats.filesDeleted).toBe(0);
    expect(stats.filesKept).toBe(1);
    expect(stats.reasons['kept-line-count-mismatch']).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('dry-run: deletes nothing, but reports what it would have deleted', async () => {
    active = await mkTmp();
    const file = path.join(active.spool, 'claude', 'sess', '20250101.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a\nb\n');
    setOldTimes(file, 5);
    seedEvents(active.dbPath, file, [0, 2]);

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
      dryRun: true,
    });
    // Reported as deleted -- but on disk, it survives.
    expect(stats.filesDeleted).toBe(1);
    expect(stats.reasons.deleted).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('handles many files at once with mixed outcomes', async () => {
    active = await mkTmp();

    const fOk = path.join(active.spool, 'claude', 'a', 'old.jsonl');
    const fPartial = path.join(active.spool, 'claude', 'b', 'old.jsonl');
    const fUnknown = path.join(active.spool, 'codex', 'c', 'old.jsonl');
    const fYoung = path.join(active.spool, 'codex', 'd', 'today.jsonl');

    for (const f of [fOk, fPartial, fUnknown, fYoung]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
    }
    fs.writeFileSync(fOk, 'x\ny\n');
    fs.writeFileSync(fPartial, 'x\ny');
    fs.writeFileSync(fUnknown, 'x\n');
    fs.writeFileSync(fYoung, 'x\n');

    setOldTimes(fOk, 5);
    setOldTimes(fPartial, 5);
    setOldTimes(fUnknown, 5);
    // fYoung stays today.

    seedEvents(active.dbPath, fOk, [0, 2]);
    seedEvents(active.dbPath, fYoung, [0]);
    // fUnknown intentionally not seeded; fPartial seeded incompletely is not
    // relevant since the partial-line check fires first.

    const stats = await rotateSpoolOnce({
      spoolRoot: active.spool,
      minAgeDays: 3,
    });

    expect(fs.existsSync(fOk)).toBe(false);
    expect(fs.existsSync(fPartial)).toBe(true);
    expect(fs.existsSync(fUnknown)).toBe(true);
    expect(fs.existsSync(fYoung)).toBe(true);

    expect(stats.filesDeleted).toBe(1);
    expect(stats.filesKept).toBe(3);
    expect(stats.reasons.deleted).toBe(1);
    expect(stats.reasons['kept-partial-line']).toBe(1);
    expect(stats.reasons['kept-no-events']).toBe(1);
    expect(stats.reasons['kept-too-young']).toBe(1);
  });
});
