// Bordered session card (v1.1 default density). One per session.
//
// Layout (5 lines including border):
//   ╭─ Claude · opus-4.7 · projects/tui ─────────── 00:02 ─╮
//   │ ⠴ RUNNING TOOL · Bash                       7 turns  │
//   │   "let me push the commit and verify..."             │
//   ╰──────────────────────────────────────────────────────╯
//
// Why hand-drawn borders rather than Ink's <Box borderStyle>: we want the
// header (provider/model/cwd, freshness) embedded inside the top border line.
// Ink's borderStyle paints a uniform border — it doesn't support inline
// captions. So we render each line as a <Text> with explicit box characters.
//
// Focus marker: when focused, we use the `bold` cli-boxes glyph set
// (┏━┓ / ┗━┛) instead of `round`. The border colour stays the state colour.
// On terminals that render bold drawing chars poorly, the heavier glyphs are
// still distinguishable from the rounded ones.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import path from 'node:path';
import type { SessionRow, SessionState } from '../types.ts';

// Display state -> border colour. Matches the design table; deliberately
// duplicates the older SessionCell map so the row-density renderer is
// untouched.
const STATE_COLOR: Record<string, string> = {
  permission: 'red',
  tool: 'cyan',
  thinking: 'green',
  waiting: 'yellow',
  idle: 'gray',
  stale: 'gray',
  done: 'gray',
  // Fallbacks for states we don't expect at render time.
  dead: 'red',
  recovered: 'blue',
};

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
};

// --- helpers ---------------------------------------------------------------

function shortCwd(cwd: string | null): string {
  if (!cwd) return '?';
  const parts = cwd.split(path.sep).filter(Boolean);
  if (parts.length === 0) return cwd;
  if (parts.length === 1) return parts[0]!;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// Some Claude models carry a `[1m]` (1M-context) suffix in their ID. Visually
// `[1m]` reads as a leaked ANSI bold escape; strip it for display.
function shortModel(model: string | null): string {
  if (!model) return '?';
  return model.replace(/\[\d+m\]\s*$/, '').trim();
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
  const d = Math.floor(dSec / 86_400);
  return `${d}d`;
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  if (max <= 1) return flat.slice(0, max);
  return flat.slice(0, max - 1) + '…';
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
    case 'dead':
      return 'DEAD';
    case 'recovered':
      return 'RECOVERED';
    default:
      return String(state).toUpperCase();
  }
}

// Box-drawing glyphs for the two focus modes. We hand-draw the borders
// because Ink's <Box borderStyle> doesn't allow inline captions.
//
// Four sets: regular vs subagent, each in unfocused (round/dash) and focused
// (bold). Subagent cards use light dashed strokes so they're visually
// distinct from main sessions even at a glance — `┄ ┆` instead of `─ │`.
interface Glyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
}
const ROUND: Glyphs = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
const BOLD: Glyphs = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' };
const SUB_ROUND: Glyphs = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '┄', v: '┆' };
const SUB_BOLD: Glyphs = { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '┅', v: '┇' };

function isSubagent(transcriptPath: string | null): boolean {
  return transcriptPath ? transcriptPath.includes('/subagents/') : false;
}

function parentSidFromPath(transcriptPath: string | null): string | null {
  const m = transcriptPath?.match(/\/([0-9a-f-]{36})\/subagents\/agent-/);
  return m ? m[1]!.slice(0, 8) : null;
}

function contextPct(cell: SessionRow): number | null {
  const used = cell.context_tokens_used;
  const max = cell.context_tokens_max;
  if (used == null || max == null || max <= 0) return null;
  return Math.min(99, Math.floor((used / max) * 100));
}

// --- component -------------------------------------------------------------

export interface SessionCardProps {
  cell: SessionRow;
  width: number;
  focused: boolean;
  nowMs: number;
  turns?: number;
  subagentsActive?: number;
  subagentsTotal?: number;
}

