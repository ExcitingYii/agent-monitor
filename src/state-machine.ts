// Pure state-machine. Given the existing session row and the next normalized
// event, compute ONLY the fields that change. The caller (reducer / spool)
// merges the patch into the session upsert.
//
// State diagram (from plan):
//
//   waiting --user_prompt--> thinking
//   thinking --tool_call_start--> tool(<name>)
//   tool --tool_call_end--> thinking
//   * --turn_complete--> waiting
//   * --session_stop--> done
//   active --permission_request--> permission (saves prior_state)
//   permission --escape_event--> prior_state
//   session_resume --> recovered (until next known-kind event resolves it)
//
//   Liveness-derived states (idle/stale/dead) are NOT computed here -- that
//   lives in src/liveness.ts (M6). This module only handles event-driven
//   transitions.

import type {
  NormalizedEvent,
  NormalizedEventKind,
  SessionRow,
  SessionState,
} from './types.ts';

// Events that can pop a session out of `permission`. Anything else (including
// payload-only events we don't recognize) leaves it stuck on permission, which
// is the desired conservative behavior -- we don't want random `user_attention`
// pings to silently resume an action the user hasn't actually approved.
const ESCAPE_EVENTS: ReadonlySet<NormalizedEventKind> = new Set<NormalizedEventKind>([
  'tool_call_start',
  'tool_call_end',
  'turn_complete',
  'user_prompt',
  'session_stop',
]);

// Sentinel "previous row" for the very first event of a session. We never
// write this to the DB -- the caller fills started_at_ms etc. from the event.
export const INITIAL_STATE: SessionState = 'waiting';

export interface StatePatch {
  state?: SessionState;
  prior_state?: SessionState | null;
  current_tool?: string | null;
  last_prompt?: string | null;
}

// Truncate a prompt for display. The plan says "truncated last user prompt";
// we cap at 200 chars and squash whitespace so it fits a one-line cell.
function summarizePrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat;
}

// Compute the next state patch. Returns ONLY changed fields so the caller can
// distinguish "explicit null" (clear current_tool when leaving tool) from
// "untouched" (don't overwrite a prior cwd we already learned).
//
// `prev` may be null for a brand-new session -- we treat that as `waiting` so
// the same transition table works on first event.
export function nextState(
  prev: SessionRow | null,
  event: NormalizedEvent,
): StatePatch {
  const prevState: SessionState = prev?.state ?? INITIAL_STATE;
  const toolName = event.meta?.tool_name ?? null;

  switch (event.kind) {
    case 'session_start': {
      // Brand new session lands in `waiting`. If it's already known, treat as
      // a no-op state-wise (a duplicate SessionStart hook shouldn't reset us).
      if (!prev) return { state: 'waiting' };
      return {};
    }

    case 'session_resume': {
      // We saw activity for a session whose start we missed. Park in
      // `recovered` until the next known-kind event tells us where it actually
      // is in the lifecycle.
      return { state: 'recovered', prior_state: null, current_tool: null };
    }

    case 'user_prompt': {
      const patch: StatePatch = { state: 'thinking', current_tool: null };
      if (event.meta?.user_prompt) {
        patch.last_prompt = summarizePrompt(event.meta.user_prompt);
      }
      patch.prior_state = null;
      return patch;
    }

    case 'tool_call_start': {
      if (prevState === 'permission') {
        return {
          state: 'tool',
          current_tool: toolName,
          prior_state: null,
        };
      }
      return {
        state: 'tool',
        current_tool: toolName,
      };
    }

    case 'tool_call_end': {
      if (prevState === 'permission') {
        return { state: 'thinking', current_tool: null, prior_state: null };
      }
      return {
        state: 'thinking',
        current_tool: null,
      };
    }

    case 'permission_request': {
      // Save where we were so we can return to it. Don't overwrite prior_state
      // if we're already on permission (back-to-back prompts shouldn't cause
      // prior_state to forget the original active state).
      if (prevState === 'permission') return {};
      return {
        state: 'permission',
        prior_state: prevState,
        // current_tool stays as-is: we may resume into the same tool.
      };
    }

    case 'user_attention': {
      // Per the plan: user_attention does NOT force the permission state.
      // Leave the session alone.
      return {};
    }

    case 'turn_complete': {
      if (prevState === 'permission') {
        return { state: 'waiting', prior_state: null, current_tool: null };
      }
      return {
        state: 'waiting',
        current_tool: null,
      };
    }

    case 'session_stop': {
      return {
        state: 'done',
        prior_state: null,
        current_tool: null,
      };
    }

    default: {
      const _exhaustive: never = event.kind;
      void _exhaustive;
      return {};
    }
  }
}
