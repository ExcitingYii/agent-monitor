// Zustand store for the TUI.
//
// Three slices:
//   1. sessions:      Map<sessionKey, SessionRow>     — the grid data
//   2. recentEvents:  Map<sessionKey, EventRow[]>     — populated for the
//                                                       focused session in
//                                                       detail mode only
//   3. UI:            mode, focusedKey, filter, eventScroll
//
// `applyDiff` is the hot path called every 200 ms. It MUST return the same
// `sessions` map ref when nothing material changed so React.memo'd cells skip
// re-render. The change signal is `last_event_at_ms` (monotonic per row), with
// state/current_tool fallback for cases where a row mutated within the same ms.

import { create } from 'zustand';
import { applyLiveness } from '../liveness.ts';
import type { SessionStats } from '../store/queries.ts';
import type { EventRow, SessionRow } from '../types.ts';

export type Mode = 'grid' | 'detail' | 'help';
export type Density = 'card' | 'compact' | 'row';

// Cycle order for the `d` key. Card is the v1.1 default; row is the legacy
// dense one-line layout retained for high session counts.
const DENSITY_CYCLE: readonly Density[] = ['card', 'compact', 'row'];

export interface TuiState {
  // data
  sessions: Map<string, SessionRow>;
  order: string[]; // stable display order across ticks

  // ui
  mode: Mode;
  previousMode: Exclude<Mode, 'help'>;
  focusedKey: string | null;
  filter: string;
  filterMode: boolean; // true while user is editing the filter text
  showAll: boolean;   // when false, hide sessions whose display state is stale/done
  showMcp: boolean;   // when false, hide MCP-spawned codex sessions (origin='mcp')
  density: Density;   // grid-cell renderer (cycled with `d`); not persisted

  // detail
  recentEvents: Map<string, EventRow[]>;
  eventScroll: number; // top index into the events list for detail view

  // grid scroll: index of the first visible cell in the current visibleKeys
  // ordering. Auto-adjusts on focus move; bumped by Ctrl-D / Ctrl-U.
  scrollOffset: number;

  // per-session progress stats (turns + subagent count), refreshed each tick
  sessionStats: Map<string, SessionStats>;

  // tick / actions
  tick: number;
  applyDiff: (rows: SessionRow[]) => number; // returns # of changed cells
  setFocusedKey: (key: string | null) => void;
  setMode: (mode: Mode) => void;
  setFilter: (s: string) => void;
  setFilterMode: (on: boolean) => void;
  setShowAll: (on: boolean) => void;
  setShowMcp: (on: boolean) => void;
  setDensity: (d: Density) => void;
  cycleDensity: () => void;
  setRecentEvents: (key: string, events: EventRow[]) => void;
  setEventScroll: (n: number) => void;
  setSessionStats: (m: Map<string, SessionStats>) => void;
  setScrollOffset: (n: number) => void;
}

// Equality check for one session row. We compare the fields that the cell
// renderer actually reads. last_event_at_ms is the primary monotonic signal.
function rowEqual(a: SessionRow, b: SessionRow): boolean {
  return (
    a.last_event_at_ms === b.last_event_at_ms &&
    a.state === b.state &&
    a.current_tool === b.current_tool &&
    a.cwd === b.cwd &&
    a.last_prompt === b.last_prompt &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.context_tokens_used === b.context_tokens_used &&
    a.context_tokens_max === b.context_tokens_max &&
    a.context_source === b.context_source
  );
}