export const SessionCard = React.memo(
  function SessionCard({
    cell,
    width,
    focused,
    nowMs,
    turns = 0,
    subagentsActive = 0,
    subagentsTotal = 0,
  }: SessionCardProps): React.ReactElement {
    const state = cell.state;
    const color = STATE_COLOR[state] ?? 'white';
    const dim = state === 'idle' || state === 'stale' || state === 'done';
    const showSpinner = state === 'tool' || state === 'thinking';
    const isSub = isSubagent(cell.transcript_path);
    const glyphs = focused
      ? isSub ? SUB_BOLD : BOLD
      : isSub ? SUB_ROUND : ROUND;
    const innerWidth = Math.max(10, width - 2); // characters between │ │

    // --- top border: ╭─ <provider · model · cwd> ─── <freshness> ─╮ ---
    const provider = PROVIDER_LABEL[cell.provider] ?? cell.provider;
    const model = shortModel(cell.model);
    const cwd = shortCwd(cell.cwd);
    const freshness = fmtFreshness(cell.last_event_at_ms, nowMs);

    // Reserve: "─ " before title (2) + " ─" after (2) + "─ " before fresh (2)
    // + " ─" tail before corner (2) + corners eaten separately. We have
    // innerWidth chars of space between corners; we draw that as
    //   "─ <title> " + filler + " <fresh> ─"
    // so the total is innerWidth.
    const tailLen = freshness.length + 4; // " " + freshness + " ─"
    const titleMax = Math.max(3, innerWidth - tailLen - 3); // "─ " title " "
    const title = truncate(`${provider} · ${model} · ${cwd}`, titleMax);
    const middleFill = innerWidth - 2 /* "─ " */ - title.length - 1 /* " " before tail */ - 1 /* " " before fresh */ - freshness.length - 2 /* " ─" */;
    const filler = glyphs.h.repeat(Math.max(1, middleFill));
    const topLine = `${glyphs.tl}${glyphs.h} ${title} ${filler} ${freshness} ${glyphs.h}${glyphs.tr}`;

    // --- line 2: state line --- (left: spinner+state+tool, right: turns)
    // Progress hint: turn count + active subagent count. Lifetime total is
    // not shown — the user only cares which subagents are working *now*.
    const subsLabel = subagentsActive > 0 ? `${subagentsActive} subs` : '';
    void subagentsTotal; // kept on the prop for possible future detail-view use
    const progressText =
      turns > 0
        ? subsLabel
          ? `${turns}t · ${subsLabel}`
          : `${turns}t`
        : '';
    const pct = contextPct(cell);
    const ctxText = pct == null ? '' : `${progressText ? ' · ' : ''}ctx ${pct}%`;
    const progressWidth = progressText.length + ctxText.length;
    const stateText = stateLabel(state, cell.current_tool);

    // line 2 layout (between │ and │):
    //   1 (edge pad left) + 2 (spinner col) + state + line2Pad + turns + 1 (edge pad right) = innerWidth
    // turnsText is rendered as-is (no trailing space). Both edges get an
    // explicit 1-char pad so the right border aligns with line 3 and the
    // bottom border regardless of whether turns is shown.
    const stateBudget = innerWidth - 4 /* both edge pads + spinner col */ - progressWidth;
    const stateRendered = truncate(stateText, Math.max(3, stateBudget));
    const line2Pad = Math.max(
      0,
      innerWidth - 4 - stateRendered.length - progressWidth,
    );

    // --- line 3: prompt preview ---
    // Layout: 1 (edge pad left) + 2 (↳ prefix or spaces) + promptText + line3Right + 1 (edge pad right) = innerWidth
    const promptRaw = cell.last_prompt ?? '';
    const promptBudget = innerWidth - 4; // both edge pads + 2-char prefix
    const promptText = promptRaw ? truncate(promptRaw, promptBudget) : '';
    const line3Right = ' '.repeat(Math.max(0, innerWidth - 4 - promptText.length));

    // --- bottom border with session_id right-aligned ---
    // Format: ╰─────...── sid:ABCDEF12 ──╯
    // Inner width (between bl and br) = h*sidPad + ' ' + sidLabel + ' ' + h*2
    // so sidPad = innerWidth - 4 - sidLabel.length, fills from the LEFT.
    const sidShort = cell.session_id ? cell.session_id.slice(0, 8) : '?';
    const sidLabel = `sid:${sidShort}`;
    const sidPad = Math.max(1, innerWidth - 4 - sidLabel.length);
    const defaultBottomLine = `${glyphs.bl}${glyphs.h.repeat(sidPad)} ${sidLabel} ${glyphs.h.repeat(2)}${glyphs.br}`;
    const parentSid = isSub ? parentSidFromPath(cell.transcript_path) : null;
    const parentPrefix = parentSid ? `${glyphs.h.repeat(2)} ↳ ${parentSid} ` : '';
    const parentPad = parentSid
      ? innerWidth - parentPrefix.length - 1 - sidLabel.length - 1 - 2
      : -1;
    const bottomLine =
      parentSid && parentPad >= 1
        ? `${glyphs.bl}${parentPrefix}${glyphs.h.repeat(parentPad)} ${sidLabel} ${glyphs.h.repeat(2)}${glyphs.br}`
        : defaultBottomLine;
    const ctxColor = pct == null ? undefined : pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : undefined;
    const ctxBold = pct != null && pct >= 85;

    return (
      <Box flexDirection="column" width={width} marginRight={1}>
        {/* top border with embedded title + freshness */}
        <Text color={color} bold={focused} dimColor={dim}>{topLine}</Text>

        {/* state line */}
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
          <Text>{' '.repeat(line2Pad)}</Text>
          {progressText ? <Text dimColor>{progressText}</Text> : null}
          {ctxText ? (
            <Text color={ctxColor} bold={ctxBold} dimColor={pct != null && pct < 60}>
              {ctxText}
            </Text>
          ) : null}
          <Text> </Text>
          <Text color={color} bold={focused} dimColor={dim}>{glyphs.v}</Text>
        </Box>

        {/* prompt preview line */}
        <Box>
          <Text color={color} bold={focused} dimColor={dim}>{glyphs.v}</Text>
          <Text> </Text>
          {promptText ? (
            <>
              <Text dimColor>↳ </Text>
              <Text>{promptText}</Text>
            </>
          ) : (
            <Text>  </Text>
          )}
          <Text>{line3Right}</Text>
          <Text> </Text>
          <Text color={color} bold={focused} dimColor={dim}>{glyphs.v}</Text>
        </Box>

        {/* bottom border */}
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
    // We bucket nowMs so a 200ms tick doesn't bust memo on every render.
    Math.floor(prev.nowMs / 1000) === Math.floor(next.nowMs / 1000),
);
