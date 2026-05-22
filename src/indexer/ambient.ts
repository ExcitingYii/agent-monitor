// Ambient in-process indexer (M6 top priority).
//
// The TUI used to be a startup snapshot + manual refresh. The drain/reconcile
// passes were one-shot. That left the grid stale until the user pressed `r`.
//
// This module promotes both passes to continuous loops in the TUI process:
//
//   - drainOnce()        every ~1s   (cheap; reads the per-session spool files)
//   - runReconcileOnce() every ~8s   (heavier; tails ~/.claude/projects + ~/.codex/sessions)
//
// Design constraints (per plan M6 1.):
//   - Skip-if-overlapping: a slow pass must not double-fire. We drop the next
//     tick rather than queue.
//   - Bounded batch: drainOnce already returns line counts; if we ingested >=
//     SOFT_BATCH_CAP lines, we expect there's more, so we'll fire the next
//     drain immediately after this one settles.
//   - Fail-open: errors go to tui.log + the onStatus surface; never thrown.
//
// We DO NOT use chokidar in the TUI process. The watch-mode spool tailer is
// available for a separate `agent-monitor index` daemon if we ever need it,
// but for the live UI a 1s poll is simpler, never duplicates events (drain is
// idempotent by source_offset), and avoids inotify limits on busy boxes.

import { drainOnce as defaultDrainOnce, type DrainStats } from './spool.ts';
import {
  discoverProcSessionsOnce as defaultDiscoverProcSessionsOnce,
  type ProcDiscoveryStats,
} from './proc-discovery.ts';
import {
  runReconcileOnce as defaultRunReconcileOnce,
  type ReconcileStats,
} from '../reconciler/index.ts';
import { logError } from '../tui/log.ts';
import {
  getWriterStatus,
  releaseWriter,
  tryAcquireWriter,
} from './writer-lock.ts';

export interface AmbientStatus {
  // Wall-clock at the moment the most recent drain finished. null until 1st pass.
  lastDrainAt: number | null;
  lastDrainStats: DrainStats | null;
  lastReconcileAt: number | null;
  lastReconcileStats: ReconcileStats | null;
  // Last error from EITHER drain or reconcile, with a tag. null if both passes
  // succeeded since the last clear.
  lastError: { source: 'drain' | 'reconcile'; message: string; at: number } | null;
  // Best-effort backlog hint. We can only count what drainOnce returns; if a
  // pass skipped because the previous one was still running, the "backlog" we
  // surface is the LAST drainStats.linesIngested -- a non-zero value means the
  // last pass had work, which roughly maps to "stuff was waiting".
  drainBacklogLines: number;
  // Wall-clock age of the oldest spool file we know exists but haven't read
  // recent bytes from. We don't compute this synchronously every status push
  // (would require a directory walk); the spool tailer's drainOnce updates it
  // implicitly via filesScanned. For v1 we expose 0 -- truthful enough since
  // the loop runs every 1s. Reserved for the doctor surface.
  oldestUnreadFileAgeSec: number;
  // Writer-election state. 'this' means we own the indexer.lock and are the
  // sole writer; 'other' means another agent-monitor process holds it and
  // we're running read-only; 'none' means no live writer claimed it yet.
  writer: 'this' | 'other' | 'none';
}

export interface AmbientOptions {
  drainIntervalMs?: number;       // default 1000
  reconcileIntervalMs?: number;   // default 8000
  onStatus?: (s: AmbientStatus) => void;
  // Test seams: inject alternate drain / reconcile callables. Production
  // code never sets these -- they default to the real implementations.
  drainFn?: () => Promise<DrainStats>;
  procDiscoveryFn?: () => Promise<ProcDiscoveryStats>;
  reconcileFn?: () => Promise<ReconcileStats>;
  // Skip the writer-lock check (used by tests to exercise the drain logic
  // without touching the real ~/.local/state/agent-monitor/indexer.lock).
  bypassWriterLock?: boolean;
}

export interface AmbientHandle {
  stop(): Promise<void>;
}

