// State-age driven liveness override (M6).
//
// The DB's `state` column is set at event-ingest time by the state machine and
// stays as that lifecycle value (`thinking` / `tool` / `waiting` / `permission`
// / `done` / `recovered`). At read time, the TUI overlays this with an
// "is this still alive?" judgement based on how stale `last_event_at_ms` is.
//
// We deliberately never return `dead` in v1 -- per plan M6, hook payloads do
// not carry the agent's PID, so we can't trust process liveness. False-dead
// on a quietly-waiting session is worse than conservative `stale`.
//
// Pure function. Inputs are SessionRow + a wall clock; output is the display
// state to show in the grid. Same row at different times can return different
// states, which is the whole point.

import { readdirSync, readlinkSync, readFileSync } from 'node:fs';
import type { SessionRow, SessionState } from './types.ts';

interface LivenessFs {
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  readlinkSync: typeof readlinkSync;
}

let fsImpl: LivenessFs = { readdirSync, readFileSync, readlinkSync };

export function setLivenessFsForTests(fs: LivenessFs | null): void {
  fsImpl = fs ?? { readdirSync, readFileSync, readlinkSync };
  resetAliveCacheForTests();
}

// Authoritative session-end check for Claude.
//
// Claude Code creates `~/.claude/tasks/<session_id>/.lock` *lazily* — empirically
// only on the first TodoWrite. SessionStart fires through the hook well before
// (~minute) the lock file is born, so for fresh sessions the lock fd is not yet
// open and a /proc/fd scan can't prove liveness. We compensate with the
// fresh-event grace in `applyLiveness` below: recent hook events are stronger
// evidence the agent is alive than the absence of a not-yet-created lock fd.
// Once the lock exists, a live `claude` process holds it open as a file
// descriptor and we detect it by walking /proc/<pid>/fd and matching readlinks.
//
// We cache the result of the scan for ALIVE_CACHE_MS so 88 cells * 5 ticks/sec
// don't hammer /proc. The scan itself is bounded to PIDs whose /proc/<pid>/comm
// is "claude".
//
// Codex has lock files too, but its lock dir name is randomized
// (~/.codex/tmp/arg0/codex-arg0<random>/.lock) and doesn't carry session_id,
// so we can't map session -> lock cheaply. Codex liveness still uses the
// event-age heuristic below.

const ALIVE_CACHE_MS = 3000;
interface AliveCache {
  claude: Set<string>;
  codex: Set<string>;
  agy: Set<string>;
}
let aliveCache: AliveCache | null = null;
let aliveCacheExpiresAt = 0;

export function resetAliveCacheForTests(): void {
  aliveCache = null;
  aliveCacheExpiresAt = 0;
}

// /proc/<pid>/fd readlinks we recognize:
//   /home/<user>/.claude/tasks/<session_id>/.lock           (Claude session marker)
//   /home/<user>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl
//                                                           (Codex rollout, open while session lives)
// UUID-shaped session ids (8-4-4-4-12 hex). Tight match avoids greedy [^/]+
// from swallowing dashes inside the timestamp portion of the codex filename.
const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_LOCK_RE = new RegExp(`/\\.claude/tasks/(${UUID_RE_SRC})/\\.lock$`);
const CODEX_ROLLOUT_RE = new RegExp(
  `/\\.codex/sessions/[^ ]+/rollout-[^/]+-(${UUID_RE_SRC})\\.jsonl$`,
);
const AGY_CONVERSATION_RE = new RegExp(
  `/\\.gemini/antigravity-cli/conversations/(${UUID_RE_SRC})\\.(pb|tmp)$`,
);

function procStarttime(pid: number): number | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf-8') as string;
  } catch {
    return null;
  }
  const endComm = stat.lastIndexOf(') ');
  if (endComm === -1) return null;
  // Fields after ") " start with field 3 (state). Field 22 is therefore the
  // 20th token in this suffix, index 19 in a zero-based array.
  const fields = stat.slice(endComm + 2).trim().split(/\s+/);
  const raw = fields[19];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function isObservedParentAlive(
  pid: number | null,
  starttime: number | null,
): boolean {
  if (pid == null || starttime == null) return false;
  return procStarttime(pid) === starttime;
}

