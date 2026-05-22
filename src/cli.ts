// CLI entrypoint. Three subcommands in M1:
//   doctor        - inspect DB + spool, useful for verifying install
//   tui           - stub
//   install-hooks - stub
//
// We parse argv by hand to keep the dependency surface zero. Flags are
// "--name=value" or "--name value"; positional args are everything else.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PATHS } from './paths.ts';
import { closeDb, db, openDb } from './store/db.ts';
import {
  getKnownSourcePaths,
  getMaxOffsetForPath,
  getSessionStateCounts,
} from './store/queries.ts';
import { runInstallHooks } from './cli-install.ts';
import { runReconcileOnce } from './reconciler/index.ts';
import { compactOnce } from './retention.ts';
import { rotateSpoolOnce } from './spool-rotation.ts';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function listSpoolFilesWithCounts(
  root: string,
): Promise<{ file: string; lines: number }[]> {
  const out: { file: string; lines: number }[] = [];
  if (!fs.existsSync(root)) return out;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const buf = await fsp.readFile(full);
        // Lines = newline count, plus one if there's trailing content.
        let lines = 0;
        for (const b of buf) if (b === 0x0a) lines++;
        if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++;
        out.push({ file: full, lines });
      }
    }
  }
  await walk(root, 0);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

// Walk a rollout root (claude or codex), report file size and how many bytes
// the indexer is genuinely behind. The DB stores the START offset of the last
// ingested record; to report "0 caught up" honestly we read forward from that
// offset to find the record's terminating '\n', then subtract.
async function computeBehindBytes(
  file: string,
  known: number | null,
  size: number,
): Promise<number> {
  if (known == null) return size;
  if (known >= size) return 0;
  // Single record almost always fits in 64KB; payload caps + typical rollout
  // record sizes confirm. If it doesn't, fall back to the start-offset metric.
  const window = Math.min(65536, size - known);
  let fd;
  try {
    fd = await fsp.open(file, 'r');
    const buf = Buffer.alloc(window);
    const { bytesRead } = await fd.read(buf, 0, window, known);
    const nlIdx = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (nlIdx === -1) return Math.max(0, size - known);
    const recordEnd = known + nlIdx + 1;
    return Math.max(0, size - recordEnd);
  } catch {
    return Math.max(0, size - known);
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

async function listRolloutFilesWithBehind(
  root: string,
): Promise<{ file: string; size: number; behindBytes: number }[]> {
  const out: { file: string; size: number; behindBytes: number }[] = [];
  if (!fs.existsSync(root)) return out;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          continue;
        }
        const known = getMaxOffsetForPath(full);
        const behind = await computeBehindBytes(full, known, size);
        out.push({ file: full, size, behindBytes: behind });
      }
    }
  }
  await walk(root, 0);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

// Look up whether our hook scripts are referenced from a settings file.
// We don't validate every aspect of the install -- just count how many of
// the registered events point at our hook command path. Returns null if the
// settings file is missing OR malformed (caller surfaces as "not installed").
function countOurHooksInJson(settingsPath: string): number | null {
  if (!fs.existsSync(settingsPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return null;
  }
  if (raw.trim() === '') return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;

  const hooksDir = PATHS.hooks;
  let count = 0;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const handlers = (g as { hooks?: unknown }).hooks;
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (
          h &&
          typeof h === 'object' &&
          (h as { type?: unknown }).type === 'command' &&
          typeof (h as { command?: unknown }).command === 'string' &&
          ((h as { command: string }).command.includes(hooksDir))
        ) {
          count++;
        }
      }
    }
  }
  return count;
}

// Compute total unread spool lines and oldest-unread-file age (seconds).
// "Unread" = file has more bytes after the indexer's last known offset.
async function spoolBacklogSummary(
  spoolRoot: string,
): Promise<{ unreadLines: number; oldestAgeSec: number; oldestPath: string | null }> {
  let unreadLines = 0;
  let oldestAgeSec = 0;
  let oldestPath: string | null = null;
  if (!fs.existsSync(spoolRoot)) {
    return { unreadLines, oldestAgeSec, oldestPath };
  }
  const stack: string[] = [spoolRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        const known = getMaxOffsetForPath(full);
        if (known == null) {
          // Whole file is unread.
          const buf = await fsp.readFile(full);
          let lines = 0;
          for (const b of buf) if (b === 0x0a) lines++;
          unreadLines += lines;
          if (lines > 0) {
            const age = Math.round((Date.now() - stat.mtimeMs) / 1000);
            if (age > oldestAgeSec) {
              oldestAgeSec = age;
              oldestPath = full;
            }
          }
        } else if (stat.size > known) {
          // Partial unread tail. Count newlines in that suffix.
          const fd = await fsp.open(full, 'r');
          try {
            const length = stat.size - known;
            const buf = Buffer.alloc(length);
            await fd.read(buf, 0, length, known);
            let lines = 0;
            for (const b of buf) if (b === 0x0a) lines++;
            if (lines > 0) {
              unreadLines += lines;
              const age = Math.round((Date.now() - stat.mtimeMs) / 1000);
              if (age > oldestAgeSec) {
                oldestAgeSec = age;
                oldestPath = full;
              }
            }
          } finally {
            await fd.close();
          }
        }
      }
    }
  }
  return { unreadLines, oldestAgeSec, oldestPath };
}

