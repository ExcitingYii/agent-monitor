// React.memo'd grid cell. One per session.
//
// Layout (fixed width, e.g. 30 chars):
//   [C] short-cwd            STATE  current_tool/last_prompt
//
// While `state === 'thinking' | 'tool'` we replace the leading "[X]" badge
// with a spinner so the cell visibly updates even when nothing else changes.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import path from 'node:path';
import type { SessionRow } from '../types.ts';

const PROVIDER_ICON: Record<string, string> = { claude: 'C', codex: 'X', agy: 'A' };
const STATE_COLOR: Record<string, string> = {
  thinking: 'cyan',
  tool: 'yellow',
  permission: 'magenta',
  waiting: 'gray',
  idle: 'gray',
  done: 'green',
  stale: 'red',
  dead: 'red',
  recovered: 'blue',
};

function shortCwd(cwd: string | null): string {
  if (!cwd) return '?';
  // Last two segments — "tui/src" reads better than "src" alone.
  const parts = cwd.split(path.sep).filter(Boolean);
  if (parts.length === 0) return cwd;
  if (parts.length === 1) return parts[0]!;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

function truncate(s: string | null | undefined, w: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= w) return flat;
  return flat.slice(0, Math.max(0, w - 1)) + '…';
}

export interface SessionCellProps {
  cell: SessionRow;
  width: number;
  focused: boolean;
}

export const SessionCell = React.memo(
  function SessionCell({ cell, width, focused }: SessionCellProps) {
    const icon = PROVIDER_ICON[cell.provider] ?? '?';
    const color = STATE_COLOR[cell.state] ?? 'white';
    const cwd = pad(shortCwd(cell.cwd), 16);
    const stateLabel = pad(cell.state.slice(0, 4), 4);

    // Show current_tool when in tool state, otherwise truncate last_prompt.
    const tail =
      cell.state === 'tool' && cell.current_tool
        ? cell.current_tool
        : cell.state === 'permission' && cell.current_tool
          ? `permit:${cell.current_tool}`
          : (cell.last_prompt ?? '');

    // Reserve: focus marker (2) + icon-or-spinner (2) + space + cwd (16) + space + state (4) + space
    const fixedPrefix = 2 + 2 + 1 + 16 + 1 + 4 + 1;
    const tailWidth = Math.max(2, width - fixedPrefix);
    const tailText = truncate(tail, tailWidth);

    const focusMarker = focused ? '> ' : '  ';
    const showSpinner = cell.state === 'thinking' || cell.state === 'tool';
    // Idle cells visually fade — they're alive but not actively working, so
    // they shouldn't compete with active cells for attention.
    const dim = cell.state === 'idle';

    return (
      <Box width={width}>
        <Text color={focused ? 'white' : undefined} inverse={focused}>
          {focusMarker}
        </Text>
        {showSpinner ? (
          <Text color={color}>
            <Spinner type="dots" />
            <Text> </Text>
          </Text>
        ) : (
          <Text color={color} dimColor={dim}>{icon} </Text>
        )}
        <Text dimColor>{cwd} </Text>
        <Text color={color} bold dimColor={dim}>
          {stateLabel}{' '}
        </Text>
        <Text dimColor={dim}>{tailText}</Text>
      </Box>
    );
  },
  (prev, next) =>
    prev.width === next.width &&
    prev.focused === next.focused &&
    prev.cell === next.cell, // ref equality is sufficient — store guarantees stability
);
