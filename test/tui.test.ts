// M5 smoke tests — pure-logic only. Component rendering is verified by hand
// (and by the M5_SMOKE.md captures); ink-testing-library is not installed and
// we are not allowed to add deps.
//
// Coverage:
//   1. store.applyDiff is idempotent — same input → same Map ref (so
//      React.memo'd cells skip re-render).
//   2. store.applyDiff returns a *new* Map ref when last_event_at_ms moves.
//   3. visibleKeys filters case-insensitively across cwd / state / tool / prompt.
//   4. handleGridKey: j moves down, enter opens detail, q quits, / enters
//      filter mode, esc clears filter.
//   5. handleDetailKey: esc returns to grid, j/k scroll events, q quits.
//   6. computeFocusAfterMove navigates a 2-D grid with clamping.

import { describe, expect, test } from 'bun:test';
import {
  applyActionToStore,
  computeFocusAfterMove,
  handleDetailKey,
  handleGridKey,
} from '../src/tui/keys.ts';
import { useStore, visibleKeys } from '../src/tui/store.ts';
import type { SessionRow } from '../src/types.ts';

function row(over: Partial<SessionRow>): SessionRow {
  return {
    key: 'k1',
    provider: 'claude',
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/home/u/project',
    model: 'claude-opus-4-7',
    cli_version: '2.1.0',
    pid: null,
    process_start_unix: null,
    started_at_ms: 1000,
    last_event_at_ms: 1000,
    prior_state: null,
    state: 'thinking',
    current_tool: null,
    last_prompt: null,
    observed_parent_pid: null,
    observed_parent_starttime: null,
    origin: null,
    context_tokens_used: null,
    context_tokens_max: null,
    context_source: null,
    ...over,
  };
}

function resetStore(): void {
  useStore.setState({
    sessions: new Map(),
    order: [],
    mode: 'grid',
    previousMode: 'grid',
    focusedKey: null,
    filter: '',
    filterMode: false,
    density: 'card',
    recentEvents: new Map(),
    eventScroll: 0,
    tick: 0,
  });
}

describe('store.applyDiff', () => {
  test('returns same sessions ref when nothing changed', () => {
    resetStore();
    const a = row({ key: 'a' });
    const b = row({ key: 'b', last_event_at_ms: 2000 });

    useStore.getState().applyDiff([a, b]);
    const refA = useStore.getState().sessions;

    const changed = useStore.getState().applyDiff([a, b]);
    const refB = useStore.getState().sessions;

    expect(changed).toBe(0);
    expect(refB).toBe(refA); // same reference — memo holds
  });

  test('returns new sessions ref when last_event_at_ms moves', () => {
    resetStore();
    const a = row({ key: 'a' });
    useStore.getState().applyDiff([a]);
    const refBefore = useStore.getState().sessions;

    const a2 = row({ key: 'a', last_event_at_ms: a.last_event_at_ms + 1 });
    const changed = useStore.getState().applyDiff([a2]);
    const refAfter = useStore.getState().sessions;

    expect(changed).toBe(1);
    expect(refAfter).not.toBe(refBefore);
    expect(refAfter.get('a')).toBe(a2);
  });

  test('drops removed keys and returns new ref', () => {
    resetStore();
    const a = row({ key: 'a' });
    const b = row({ key: 'b' });
    useStore.getState().applyDiff([a, b]);
    expect(useStore.getState().sessions.size).toBe(2);

    const changed = useStore.getState().applyDiff([a]);
    expect(changed).toBe(1);
    expect(useStore.getState().sessions.size).toBe(1);
    expect(useStore.getState().sessions.has('b')).toBe(false);
  });

  test('preserves order across ticks', () => {
    resetStore();
    const a = row({ key: 'a' });
    const b = row({ key: 'b' });
    const c = row({ key: 'c' });
    useStore.getState().applyDiff([a, b, c]);
    expect(useStore.getState().order).toEqual(['a', 'b', 'c']);

    // Reorder the input — order in the store stays stable.
    useStore.getState().applyDiff([c, a, b]);
    expect(useStore.getState().order).toEqual(['a', 'b', 'c']);
  });
});