// Build a fresh empty status (called once at startup so onStatus consumers
// can render their footer immediately, even before the first tick lands).
function emptyStatus(): AmbientStatus {
  return {
    lastDrainAt: null,
    lastDrainStats: null,
    lastReconcileAt: null,
    lastReconcileStats: null,
    lastError: null,
    drainBacklogLines: 0,
    oldestUnreadFileAgeSec: 0,
    writer: 'none',
  };
}

export function startAmbientIndexer(opts: AmbientOptions = {}): AmbientHandle {
  const drainEvery = opts.drainIntervalMs ?? 1000;
  const reconcileEvery = opts.reconcileIntervalMs ?? 8000;
  const onStatus = opts.onStatus;
  const drain = opts.drainFn ?? defaultDrainOnce;
  const procDiscovery = opts.procDiscoveryFn ?? defaultDiscoverProcSessionsOnce;
  const reconcile = opts.reconcileFn ?? defaultRunReconcileOnce;
  const bypassLock = opts.bypassWriterLock ?? false;

  const status: AmbientStatus = emptyStatus();

  // Cheap helper: clone the status before handing it out so consumers can't
  // mutate our internal record. The footer reads a few fields; the cost is
  // negligible.
  const emit = (): void => {
    if (!onStatus) return;
    try {
      onStatus({ ...status });
    } catch (err) {
      // Failing onStatus should never disrupt indexing.
      logError('ambient: onStatus threw', err);
    }
  };

  // In-flight guards. If a previous drain/reconcile is still running, the
  // next tick is a no-op.
  let drainRunning = false;
  let reconcileRunning = false;
  let stopped = false;

  // Track the in-flight promises so stop() can await them rather than yanking
  // the DB out from under a mid-flight write.
  let drainPromise: Promise<void> | null = null;
  let reconcilePromise: Promise<void> | null = null;

  // Periodically attempt to claim the writer lock. If we get it, drain +
  // reconcile do real work; otherwise we tick along as a read-only TUI and
  // let the other process do the writing.
  function refreshWriterStatus(): void {
    if (bypassLock) {
      status.writer = 'this';
      return;
    }
    const got = tryAcquireWriter();
    status.writer = got ? 'this' : getWriterStatus();
  }

  async function tickDrain(): Promise<void> {
    if (stopped || drainRunning) return;
    refreshWriterStatus();
    drainRunning = true;
    const p = (async () => {
      try {
        if (status.writer !== 'this') {
          // Another TUI is the writer. Skip — its drain covers the spool.
          return;
        }
        const s = await drain();
        await procDiscovery();
        status.lastDrainAt = Date.now();
        status.lastDrainStats = s;
        status.drainBacklogLines = s.linesIngested;
        if (status.lastError?.source === 'drain') status.lastError = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.lastError = { source: 'drain', message, at: Date.now() };
        logError('ambient drain', err);
      } finally {
        drainRunning = false;
        emit();
      }
    })();
    drainPromise = p;
    return p;
  }

  async function tickReconcile(): Promise<void> {
    if (stopped || reconcileRunning) return;
    reconcileRunning = true;
    const p = (async () => {
      try {
        if (status.writer !== 'this') {
          // Read-only mode; reconcile is the writer's job.
          return;
        }
        const s = await reconcile();
        status.lastReconcileAt = Date.now();
        status.lastReconcileStats = s;
        if (status.lastError?.source === 'reconcile') status.lastError = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.lastError = { source: 'reconcile', message, at: Date.now() };
        logError('ambient reconcile', err);
      } finally {
        reconcileRunning = false;
        emit();
      }
    })();
    reconcilePromise = p;
    return p;
  }

  // Kick off an immediate first pass so the TUI has fresh data on tick 0
  // rather than waiting drainEvery ms for the first event.
  void tickDrain();

  const drainTimer = setInterval(() => {
    void tickDrain();
  }, drainEvery);

  const reconcileTimer = setInterval(() => {
    void tickReconcile();
  }, reconcileEvery);

  // Emit an initial empty status so the footer renders on first paint.
  emit();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(drainTimer);
      clearInterval(reconcileTimer);
      // Wait for any in-flight pass to finish so we don't close the DB while
      // it's mid-write.
      await Promise.allSettled([drainPromise, reconcilePromise]);
      // Release the writer lock so another TUI can claim it on next try.
      if (!bypassLock) releaseWriter();
    },
  };
}
