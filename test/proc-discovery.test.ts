import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverProcSessionsOnce } from '../src/indexer/proc-discovery.ts';
import { closeDb, openDb } from '../src/store/db.ts';
import { upsertSession } from '../src/store/queries.ts';

interface Tmp {
  root: string;
  proc: string;
  db: string;
}

let active: Tmp | null = null;

afterEach(async () => {
  closeDb();
  if (active) {
    await fsp.rm(active.root, { recursive: true, force: true });
    active = null;
  }
});

async function mkTmp(): Promise<Tmp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-proc-'));
  const proc = path.join(root, 'proc');
  const db = path.join(root, 'events.db');
  fs.mkdirSync(proc, { recursive: true });
  active = { root, proc, db };
  openDb(db);
  return active;
}

function statLine(pid: string, comm: string, starttime: number): string {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[0] = 'S';
  fields[19] = String(starttime);
  return `${pid} (${comm}) ${fields.join(' ')}`;
}

function proc(
  procRoot: string,
  pid: string,
  opts: { comm: string; starttime: number; cmdline?: string[]; cwd: string },
): void {
  const dir = path.join(procRoot, pid);
  fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'comm'), opts.comm);
  fs.writeFileSync(path.join(dir, 'stat'), statLine(pid, opts.comm, opts.starttime));
  fs.writeFileSync(path.join(dir, 'cmdline'), (opts.cmdline ?? [opts.comm]).join('\0'));
  fs.symlinkSync(opts.cwd, path.join(dir, 'cwd'));
  fs.symlinkSync('/dev/pts/7', path.join(dir, 'fd', '0'));
}

describe('discoverProcSessionsOnce', () => {
  test('creates a proc placeholder for an interactive claude process', async () => {
    const t = await mkTmp();
    proc(t.proc, '123', {
      comm: 'claude',
      starttime: 456,
      cmdline: ['claude', '--model', 'opus'],
      cwd: '/repo',
    });

    const stats = await discoverProcSessionsOnce(10_000, t.proc);
    expect(stats.placeholdersUpserted).toBe(1);

    const rows = openDb(t.db)
      .query<{ provider: string; session_id: string; cwd: string; model: string; origin: string }, []>(
        'SELECT provider, session_id, cwd, model, origin FROM sessions',
      )
      .all();
    expect(rows).toEqual([
      {
        provider: 'claude',
        session_id: 'proc-123-456',
        cwd: '/repo',
        model: 'opus',
        origin: 'proc',
      },
    ]);
  });

  test('retires proc placeholder when a real session exists for the same parent', async () => {
    const t = await mkTmp();
    proc(t.proc, '123', {
      comm: 'node',
      starttime: 456,
      cmdline: ['/usr/bin/node', '/usr/local/bin/agy'],
      cwd: '/repo',
    });

    await discoverProcSessionsOnce(10_000, t.proc);
    upsertSession({
      key: 'agy:real-session',
      provider: 'agy',
      session_id: 'real-session',
      observed_at_ms: 11_000,
      state: 'waiting',
      cwd: '/repo',
      observed_parent_pid: 123,
      observed_parent_starttime: 456,
    });

    const stats = await discoverProcSessionsOnce(12_000, t.proc);
    expect(stats.placeholdersRetired).toBe(1);

    const rows = openDb(t.db)
      .query<{ session_id: string; state: string }, []>(
        'SELECT session_id, state FROM sessions ORDER BY session_id',
      )
      .all();
    expect(rows).toEqual([
      { session_id: 'proc-123-456', state: 'done' },
      { session_id: 'real-session', state: 'waiting' },
    ]);
  });

  test('deduplicates multiple helper processes with the same provider and cwd', async () => {
    const t = await mkTmp();
    proc(t.proc, '296', {
      comm: 'codex',
      starttime: 100,
      cwd: '/repo',
    });
    proc(t.proc, '297', {
      comm: 'node',
      cmdline: ['/usr/bin/node', '/usr/local/bin/codex'],
      starttime: 101,
      cwd: '/repo',
    });
    proc(t.proc, '372', {
      comm: 'codex',
      starttime: 102,
      cwd: '/repo',
    });

    const stats = await discoverProcSessionsOnce(10_000, t.proc);
    expect(stats.placeholdersUpserted).toBe(1);

    const rows = openDb(t.db)
      .query<{ session_id: string; state: string }, []>(
        "SELECT session_id, state FROM sessions WHERE provider = 'codex'",
      )
      .all();
    expect(rows).toEqual([{ session_id: 'proc-296-100', state: 'waiting' }]);
  });
});
