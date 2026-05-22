// Compact bordered cell (1 content line + 2 border lines = 3 lines total).
//
// Layout target:
//   ┌─ Claude · projects/tui · 00:02 ─────────────┐
//   │ ⠴ RUNNING TOOL · Bash · 7t                  │
//   └─────────────────────────────────────────────┘
//
// Hand-drawn for the same reason as SessionCard: we want the header inline
// in the top border. Focus uses the bold-glyph border set.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import path from 'node:path';
import type { SessionRow, SessionState } from '../types.ts';

const STATE_COLOR: Record<string, string> = {
  permission: 'red',
  tool: 'cyan',
  thinking: 'green',
  waiting: 'yellow',
  idle: 'gray',
  stale: 'gray',
  done: 'gray',
  dead: 'red',
  recovered: 'blue',
};

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
};

function shortCwd(cwd: string | null): string {
  if (!cwd) return '?';
  const parts = cwd.split(path.sep).filter(Boolean);
  if (parts.length === 0) return cwd;
  if (parts.length === 1) return parts[0]!;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function fmtFreshness(lastEventMs: number, nowMs: number): string {
  const dSec = Math.max(0, Math.floor((nowMs - lastEventMs) / 1000));
  if (dSec < 3600) {
    const mm = Math.floor(dSec / 60).toString().padStart(2, '0');
    const ss = (dSec % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }
  if (dSec < 86_400) {
    const h = Math.floor(dSec / 3600);
    const m = Math.floor((dSec % 3600) / 60);
    return `${h}h${m.toString().padStart(2, '0')}`;
  }
  return `${Math.floor(dSec / 86_400)}d`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

function stateLabel(state: SessionState, currentTool: string | null): string {
  switch (state) {
    case 'permission':
      return currentTool ? `⚠ NEEDS PERMISSION · ${currentTool}` : '⚠ NEEDS PERMISSION';
    case 'tool':
      return currentTool ? `RUNNING TOOL · ${currentTool}` : 'RUNNING TOOL';
    case 'thinking':
      return 'THINKING';
    case 'waiting':
      return 'WAITING FOR INPUT';
    case 'idle':
      return 'IDLE';
    case 'stale':
      return 'STALE';
    case 'done':
      return 'DONE';
    default:
      return String(state).toUpperCase();
  }
}

interface Glyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
}
const SINGLE: Glyphs = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
const BOLD: Glyphs = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' };
const SUB_SINGLE: Glyphs = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '┄', v: '┆' };
const SUB_BOLD: Glyphs = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '┅', v: '┇' };

function isSubagent(transcriptPath: string | null): boolean {
  return transcriptPath ? transcriptPath.includes('/subagents/') : false;
}

function contextPct(cell: SessionRow): number | null {
  const used = cell.context_tokens_used;
  const max = cell.context_tokens_max;
  if (used == null || max == null || max <= 0) return null;
  return Math.min(99, Math.floor((used / max) * 100));
}

export interface SessionCompactProps {
  cell: SessionRow;
  width: number;
  focused: boolean;
  nowMs: number;
  turns?: number;
  subagentsActive?: number;
  subagentsTotal?: number;
}

export const SessionCompact = React.memo(
  function SessionCompact({
    cell,
    width,
    focused,
    nowMs,
    turns = 0,
    subagentsActive = 0,
    subagentsTotal = 0,
  }: SessionCompactProps): React.ReactElement {
    const state = cell.state;
    const color = STATE_COLOR[state] ?? 'white';
    const dim = state === 'idle' || state === 'stale' || state === 'done';
    const showSpinner = state === 'tool' || state === 'thinking';
    const isSub = isSubagent(cell.transcript_path);
    const glyphs = focused
      ? isSub ? SUB_BOLD : BOLD
      : isSub ? SUB_SINGLE : SINGLE;
    const innerWidth = Math.max(10, width - 2);

    // --- top border: ┌─ <Provider · cwd · freshness> ────┐ ---
    const provider = PROVIDER_LABEL[cell.provider] ?? cell.provider;
    const cwd = shortCwd(cell.cwd);
    const freshness = fmtFreshness(cell.last_event_at_ms, nowMs);
    const titleMax = Math.max(3, innerWidth - 5);
    const title = truncate(`${provider} · ${cwd} · ${freshness}`, titleMax);
    const fillCount = innerWidth - 2 /* "─ " */ - title.length - 1 /* " " */;
    const fill = glyphs.h.repeat(Math.max(1, fillCount));
    const topLine = `${glyphs.tl}${glyphs.h} ${title} ${fill}${glyphs.tr}`;

    // --- content line: spinner + state + (turns / subagents on right) ---
    // Layout (between │ and │):
    //   1 edge_left + 2 spinner + state + padRight + turnsText + 1 edge_right = innerWidth
    const stateText = stateLabel(state, cell.current_tool);
    const subsLabel = subagentsActive > 0 ? `${subagentsActive} subs` : '';
    void subagentsTotal; // kept on the prop for possible future detail-view use
    const progressText =
      turns > 0
        ? subsLabel
          ? `${turns}t · ${subsLabel}`
          : `${turns}t`
        : '';
    const pct = contextPct(cell);
    const rawCtxText = pct == null ? '' : `${progressText ? ' · ' : ''}ctx ${pct}%`;
    const canFitCtx = rawCtxText
      ? innerWidth - 4 - progressText.length - rawCtxText.length >= 8
      : false;
    const ctxText = canFitCtx ? rawCtxText : '';
    const progressWidth = progressText.length + ctxText.length;
    const stateBudget = innerWidth - 4 /* both edges + spinner */ - progressWidth;
    const stateRendered = truncate(stateText, Math.max(3, stateBudget));
    const padRight = Math.max(
      0,
      innerWidth - 4 - stateRendered.length - progressWidth,
    );

    // --- bottom border ---
    const bottomLine = `${glyphs.bl}${glyphs.h.repeat(innerWidth)}${glyphs.br}`;
    const ctxColor = pct == null ? undefined : pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : undefined;
    const ctxBold = pct != null && pct >= 85;

    return (
      <Box flexDirection="column" width={width} marginRight={1}>
        <Text color={color} bold={focused} dimColor={dim}>{topLine}</Text>
        <Box>
          <Text color={color} bold={focused} dimColor={dim}>{glyphs.v}</Text>
          <Text> </Text>
          {showSpinner ? (
            <Text color={color}>
              <Spinner type="dots" />
              <Text> </Text>
            </Text>
          ) : (
            <Text>  </Text>
          )}
          <Text color={color} bold={state === 'permission'} dimColor={dim}>{stateRendered}</Text>
          <Text>{' '.repeat(padRight)}</Text>
          {progressText ? <Text dimColor>{progressText}</Text> : null}
          {ctxText ? (
            <Text color={ctxColor} bold={ctxBold} dimColor={pct != null && pct < 60}>
              {ctxText}
            </Text>
          ) : null}
          <Text> </Text>
          <Text color={color} bold={focused} dimColor={dim}>{glyphs.v}</Text>
        </Box>
        <Text color={color} bold={focused} dimColor={dim}>{bottomLine}</Text>
      </Box>
    );
  },
  (prev, next) =>
    prev.width === next.width &&
    prev.focused === next.focused &&
    prev.cell === next.cell &&
    prev.turns === next.turns &&
    prev.subagentsActive === next.subagentsActive &&
    prev.subagentsTotal === next.subagentsTotal &&
    Math.floor(prev.nowMs / 1000) === Math.floor(next.nowMs / 1000),
);