function refreshAliveCache(): void {
  const now = Date.now();
  if (aliveCache && aliveCacheExpiresAt > now) return;

  const cache: AliveCache = { claude: new Set(), codex: new Set(), agy: new Set() };
  let pids: string[];
  try {
    pids = fsImpl.readdirSync('/proc') as string[];
  } catch {
    aliveCache = cache;
    aliveCacheExpiresAt = now + ALIVE_CACHE_MS;
    return;
  }

  // Match a UUID anywhere in the rest of a token list. Used for `--resume`
  // arg parsing where the value may be the next argument in cmdline.
  const UUID_TOKEN_RE = new RegExp(`^${UUID_RE_SRC}$`);

  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let comm: string;
    try {
      comm = (fsImpl.readFileSync(`/proc/${pid}/comm`, 'utf-8') as string).trim();
    } catch {
      continue;
    }
    if (comm !== 'claude' && comm !== 'codex' && comm !== 'agy' && comm !== 'antigravity-cli') continue;

    // Resumed sessions (`claude --resume <sid>` or `codex --resume <sid>` or `agy --conversation <sid>`)
    // don't create a new lock file and don't keep their rollout fd open
    // persistently, so we'd miss them via the fd walk alone. Parse cmdline.
    try {
      const raw = fsImpl.readFileSync(`/proc/${pid}/cmdline`, 'utf-8') as string;
      const args = raw.split('\0');
      for (let i = 0; i < args.length - 1; i++) {
        if (
          (args[i] === '--resume' || args[i] === '--conversation') &&
          UUID_TOKEN_RE.test(args[i + 1] ?? '')
        ) {
          const sid = args[i + 1]!;
          if (comm === 'claude') cache.claude.add(sid);
          else if (comm === 'codex') cache.codex.add(sid);
          else cache.agy.add(sid);
          break;
        }
      }
    } catch {
      // cmdline unreadable; fall through to fd walk.
    }

    let fds: string[];
    try {
      fds = fsImpl.readdirSync(`/proc/${pid}/fd`) as string[];
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = fsImpl.readlinkSync(`/proc/${pid}/fd/${fd}`) as string;
        const cm = CLAUDE_LOCK_RE.exec(link);
        if (cm) {
          cache.claude.add(cm[1]!);
          continue;
        }
        const xm = CODEX_ROLLOUT_RE.exec(link);
        if (xm) {
          cache.codex.add(xm[1]!);
          continue;
        }
        const am = AGY_CONVERSATION_RE.exec(link);
        if (am) cache.agy.add(am[1]!);
      } catch {
        // fd vanished mid-walk; ignore.
      }
    }
  }

  aliveCache = cache;
  aliveCacheExpiresAt = now + ALIVE_CACHE_MS;
}

export function isClaudeSessionAlive(sessionId: string): boolean {
  if (!sessionId) return false;
  refreshAliveCache();
  return aliveCache!.claude.has(sessionId);
}

export function isCodexSessionAlive(sessionId: string): boolean {
  if (!sessionId) return false;
  refreshAliveCache();
  return aliveCache!.codex.has(sessionId);
}

export function isAgySessionAlive(sessionId: string): boolean {
  if (!sessionId) return false;
  refreshAliveCache();
  return aliveCache!.agy.has(sessionId);
}

// Tunables, exposed as constants for easy adjustment / test parameterization.
//
// Two display buckets only:
//   - DB state (THINKING / TOOL / WAITING / PERMISSION) when the last event
//     is fresh (< 60 min);
//   - IDLE when the session is alive (per /proc lock check) but quiet
//     (>= 60 min since last event).
//
// DONE comes from the process-liveness check in applyLiveness, not from age:
// a session whose claude/codex process has gone away is DONE regardless of
// how recent the last event was. STALE used to be the "alive but very quiet"
// fallback; we dropped it because the proc check makes it redundant.
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000; // 60 min — keep DB state as-is

// Grace for the start-of-session window when Claude hasn't yet opened its
// `.lock` fd (see top-of-file comment). If we observed an event within this
// window, treat the session as alive even without a /proc proof — events flow
// only from the live agent. 120 s comfortably covers the worst lock-creation
// gap we've measured (~87 s) while still letting a genuinely crashed session
// converge to `done` quickly.
export const FRESH_EVENT_GRACE_MS = 120 * 1000;

// Compute the display state for a row at a given wall-clock instant.
//
// Pure: no fs side effects. Production callers use `applyLiveness` (below)
// which composes this with the authoritative lock-file check.
//
// Logic:
//   - state === 'done'                  -> 'done'  (terminal; never overridden)
//   - now - last < ACTIVE_WINDOW_MS     -> state   (DB lifecycle value)
//   - else                               -> 'idle' (alive but quiet)
//
// STALE used to be a long-quiet fallback; we dropped it since process-liveness
// (in applyLiveness) authoritatively returns 'done' for dead processes. A
// session is either live (state or idle) or dead (done).
export function deriveDisplayState(row: SessionRow, nowMs: number): SessionState {
  if (row.state === 'done') return 'done';
  const age = nowMs - row.last_event_at_ms;
  if (age < ACTIVE_WINDOW_MS) return row.state;
  return 'idle';
}

// Pure decision: combine the impure "proven via /proc" boolean with the
// row+clock to produce a display state. Exported so tests can exercise the
// grace window without mocking /proc.
//
//   - proven via /proc            -> deriveDisplayState (DB state or idle)
//   - else fresh event in window  -> deriveDisplayState (events imply liveness)
//   - else                        -> 'done'
//
// `state === 'done'` is terminal in deriveDisplayState; both alive branches
// preserve that. The grace branch deliberately mirrors the proven branch
// rather than flipping to a synthetic state — false-alive for ~2 min reads
// better in the grid than a "maybe-alive" placeholder.
export function deriveLiveState(
  row: SessionRow,
  nowMs: number,
  proven: boolean,
): SessionState {
  if (proven) return deriveDisplayState(row, nowMs);
  if (nowMs - row.last_event_at_ms < FRESH_EVENT_GRACE_MS) {
    return deriveDisplayState(row, nowMs);
  }
  return 'done';
}

// Production-side liveness: combine the /proc check with the fresh-event
// grace via deriveLiveState. Side-effecting (walks /proc, cached for 3 s);
// tests should hit deriveLiveState or deriveDisplayState directly.
export function applyLiveness(row: SessionRow, nowMs: number): SessionState {
  const proven =
    isObservedParentAlive(row.observed_parent_pid, row.observed_parent_starttime) ||
    (row.provider === 'claude' && isClaudeSessionAlive(row.session_id)) ||
    (row.provider === 'codex' && isCodexSessionAlive(row.session_id)) ||
    (row.provider === 'agy' && isAgySessionAlive(row.session_id));
  return deriveLiveState(row, nowMs, proven);
}