async function cmdDoctor(): Promise<number> {
  console.log('agent-monitor doctor');
  console.log('====================');
  console.log(`db:    ${PATHS.db}`);
  console.log(`spool: ${PATHS.spool}`);
  console.log('');

  // Open / create DB so subsequent reads work even on a fresh install.
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  openDb(PATHS.db);

  // M6: hook install status. Read each provider's settings file and count how
  // many of the registered hook handlers point at our hook scripts directory.
  // null means "settings file missing or unreadable" -> not installed.
  const claudeCount = countOurHooksInJson(PATHS.claudeSettings);
  const codexCount = countOurHooksInJson(PATHS.codexHooks);
  const agyCount = countOurHooksInJson(PATHS.agyHooks);
  console.log('hooks:');
  console.log(
    `  claude: ${
      claudeCount == null
        ? 'not installed'
        : claudeCount > 0
          ? `installed (${claudeCount} events)`
          : 'settings present but no entries pointing at our scripts'
    }`,
  );
  console.log(
    `  codex:  ${
      codexCount == null
        ? 'not installed'
        : codexCount > 0
          ? `installed (${codexCount} events)`
          : 'settings present but no entries pointing at our scripts'
    }`,
  );
  console.log(
    `  agy:    ${
      agyCount == null
        ? 'not installed'
        : agyCount > 0
          ? `installed (${agyCount} events)`
          : 'settings present but no entries pointing at our scripts'
    }`,
  );
  console.log('');

  const counts = getSessionStateCounts();
  if (counts.length === 0) {
    console.log('sessions: (none)');
  } else {
    console.log('sessions by state:');
    for (const c of counts) {
      console.log(`  ${c.state.padEnd(10)} ${c.count}`);
    }
  }
  console.log('');

  // M6: events table summary -- last event wall-clock + count by provider.
  // Both are tiny aggregate queries; safe to run inline.
  const handle = db();
  const lastRow = handle
    .prepare('SELECT MAX(observed_at_ms) AS m FROM events')
    .get() as { m: number | null } | undefined;
  const lastMs = lastRow?.m ?? null;
  const provCounts = handle
    .prepare(
      'SELECT s.provider AS p, COUNT(e.id) AS c FROM events e JOIN sessions s ON e.session_key = s.key GROUP BY s.provider ORDER BY s.provider',
    )
    .all() as { p: string; c: number }[];
  console.log('events:');
  if (lastMs == null) {
    console.log('  last event: (none)');
  } else {
    const ageSec = Math.max(0, Math.round((Date.now() - lastMs) / 1000));
    console.log(`  last event: ${new Date(lastMs).toISOString()} (${ageSec}s ago)`);
  }
  if (provCounts.length === 0) {
    console.log('  by provider: (none)');
  } else {
    console.log('  by provider:');
    for (const r of provCounts) console.log(`    ${r.p.padEnd(8)} ${r.c}`);
  }
  console.log('');

  // M6: spool backlog -- total unread lines and oldest unread file age.
  const backlog = await spoolBacklogSummary(PATHS.spool);
  console.log('spool backlog:');
  console.log(`  unread lines: ${backlog.unreadLines}`);
  if (backlog.oldestPath) {
    console.log(`  oldest unread: ${backlog.oldestAgeSec}s ago  ${backlog.oldestPath}`);
  } else {
    console.log('  oldest unread: (none)');
  }
  console.log('');

  const knownPaths = new Set(getKnownSourcePaths());
  const spoolFiles = await listSpoolFilesWithCounts(PATHS.spool);

  if (spoolFiles.length === 0) {
    console.log('spool files: (none)');
  } else {
    console.log('spool files:');
    for (const f of spoolFiles) {
      const seen = knownPaths.has(f.file) ? 'ingested' : 'new';
      console.log(`  [${seen.padEnd(8)}] ${f.lines.toString().padStart(5)} lines  ${f.file}`);
    }
  }

  // Rollout files (Claude + Codex). Surfaces the providers' own transcript
  // logs -- the M4 reconciler ingests them into the same events.db.
  for (const [label, root] of [
    ['claude rollouts', PATHS.claudeProjects],
    ['codex rollouts', PATHS.codexSessions],
  ] as const) {
    const files = await listRolloutFilesWithBehind(root);
    console.log('');
    if (files.length === 0) {
      console.log(`${label}: (none at ${root})`);
      continue;
    }
    let totalBehind = 0;
    let caughtUp = 0;
    for (const f of files) {
      totalBehind += f.behindBytes;
      if (f.behindBytes === 0) caughtUp++;
    }
    console.log(
      `${label}: ${files.length} files, ${caughtUp} caught up, ${totalBehind} bytes behind total`,
    );
    // Only list the laggards by default -- otherwise the doctor output is
    // overwhelming on long-running setups. Files with 0 bytes-behind are
    // accounted for in the summary line.
    const laggards = files.filter((f) => f.behindBytes > 0).slice(0, 20);
    for (const f of laggards) {
      const seen = knownPaths.has(f.file) ? 'partial' : 'new';
      console.log(
        `  [${seen.padEnd(8)}] behind ${f.behindBytes.toString().padStart(8)} / ${f.size
          .toString()
          .padStart(8)} bytes  ${f.file}`,
      );
    }
    if (files.filter((f) => f.behindBytes > 0).length > laggards.length) {
      console.log(
        `  ... and ${files.filter((f) => f.behindBytes > 0).length - laggards.length} more`,
      );
    }
  }

  // Surface paths the DB knows about but that no longer exist on disk -- a
  // mild warning surface, not a hard failure.
  const missing: string[] = [];
  for (const p of knownPaths) if (!fs.existsSync(p)) missing.push(p);
  if (missing.length > 0) {
    console.log('');
    console.log('source paths in DB no longer on disk:');
    for (const p of missing) console.log(`  ${p}`);
  }

  return 0;
}