export const useStore = create<TuiState>((set, get) => ({
  sessions: new Map(),
  order: [],
  mode: 'grid',
  previousMode: 'grid',
  focusedKey: null,
  filter: '',
  filterMode: false,
  showAll: false,
  showMcp: false,
  density: 'card',
  recentEvents: new Map(),
  eventScroll: 0,
  scrollOffset: 0,
  sessionStats: new Map(),
  tick: 0,

  applyDiff: (rows) => {
    const prev = get().sessions;
    let next: Map<string, SessionRow> | null = null;
    let changed = 0;

    // Detect insertions and modifications. Reuse old row refs when nothing
    // changed so React.memo'd cells stay stable.
    const incoming = new Set<string>();
    for (const row of rows) {
      incoming.add(row.key);
      const old = prev.get(row.key);
      if (!old || !rowEqual(old, row)) {
        if (!next) next = new Map(prev);
        next.set(row.key, row);
        changed++;
      }
    }

    // Detect deletions (sessions that aged out of "active" set).
    for (const k of prev.keys()) {
      if (!incoming.has(k)) {
        if (!next) next = new Map(prev);
        next.delete(k);
        changed++;
      }
    }

    // Maintain a stable display order: new keys appended in arrival order,
    // missing keys removed. The grid sorts by last_event_at_ms at render time.
    if (next) {
      const old = get().order;
      const seen = new Set<string>();
      const order: string[] = [];
      for (const k of old) {
        if (next.has(k) && !seen.has(k)) {
          order.push(k);
          seen.add(k);
        }
      }
      for (const r of rows) {
        if (!seen.has(r.key)) {
          order.push(r.key);
          seen.add(r.key);
        }
      }
      set({ sessions: next, order, tick: get().tick + 1 });
    } else {
      // No structural change — bump tick only. Map ref stays the same so
      // useStore((s) => s.sessions) returns a stable value.
      set({ tick: get().tick + 1 });
    }
    return changed;
  },

  setFocusedKey: (key) => set({ focusedKey: key }),
  setMode: (mode) => {
    const cur = get();
    if (mode === 'help') {
      if (cur.mode === 'help') {
        set({ mode: cur.previousMode, eventScroll: 0 });
        return;
      }
      set({ mode: 'help', previousMode: cur.mode, eventScroll: 0 });
      return;
    }
    set({ mode, previousMode: mode, eventScroll: 0 });
  },
  setFilter: (s) => set({ filter: s }),
  setFilterMode: (on) => set({ filterMode: on }),
  setShowAll: (on) => set({ showAll: on }),
  setShowMcp: (on) => set({ showMcp: on }),
  setDensity: (d) => set({ density: d }),
  cycleDensity: () => {
    const cur = get().density;
    const idx = DENSITY_CYCLE.indexOf(cur);
    const next = DENSITY_CYCLE[(idx + 1) % DENSITY_CYCLE.length] ?? 'card';
    set({ density: next });
  },
  setRecentEvents: (key, events) => {
    const next = new Map(get().recentEvents);
    next.set(key, events);
    set({ recentEvents: next });
  },
  setEventScroll: (n) => set({ eventScroll: Math.max(0, n) }),
  setSessionStats: (m) => set({ sessionStats: m }),
  setScrollOffset: (n) => set({ scrollOffset: Math.max(0, n) }),
}));

// Helper used by the grid to derive the display list. Pure; callers pass the
// current store snapshot. Two filters compose:
//   - text filter (case-insensitive substring across cwd/state/tool/model/prompt)
//   - inactive filter (when showAll=false, hide sessions whose display state
//     resolves to stale/done at nowMs — the user wants a clean grid by default)
export function visibleKeys(
  order: string[],
  sessions: Map<string, SessionRow>,
  filter: string,
  opts?: { showAll?: boolean; showMcp?: boolean; nowMs?: number },
): string[] {
  const showAll = opts?.showAll ?? true;
  const showMcp = opts?.showMcp ?? true;
  const nowMs = opts?.nowMs ?? Date.now();
  const f = filter.trim().toLowerCase();
  const realByProviderCwd = new Set<string>();
  const procKeepByProviderCwd = new Map<string, string>();

  for (const k of order) {
    const r = sessions.get(k);
    if (!r) continue;
    const group = `${r.provider}\0${r.cwd ?? ''}`;
    if (r.origin === 'proc' || r.session_id.startsWith('proc-')) {
      const prev = procKeepByProviderCwd.get(group);
      if (!prev) {
        procKeepByProviderCwd.set(group, k);
      } else {
        const a = sessions.get(prev)!;
        if (r.last_event_at_ms > a.last_event_at_ms) procKeepByProviderCwd.set(group, k);
      }
    } else {
      realByProviderCwd.add(group);
    }
  }

  const filtered = order.filter((k) => {
    const r = sessions.get(k);
    if (!r) return false;
    const isProc = r.origin === 'proc' || r.session_id.startsWith('proc-');
    if (isProc) {
      const group = `${r.provider}\0${r.cwd ?? ''}`;
      if (realByProviderCwd.has(group)) return false;
      if (procKeepByProviderCwd.get(group) !== k) return false;
    }

    if (!showAll) {
      const display = applyLiveness(r, nowMs);
      if (display === 'stale' || display === 'done') return false;
    }

    // Hide MCP-spawned codex sessions by default — they're not waiting for
    // human input, they're tied up serving a Claude session via the
    // mcp__codex__codex tool. Press `m` to reveal them.
    if (!showMcp && r.origin === 'mcp') return false;

    if (!f) return true;
    const haystack = `${r.provider} ${r.cwd ?? ''} ${r.state} ${r.current_tool ?? ''} ${
      r.model ?? ''
    } ${r.last_prompt ?? ''}`.toLowerCase();
    return haystack.includes(f);
  });

  // Sort by recency so the most active session is the focus default and the
  // grid reads top-down as "what's happening right now". Stable for ties.
  return filtered.sort((a, b) => {
    const ra = sessions.get(a)!;
    const rb = sessions.get(b)!;
    return rb.last_event_at_ms - ra.last_event_at_ms;
  });
}