describe('visibleKeys filter', () => {
  test('matches against cwd, state, current_tool, last_prompt', () => {
    const sessions = new Map<string, SessionRow>([
      ['a', row({ key: 'a', cwd: '/proj/foo', state: 'tool', current_tool: 'Bash' })],
      ['b', row({ key: 'b', cwd: '/proj/bar', state: 'thinking', last_prompt: 'hello' })],
      ['c', row({ key: 'c', cwd: '/proj/baz', provider: 'codex' })],
    ]);
    const order = ['a', 'b', 'c'];

    expect(visibleKeys(order, sessions, '')).toEqual(['a', 'b', 'c']);
    expect(visibleKeys(order, sessions, 'bash')).toEqual(['a']);
    expect(visibleKeys(order, sessions, 'HELLO')).toEqual(['b']);
    expect(visibleKeys(order, sessions, 'codex')).toEqual(['c']);
    expect(visibleKeys(order, sessions, 'proj')).toEqual(['a', 'b', 'c']);
    expect(visibleKeys(order, sessions, 'nope')).toEqual([]);
  });

  test('deduplicates proc placeholders by provider and cwd', () => {
    const sessions = new Map<string, SessionRow>([
      [
        'p1',
        row({
          key: 'p1',
          provider: 'codex',
          session_id: 'proc-1-100',
          cwd: '/repo',
          origin: 'proc',
          last_event_at_ms: 100,
        }),
      ],
      [
        'p2',
        row({
          key: 'p2',
          provider: 'codex',
          session_id: 'proc-2-101',
          cwd: '/repo',
          origin: 'proc',
          last_event_at_ms: 200,
        }),
      ],
      ['real', row({ key: 'real', provider: 'codex', session_id: 'real', cwd: '/other' })],
    ]);
    expect(visibleKeys(['p1', 'p2', 'real'], sessions, '')).toEqual(['real', 'p2']);
  });

  test('hides proc placeholder when real session exists for same provider and cwd', () => {
    const sessions = new Map<string, SessionRow>([
      [
        'proc',
        row({
          key: 'proc',
          provider: 'claude',
          session_id: 'proc-1-100',
          cwd: '/repo',
          origin: 'proc',
          last_event_at_ms: 200,
        }),
      ],
      [
        'real',
        row({
          key: 'real',
          provider: 'claude',
          session_id: 'real',
          cwd: '/repo',
          origin: null,
          last_event_at_ms: 100,
        }),
      ],
    ]);
    expect(visibleKeys(['proc', 'real'], sessions, '')).toEqual(['real']);
  });
});

describe('handleGridKey', () => {
  test('j and downArrow move focus down', () => {
    expect(handleGridKey('j', {})).toEqual({ type: 'move-focus', dx: 0, dy: 1 });
    expect(handleGridKey('', { downArrow: true })).toEqual({
      type: 'move-focus',
      dx: 0,
      dy: 1,
    });
  });

  test('k/h/l move focus correctly', () => {
    expect(handleGridKey('k', {})).toEqual({ type: 'move-focus', dx: 0, dy: -1 });
    expect(handleGridKey('h', {})).toEqual({ type: 'move-focus', dx: -1, dy: 0 });
    expect(handleGridKey('l', {})).toEqual({ type: 'move-focus', dx: 1, dy: 0 });
  });

  test('enter opens detail', () => {
    expect(handleGridKey('', { return: true })).toEqual({ type: 'open-detail' });
  });

  test('q and ctrl-c quit', () => {
    expect(handleGridKey('q', {})).toEqual({ type: 'quit' });
    expect(handleGridKey('c', { ctrl: true })).toEqual({ type: 'quit' });
  });

  test('/ enters filter mode, esc clears', () => {
    expect(handleGridKey('/', {})).toEqual({ type: 'enter-filter' });
    expect(handleGridKey('', { escape: true })).toEqual({ type: 'clear-filter' });
  });

  test('r triggers reconcile', () => {
    expect(handleGridKey('r', {})).toEqual({ type: 'reconcile' });
  });

  test('d cycles density', () => {
    expect(handleGridKey('d', {})).toEqual({ type: 'cycle-density' });
  });

  test('unknown keys are no-op', () => {
    expect(handleGridKey('z', {})).toEqual({ type: 'none' });
  });

  test('? toggles help', () => {
    expect(handleGridKey('?', {})).toEqual({ type: 'toggle-help' });
  });
});

describe('handleDetailKey', () => {
  test('esc goes back to grid', () => {
    expect(handleDetailKey('', { escape: true })).toEqual({ type: 'back-to-grid' });
  });

  test('j/k scroll events', () => {
    expect(handleDetailKey('j', {})).toEqual({ type: 'scroll-events', delta: 1 });
    expect(handleDetailKey('k', {})).toEqual({ type: 'scroll-events', delta: -1 });
  });

  test('q quits', () => {
    expect(handleDetailKey('q', {})).toEqual({ type: 'quit' });
    expect(handleDetailKey('c', { ctrl: true })).toEqual({ type: 'quit' });
  });

  test('? toggles help', () => {
    expect(handleDetailKey('?', {})).toEqual({ type: 'toggle-help' });
  });
});

