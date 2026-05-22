// Spool tailer. Discovers per-session spool files under
//   <PATHS.spool>/<provider>/<session_hash>/YYYYMMDD.jsonl
// resumes each file by byte offset (looked up from `events`), parses one
// HookEnvelope per line, runs it through the reducer, and persists.
//
// The indexer is the only writer to events.db; everything else only reads.
//
// Watch mode uses chokidar; one-shot mode (used by `doctor`, tests, and the
// initial startup pass) just walks the tree and drains.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import { PATHS } from '../paths.ts';
import { reduce } from './reducer.ts';
import {
  getMaxOffsetForPath,
  insertEvent,
  upsertSession,
} from '../store/queries.ts';
import { openDb } from '../store/db.ts';
import type { HookEnvelope } from '../types.ts';

export interface SpoolOptions {
  // Override spool root (tests). Defaults to PATHS.spool.
  spoolRoot?: string;
  // Override DB path (tests). Defaults to PATHS.db.
  dbPath?: string;
  // Logger. Defaults to console.
  log?: (msg: string) => void;
}

export interface DrainStats {
  filesScanned: number;
  linesIngested: number;
  linesSkipped: number; // dedup or unrecognized
}

// Walk spool root, return the absolute path of every .jsonl file. The hook
// layout is <root>/<provider>/<session_hash>/<date>.jsonl, so a 3-level walk
// is enough -- but we glob defensively in case future shapes appear.
async function listSpoolFiles(spoolRoot: string): Promise<string[]> {
  if (!fs.existsSync(spoolRoot)) return [];
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return; // bounded; protects against accidental loops
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  await walk(spoolRoot, 0);
  return out.sort();
}

// Drain a single file from `startOffset` to EOF. Returns the new offset
// (== file size after read). One line = one HookEnvelope. Partial last lines
// (no trailing newline) are NOT consumed -- we leave them for the next pass
// once the writer flushes the newline. Otherwise we'd ingest half-records.
async function drainFile(
  filePath: string,
  startOffset: number,
  log: (m: string) => void,
): Promise<{ newOffset: number; ingested: number; skipped: number }> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { newOffset: startOffset, ingested: 0, skipped: 0 };
  }
  if (stat.size <= startOffset) {
    return { newOffset: startOffset, ingested: 0, skipped: 0 };
  }

  // Read the whole tail into memory. Per-session spool files are bounded
  // (<10MB/day expected); we don't need streaming yet.
  const fd = await fsp.open(filePath, 'r');
  let buf: Buffer;
  try {
    const length = stat.size - startOffset;
    buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, startOffset);
  } finally {
    await fd.close();
  }

  let ingested = 0;
  let skipped = 0;
  let cursor = 0; // offset within `buf`
  let newOffset = startOffset;

  while (cursor < buf.length) {
    const nl = buf.indexOf(0x0a, cursor); // '\n'
    if (nl === -1) break; // partial line, leave for next pass
    const lineStart = cursor;
    const lineEnd = nl; // exclusive end (the newline itself is delimiter)
    const recordOffsetInFile = startOffset + lineStart;

    const lineBytes = buf.subarray(lineStart, lineEnd);
    cursor = nl + 1;
    newOffset = startOffset + cursor;

    const trimmed = lineBytes.toString('utf8').trim();
    if (trimmed.length === 0) {
      skipped++;
      continue;
    }

    let env: HookEnvelope;
    try {
      env = JSON.parse(trimmed) as HookEnvelope;
    } catch {
      log(`spool: malformed JSON in ${filePath} @ ${recordOffsetInFile}`);
      skipped++;
      continue;
    }

    // Dedup: if we already ingested this exact (path, offset), skip. This
    // matters during startup when the offset cursor could overlap due to a
    // crash between insertEvent and... well, actually we resume by offset so
    // overlap shouldn't happen, but the unique-ish dedup index is cheap.
    const existingMax = getMaxOffsetForPath(filePath);
    if (existingMax != null && recordOffsetInFile <= existingMax) {
      skipped++;
      continue;
    }

    const reduced = reduce(env, filePath, recordOffsetInFile, { source: 'hook' });
    if (!reduced) {
      // Unrecognized hook event -- drop, but advance the offset so we don't
      // re-parse it next pass.
      skipped++;
      continue;
    }

    // Sessions row first (FK target), then event.
    upsertSession(reduced.sessionPatch);
    insertEvent(reduced.event);
    ingested++;
  }

  return { newOffset, ingested, skipped };
}

// One-shot drain: scan every spool file once, ingest new bytes, return.
// Used by tests, by `doctor`, and as the startup pass for watch mode.
export async function drainOnce(opts: SpoolOptions = {}): Promise<DrainStats> {
  const spoolRoot = opts.spoolRoot ?? PATHS.spool;
  const log = opts.log ?? ((m: string) => console.error(m));
  if (opts.dbPath) openDb(opts.dbPath);
  else openDb();

  const files = await listSpoolFiles(spoolRoot);
  let linesIngested = 0;
  let linesSkipped = 0;
  for (const f of files) {
    const known = getMaxOffsetForPath(f);
    // Resume from byte AFTER the last known record. Records were written
    // line-terminated, so the next record starts at known_offset + length_of_line.
    // We don't store the length, so the simplest correct thing: re-read from
    // known_offset and let drainFile's per-record dedup discard the duplicate.
    // For the very common no-known case, start at 0.
    const start = known ?? 0;
    const r = await drainFile(f, start, log);
    linesIngested += r.ingested;
    linesSkipped += r.skipped;
  }
  return { filesScanned: files.length, linesIngested, linesSkipped };
}

// Watch mode: drain once on startup, then watch for changes.
// Returns the chokidar watcher so the caller can `.close()` on shutdown.
export async function watch(opts: SpoolOptions = {}): Promise<FSWatcher> {
  const spoolRoot = opts.spoolRoot ?? PATHS.spool;
  const log = opts.log ?? ((m: string) => console.error(m));
  fs.mkdirSync(spoolRoot, { recursive: true });

  // Initial drain so anything written while the indexer was down is caught.
  await drainOnce(opts);

  const watcher = chokidar.watch(spoolRoot, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
    depth: 4,
  });

  // Coalesce per-file: if a file fires two `change` events back-to-back,
  // we still only run drainFile once (it's idempotent re: max offset).
  const drain = async (file: string) => {
    if (!file.endsWith('.jsonl')) return;
    const known = getMaxOffsetForPath(file);
    const start = known ?? 0;
    try {
      await drainFile(file, start, log);
    } catch (e) {
      log(`spool: drainFile error ${file}: ${(e as Error).message}`);
    }
  };

  watcher.on('add', drain);
  watcher.on('change', drain);

  return watcher;
}
