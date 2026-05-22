// SQLite handle for events.db. Opens once, applies schema idempotently,
// caches prepared statements. Only the indexer writes; readers (TUI, doctor)
// share the same handle for simplicity in v1.

import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.ts';

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url).pathname;

let _db: Database | null = null;
let _dbPath: string | null = null;

// Statement cache, lazily populated by queries.ts.
const stmtCache = new Map<string, Statement>();

function loadSchema(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

// Open (or return cached) DB. PATHS.db is the default; tests may pass their own.
export function openDb(dbPath: string = PATHS.db): Database {
  if (_db && _dbPath === dbPath) return _db;
  if (_db) {
    // Path changed (test scenario). Drop the old handle.
    _db.close();
    _db = null;
    stmtCache.clear();
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec(loadSchema());
  // Brief busy_timeout so a competing writer (another agent-monitor TUI mid
  // writer-handoff, or our own retention pass) doesn't immediately fail with
  // SQLITE_BUSY. The single-writer election in writer-lock.ts is the real
  // arbiter; this is defense in depth.
  try {
    db.exec('PRAGMA busy_timeout = 1000');
  } catch {
    // PRAGMA may fail on read-only DBs; non-fatal.
  }
  applyMigrations(db);
  _db = db;
  _dbPath = dbPath;
  return db;
}

// Idempotent migrations for columns added after the initial schema. Plain
// `CREATE TABLE IF NOT EXISTS` does not back-fill new columns onto an existing
// table, so we do an explicit PRAGMA + ALTER TABLE per added column.
function applyMigrations(database: Database): void {
  const cols = database
    .prepare('PRAGMA table_info(sessions)')
    .all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('observed_parent_pid')) {
    database.exec('ALTER TABLE sessions ADD COLUMN observed_parent_pid INTEGER');
  }
  if (!have.has('observed_parent_starttime')) {
    database.exec('ALTER TABLE sessions ADD COLUMN observed_parent_starttime INTEGER');
  }
  if (!have.has('origin')) {
    database.exec('ALTER TABLE sessions ADD COLUMN origin TEXT');
  }
  if (!have.has('context_tokens_used')) {
    database.exec('ALTER TABLE sessions ADD COLUMN context_tokens_used INTEGER');
  }
  if (!have.has('context_tokens_max')) {
    database.exec('ALTER TABLE sessions ADD COLUMN context_tokens_max INTEGER');
  }
  if (!have.has('context_source')) {
    database.exec('ALTER TABLE sessions ADD COLUMN context_source TEXT');
  }
}

// Default lazy accessor. If we already have a handle (from a previous
// openDb(...) call -- the indexer / cli / tests do this on entry), return it.
// Otherwise open the default PATHS.db. This avoids accidentally swapping the
// active handle every time a query runs.
export function db(): Database {
  if (_db) return _db;
  return openDb();
}

// Cached prepare; queries.ts uses this exclusively so we don't re-parse SQL.
// Generic order matches bun:sqlite's Statement<ReturnType, ParamsType[]>.
export function prepare<R = unknown, P extends SQLQueryBindings[] = SQLQueryBindings[]>(
  sql: string,
): Statement<R, P> {
  const cached = stmtCache.get(sql);
  if (cached) return cached as unknown as Statement<R, P>;
  const stmt = db().prepare(sql) as unknown as Statement<R, P>;
  stmtCache.set(sql, stmt as unknown as Statement);
  return stmt;
}

// For tests: close handle and clear caches so the next openDb starts fresh.
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
    stmtCache.clear();
  }
}