describe('computeFocusAfterMove', () => {
  test('returns null on empty list', () => {
    expect(computeFocusAfterMove([], 3, null, 0, 1)).toBeNull();
  });

  test('first focus picks first key', () => {
    expect(computeFocusAfterMove(['a', 'b', 'c'], 3, null, 0, 1)).toBe('a');
  });

  test('moves down within bounds', () => {
    // 6 keys laid out in 3 cols: a b c / d e f
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(computeFocusAfterMove(keys, 3, 'a', 0, 1)).toBe('d');
    expect(computeFocusAfterMove(keys, 3, 'a', 1, 0)).toBe('b');
    expect(computeFocusAfterMove(keys, 3, 'd', 0, -1)).toBe('a');
    expect(computeFocusAfterMove(keys, 3, 'b', -1, 0)).toBe('a');
  });

  test('clamps at edges', () => {
    const keys = ['a', 'b', 'c'];
    expect(computeFocusAfterMove(keys, 3, 'a', -1, 0)).toBe('a'); // already left
    expect(computeFocusAfterMove(keys, 3, 'c', 1, 0)).toBe('c'); // already right
    expect(computeFocusAfterMove(keys, 3, 'a', 0, -1)).toBe('a'); // already top
  });

  test('handles ragged last row', () => {
    // 5 keys, 3 cols → row 0: a b c, row 1: d e
    const keys = ['a', 'b', 'c', 'd', 'e'];
    // moving down from c (col 2) — last row only has [d, e]; clamp to e.
    expect(computeFocusAfterMove(keys, 3, 'c', 0, 1)).toBe('e');
  });
});

describe('store.density', () => {
  test('defaults to card', () => {
    resetStore();
    expect(useStore.getState().density).toBe('card');
  });

  test('cycleDensity walks card -> compact -> row -> card', () => {
    resetStore();
    const cycle = useStore.getState().cycleDensity;
    cycle();
    expect(useStore.getState().density).toBe('compact');
    cycle();
    expect(useStore.getState().density).toBe('row');
    cycle();
    expect(useStore.getState().density).toBe('card');
  });

  test('setDensity assigns directly', () => {
    resetStore();
    useStore.getState().setDensity('row');
    expect(useStore.getState().density).toBe('row');
    useStore.getState().setDensity('compact');
    expect(useStore.getState().density).toBe('compact');
  });
});

describe('applyActionToStore (pure dispatch helper)', () => {
  test('quit sets quit flag', () => {
    const s = { mode: 'grid' as const, previousMode: 'grid' as const, focusedKey: null, filter: '', filterMode: false, eventScroll: 0 };
    expect(applyActionToStore(s, { type: 'quit' }).quit).toBe(true);
  });

  test('open-detail flips mode', () => {
    const s = { mode: 'grid' as const, previousMode: 'grid' as const, focusedKey: 'k', filter: '', filterMode: false, eventScroll: 5 };
    const r = applyActionToStore(s, { type: 'open-detail' });
    expect(r.mode).toBe('detail');
    expect(r.eventScroll).toBe(0);
  });

  test('clear-filter resets filter and exits filter mode', () => {
    const s = { mode: 'grid' as const, previousMode: 'grid' as const, focusedKey: null, filter: 'hi', filterMode: true, eventScroll: 0 };
    const r = applyActionToStore(s, { type: 'clear-filter' });
    expect(r.filter).toBe('');
    expect(r.filterMode).toBe(false);
  });

  test('scroll-events clamps at zero', () => {
    const s = { mode: 'detail' as const, previousMode: 'detail' as const, focusedKey: 'k', filter: '', filterMode: false, eventScroll: 0 };
    const r = applyActionToStore(s, { type: 'scroll-events', delta: -5 });
    expect(r.eventScroll).toBe(0);
  });

  test('help mode toggles back to previous mode', () => {
    const s = { mode: 'grid' as const, previousMode: 'grid' as const, focusedKey: null, filter: '', filterMode: false, eventScroll: 0 };
    const help = applyActionToStore(s, { type: 'toggle-help' });
    expect(help.mode).toBe('help');
    expect(help.previousMode).toBe('grid');

    const back = applyActionToStore(help, { type: 'toggle-help' });
    expect(back.mode).toBe('grid');
  });
});
