// Hook installer: merges our hooks into ~/.claude/settings.json with consent + rollback.
// All functions are pure or explicit-side-effect; nothing runs on import.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.ts';

// Events we register the Claude hook for. Plan §M2.
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

// Single hook handler entry — Claude Code's `hooks[Event][i].hooks[j]` shape.
interface CommandHandler {
  type: 'command';
  command: string;
  // Other fields may exist on user-authored entries; we preserve unknown keys
  // verbatim by treating handler objects opaquely except when matching ours.
  [extra: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks: CommandHandler[];
  [extra: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Partial<Record<string, MatcherGroup[]>>;
  [extra: string]: unknown;
}

export interface InstallPlan {
  settingsPath: string;
  currentJson: ClaudeSettings;
  nextJson: ClaudeSettings;
  diffString: string;
}

// The absolute path of the installed Claude hook script. We use this exact
// string as the registered command and as the marker for uninstall matching.
export function claudeHookCommandPath(): string {
  return path.join(PATHS.hooks, 'claude-hook.sh');
}

// Build the command string we register for a given event.
// We invoke the script with the provider and event name as positional args,
// matching the `$1` / `$2` contract in hooks/claude-hook.sh.
function buildClaudeCommand(event: ClaudeHookEvent): string {
  const script = claudeHookCommandPath();
  return `${shellQuote(script)} claude ${event}`;
}

// Minimal POSIX shell single-quoting for our path (no embedded single quotes
// in HOME-derived paths under any sane setup, but be safe).
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Returns true if a handler is one we installed (path points into PATHS.hooks).
function isOurHandler(h: CommandHandler): boolean {
  if (h.type !== 'command' || typeof h.command !== 'string') return false;
  const ourDir = PATHS.hooks;
  // Match either the bare path or our quoted version, and tolerate trailing args.
  return h.command.includes(ourDir);
}

// Read settings.json from disk (or return {} if missing). Throws on parse error
// — we refuse the temptation to guess on malformed config.
export function readClaudeSettings(settingsPath = PATHS.claudeSettings): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`settings.json is not a JSON object: ${settingsPath}`);
    }
    return parsed as ClaudeSettings;
  } catch (err) {
    throw new Error(
      `failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Pure: produce the merged-settings object that adds our hook entries.
// Preserves any unrelated keys, unrelated event arrays, and matcher groups.
// For each target event, we add a dedicated matcher group containing our
// command — we do NOT splice into existing groups (keeps uninstall trivially
// reversible: drop our group, leave others untouched).
export function mergeClaudeHooks(current: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...current };
  const nextHooks: Partial<Record<string, MatcherGroup[]>> = { ...(current.hooks ?? {}) };

  for (const event of CLAUDE_HOOK_EVENTS) {
    const command = buildClaudeCommand(event);
    const existingGroups = nextHooks[event] ? [...(nextHooks[event] as MatcherGroup[])] : [];
    // Drop any pre-existing group of ours (idempotent install).
    const filtered = existingGroups
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((h) => !isOurHandler(h)),
      }))
      .filter((g) => (g.hooks ?? []).length > 0);

    const ourGroup: MatcherGroup = {
      matcher: '',
      hooks: [{ type: 'command', command }],
    };
    nextHooks[event] = [...filtered, ourGroup];
  }
  next.hooks = nextHooks;
  return next;
}

// Plan: read disk, compute merge, render diff. Side-effect: only fs.readFileSync.
export function planClaudeHookInstall(
  settingsPath = PATHS.claudeSettings,
): InstallPlan {
  const currentJson = readClaudeSettings(settingsPath);
  const nextJson = mergeClaudeHooks(currentJson);
  const diffString = unifiedDiff(
    JSON.stringify(currentJson, null, 2),
    JSON.stringify(nextJson, null, 2),
    path.basename(settingsPath),
  );
  return { settingsPath, currentJson, nextJson, diffString };
}

// Atomic apply: backup current → write tmp → fsync → rename. Throws on error.
export function applyClaudeHookInstall(plan: InstallPlan): void {
  const target = plan.settingsPath;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Backup if a file is there. We do not back up an empty/missing file.
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${target}.bak.${stamp}`;
    fs.copyFileSync(target, backup);
  }

  const tmp = `${target}.tmp`;
  const body = JSON.stringify(plan.nextJson, null, 2) + '\n';
  // Open, write, fsync, close — required for the atomic-rename guarantee.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

// Copy hook scripts into ~/.local/share/agent-monitor/hooks/ with chmod +x.
// Source dir resolution: walk up from this module to find the repo root holding
// the `hooks/` directory. Falls back to CWD-relative if not found.
export function installPlanFiles(): void {
  const hooksSrcDir = findRepoHooksDir();
  if (!hooksSrcDir) {
    throw new Error('could not locate hooks/ directory relative to install.ts');
  }
  fs.mkdirSync(PATHS.hooks, { recursive: true });
  for (const name of ['claude-hook.sh', 'codex-hook.sh', 'agy-hook.sh']) {
    const src = path.join(hooksSrcDir, name);
    const dst = path.join(PATHS.hooks, name);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }
}

function findRepoHooksDir(): string | null {
  // import.meta.url → src/install.ts → walk up to find sibling `hooks/`.
  const here = new URL('.', import.meta.url).pathname; // .../src/
  let dir = path.resolve(here, '..'); // repo root candidate
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'hooks');
    if (
      fs.existsSync(path.join(candidate, 'claude-hook.sh')) &&
      fs.existsSync(path.join(candidate, 'codex-hook.sh')) &&
      fs.existsSync(path.join(candidate, 'agy-hook.sh'))
    ) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Remove ONLY entries we added (handler.command points into PATHS.hooks).
// Preserves any unrelated hooks the user added independently.
export function uninstallClaudeHooks(settingsPath = PATHS.claudeSettings): void {
  if (!fs.existsSync(settingsPath)) return;
  const current = readClaudeSettings(settingsPath);
  const next = stripOurHooks(current);
  // Backup, then atomic-write the cleaned settings.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${settingsPath}.bak.${stamp}`;
  fs.copyFileSync(settingsPath, backup);
  const tmp = `${settingsPath}.tmp`;
  const body = JSON.stringify(next, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, settingsPath);
}

// Pure helper: return a copy of `settings` with our handlers removed and
// emptied groups/events pruned. If `hooks` becomes empty we delete the key
// entirely so the file round-trips back to its pre-install shape.
export function stripOurHooks(settings: ClaudeSettings): ClaudeSettings {
  const out: ClaudeSettings = { ...settings };
  const hooks = settings.hooks;
  if (!hooks) return out;
  const nextHooks: Partial<Record<string, MatcherGroup[]>> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleaned = (groups as MatcherGroup[])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((h) => !isOurHandler(h)),
      }))
      .filter((g) => (g.hooks ?? []).length > 0);
    if (cleaned.length > 0) nextHooks[event] = cleaned;
  }
  if (Object.keys(nextHooks).length === 0) {
    delete out.hooks;
  } else {
    out.hooks = nextHooks;
  }
  return out;
}

// Tiny unified-diff renderer. Not full GNU diff; enough to be readable in a
// terminal preview. Produces a `--- a/<label>` / `+++ b/<label>` header and
// per-line +/- markers via a basic LCS.
export function unifiedDiff(a: string, b: string, label: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const ops = lcsDiff(aLines, bLines);
  const out: string[] = [];
  out.push(`--- a/${label}`);
  out.push(`+++ b/${label}`);
  for (const op of ops) {
    if (op.kind === 'eq') out.push(' ' + op.line);
    else if (op.kind === 'del') out.push('-' + op.line);
    else out.push('+' + op.line);
  }
  return out.join('\n');
}

type DiffOp =
  | { kind: 'eq'; line: string }
  | { kind: 'del'; line: string }
  | { kind: 'add'; line: string };

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ kind: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++] });
  while (j < m) ops.push({ kind: 'add', line: b[j++] });
  return ops;
}
