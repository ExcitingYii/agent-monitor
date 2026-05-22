// Best-effort process discovery for sessions that have not emitted hooks yet.
//
// Hooks are still the source of truth, but some CLIs do not fire SessionStart
// until after the first user action. This pass creates short-lived "proc"
// rows so a newly opened Claude/Codex/Agy terminal appears in the TUI before
// the first prompt/tool event arrives.

import {
  readFileSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { sessionKey } from '../paths.ts';
import type { Provider } from '../types.ts';
import {
  findRealSessionByObservedParent,
  markProcPlaceholdersDone,
  upsertSession,
} from '../store/queries.ts';

export interface ProcDiscoveryStats {
  processesScanned: number;
  placeholdersUpserted: number;
  placeholdersRetired: number;
}

interface Candidate {
  provider: Provider;
  pid: string;
  pidNum: number;
  starttime: number;
  comm: string;
  cwd: string | null;
  model: string | null;
}

const PROVIDER_COMMS: Record<Provider, ReadonlySet<string>> = {
  claude: new Set(['claude']),
  codex: new Set(['codex']),
  agy: new Set(['agy', 'antigravity-cli']),
};

function procPath(procRoot: string, pid: string, suffix: string): string {
  return path.join(procRoot, pid, suffix);
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function procStarttime(stat: string): number | null {
  const endComm = stat.lastIndexOf(') ');
  if (endComm === -1) return null;
  const fields = stat.slice(endComm + 2).trim().split(/\s+/);
  const raw = fields[19];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function providerFromCommand(comm: string, args: string[]): Provider | null {
  for (const [provider, comms] of Object.entries(PROVIDER_COMMS) as [Provider, ReadonlySet<string>][]) {
    if (comms.has(comm)) return provider;
  }
  for (const arg of args) {
    const base = path.basename(arg);
    if (base === 'claude') return 'claude';
    if (base === 'codex') return 'codex';
    if (base === 'agy' || base === 'antigravity-cli') return 'agy';
  }
  return null;
}

function providerMatchesComm(provider: Provider, comm: string): boolean {
  return PROVIDER_COMMS[provider].has(comm);
}

function isInteractiveProcess(procRoot: string, pid: string): boolean {
  // Hook child processes and non-interactive helper commands usually have no
  // terminal fd. A real TUI session normally has one of stdio attached to a
  // /dev/pts terminal.
  for (const fd of ['0', '1', '2']) {
    try {
      const link = readlinkSync(procPath(procRoot, pid, `fd/${fd}`));
      if (link.startsWith('/dev/pts/') || link.startsWith('/dev/tty')) return true;
    } catch {
      // fd vanished or unreadable; keep checking the others.
    }
  }
  return false;
}

function cwdForPid(procRoot: string, pid: string): string | null {
  try {
    return readlinkSync(procPath(procRoot, pid, 'cwd'));
  } catch {
    return null;
  }
}

function modelFromArgs(args: string[], provider: Provider): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--model' || args[i] === '-m') return args[i + 1] ?? null;
  }
  return provider === 'agy' ? 'Gemini' : null;
}

function groupKey(c: Candidate): string {
  return `${c.provider}\0${c.cwd ?? ''}`;
}

function betterCandidate(a: Candidate, b: Candidate): Candidate {
  const aExact = providerMatchesComm(a.provider, a.comm) ? 1 : 0;
  const bExact = providerMatchesComm(b.provider, b.comm) ? 1 : 0;
  if (aExact !== bExact) return aExact > bExact ? a : b;
  return a.pidNum <= b.pidNum ? a : b;
}

export async function discoverProcSessionsOnce(
  nowMs: number = Date.now(),
  procRoot: string = '/proc',
): Promise<ProcDiscoveryStats> {
  const stats: ProcDiscoveryStats = {
    processesScanned: 0,
    placeholdersUpserted: 0,
    placeholdersRetired: 0,
  };

  let pids: string[];
  try {
    pids = readdirSync(procRoot);
  } catch {
    return stats;
  }

  const candidates: Candidate[] = [];

  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const comm = readText(procPath(procRoot, pid, 'comm'))?.trim();
    if (!comm) continue;
    const args = readText(procPath(procRoot, pid, 'cmdline'))?.split('\0').filter(Boolean) ?? [];
    const provider = providerFromCommand(comm, args);
    if (!provider) continue;
    stats.processesScanned++;

    const stat = readText(procPath(procRoot, pid, 'stat'));
    const starttime = stat ? procStarttime(stat) : null;
    if (starttime == null) continue;

    const pidNum = Number(pid);
    const real = findRealSessionByObservedParent(provider, pidNum, starttime);
    if (real) {
      stats.placeholdersRetired += markProcPlaceholdersDone(
        provider,
        pidNum,
        starttime,
        nowMs,
      );
      continue;
    }

    if (!isInteractiveProcess(procRoot, pid)) continue;

    candidates.push({
      provider,
      pid,
      pidNum,
      starttime,
      comm,
      cwd: cwdForPid(procRoot, pid),
      model: modelFromArgs(args, provider),
    });
  }

  const selected = new Map<string, Candidate>();
  for (const c of candidates) {
    const k = groupKey(c);
    const existing = selected.get(k);
    selected.set(k, existing ? betterCandidate(existing, c) : c);
  }

  for (const c of candidates) {
    if (selected.get(groupKey(c)) !== c) {
      stats.placeholdersRetired += markProcPlaceholdersDone(
        c.provider,
        c.pidNum,
        c.starttime,
        nowMs,
      );
      continue;
    }
    const sessionId = `proc-${c.pid}-${c.starttime}`;
    upsertSession({
      key: sessionKey(c.provider, sessionId, null),
      provider: c.provider,
      session_id: sessionId,
      observed_at_ms: nowMs,
      state: 'waiting',
      cwd: c.cwd,
      model: c.model,
      observed_parent_pid: c.pidNum,
      observed_parent_starttime: c.starttime,
      origin: 'proc',
    });
    stats.placeholdersUpserted++;
  }
  return stats;
}