async function cmdReconcile(): Promise<number> {
  // One-pass scan over Claude + Codex rollouts. Writes to PATHS.db.
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  openDb(PATHS.db);
  const stats = await runReconcileOnce();
  console.log(
    `reconcile: ${stats.filesScanned} files, ${stats.linesIngested} ingested, ${stats.linesSkipped} skipped`,
  );
  return 0;
}

async function cmdCompact(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const days = args.flags['days'];
  const batch = args.flags['batch'];
  const maxAgeDays = typeof days === 'string' ? parseInt(days, 10) : 7;
  const batchSize = typeof batch === 'string' ? parseInt(batch, 10) : 1000;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error('compact: --days must be a positive integer');
    return 2;
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    console.error('compact: --batch must be a positive integer');
    return 2;
  }
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  openDb(PATHS.db);
  const stats = await compactOnce({ maxAgeDays, batchSize });
  console.log(
    `compact: rowsDeleted=${stats.rowsDeleted}, batches=${stats.batches}, durationMs=${stats.durationMs} (cutoff=${maxAgeDays}d, batchSize=${batchSize})`,
  );
  return 0;
}

async function cmdRotateSpool(rest: string[]): Promise<number> {
  const args = parseArgs(rest);
  const dryRun = args.flags['dry-run'] === true || args.flags['dry-run'] === 'true';
  const days = args.flags['days'];
  const minAgeDays = typeof days === 'string' ? parseInt(days, 10) : 3;
  if (!Number.isFinite(minAgeDays) || minAgeDays <= 0) {
    console.error('rotate-spool: --days must be a positive integer');
    return 2;
  }
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  openDb(PATHS.db);
  const stats = await rotateSpoolOnce({ minAgeDays, dryRun });
  console.log(
    `rotate-spool: deleted=${stats.filesDeleted}, kept=${stats.filesKept} (cutoff=${minAgeDays}d${dryRun ? ', dry-run' : ''})`,
  );
  console.log('reasons:');
  for (const [reason, count] of Object.entries(stats.reasons)) {
    if (count > 0) console.log(`  ${reason.padEnd(28)} ${count}`);
  }
  return 0;
}

async function cmdTui(): Promise<number> {
  // Open DB first so the TUI's poll path works on tick 0. Use a dynamic import
  // for the Ink app to keep the cold-start cost (React + ink + ink-spinner) off
  // the doctor / reconcile code paths.
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  const db = openDb(PATHS.db);
  const { runTui } = await import('./tui/App.tsx');
  try {
    await runTui(db);
  } finally {
    // Strict cleanup order from M0_SPIKE_NOTES.md gotcha #6:
    //   ink waitUntilExit (already awaited inside runTui) → db.close() → exit.
    closeDb();
  }
  return 0;
}

async function cmdInstallHooks(rest: string[]): Promise<number> {
  return await runInstallHooks(rest);
}

function usage(): void {
  console.log('usage: agent-monitor <command>');
  console.log('');
  console.log('commands:');
  console.log('  doctor                     inspect DB and spool state');
  console.log('  tui                        open the dashboard');
  console.log('  install-hooks              register hooks with Claude/Codex');
  console.log('  reconcile                  one-pass ingest of rollout JSONL into events.db');
  console.log('  compact [--days N] [--batch N]');
  console.log('                             drop events older than N days (default 7) in batches');
  console.log('  rotate-spool [--days N] [--dry-run]');
  console.log('                             delete fully-ingested spool files older than N days (default 3)');
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'doctor':
      return await cmdDoctor();
    case 'tui':
      return await cmdTui();
    case 'install-hooks':
      return await cmdInstallHooks(rest);
    case 'reconcile':
      return await cmdReconcile();
    case 'compact':
      return await cmdCompact(rest);
    case 'rotate-spool':
      return await cmdRotateSpool(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      return 2;
  }
}

// When run directly (bun run src/cli.ts ...), execute. When imported (e.g. by
// the bin script wrapper), the caller invokes main() themselves.
// Bun sets `import.meta.main = true` on the entrypoint module.
if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
