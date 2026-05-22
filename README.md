# agent-monitor

A Linux TUI that watches every running `claude`, `codex`, and `agy` CLI session on your machine — like `htop` for AI agent sessions. Hooks write per-session events to a spool; an indexer drains them into SQLite; the TUI renders a live grid.

```
agent-monitor · 0 needs you · ⏵ 3 waiting · 1 working · 0 idle · density=card
[?]help [d]ensity [a]ll [m]cp [c]opy-resume [/]filter [r]econcile [enter]detail [q]uit
idx: lastDrain=1s ago · backlog=0 · writer=this · last=OK

/home/jack/projects/tui
┏━ Claude · claude-opus-4-7 · projects/tui ━━━━━━━━━━━━━━━━━━━━━━━━ 01:35 ━┓
┃ ⠏ THINKING                                                 11t · ctx 21% ┃
┃ ↳ yes go - workout a clean precise concise direct readme                 ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ sid:bbee02e9 ━━┛
```

## Quick Start

```bash
git clone git@github.com:Acid3croco/agent-monitor.git
cd agent-monitor
./install.sh
agent-monitor tui
```

`install.sh` shows you a unified diff for every settings/hooks file it would touch and asks before applying. Two filesystem-only steps don't have prompts (the `~/.local/bin/agent-monitor` symlink and the one-line `hooks = true` flag in `config.toml`); both are tiny and reversible.

Pass `--yes` to auto-accept every diff (CI / scripted). Diffs still print to stdout so you can audit the log. Pass `--help` to see exactly what it touches.

If `agent-monitor tui` reports "command not found", `~/.local/bin` isn't on your `PATH`. Either add it (`export PATH="$HOME/.local/bin:$PATH"` in your shell rc) or run `bun run src/cli.ts tui` from the clone.

## What it touches on your system

| Path | What |
|---|---|
| `~/.claude/settings.json` | Hook entries merged in. Backup left as `.bak.<utc-iso>`. Existing keys/hooks preserved. |
| `~/.codex/hooks.json` | Hook entries merged. Same backup convention. |
| `~/.codex/config.toml` | Sets `[features] hooks = true`. Backup left. |
| `~/.gemini/config/hooks.json` | Hook entries merged. Same backup convention. |
| `~/.local/share/agent-monitor/hooks/` | The hook scripts the hook commands invoke. |
| `~/.local/bin/agent-monitor` | Symlink to `bin/agent-monitor` in this clone. |
| `~/.local/state/agent-monitor/` | SQLite `events.db`, JSONL spool, `tui.log`. Created on first event. |

The installer only writes these paths. Uninstall removes the Claude hook entries automatically; everything else is a one-line `rm` (see [Uninstall](#uninstall)).

## Requirements

- Linux (uses `/proc`, `sha1sum`, `date +%s%3N`)
- [Bun](https://bun.sh) ≥ 1.3
- `jq` (hook scripts use it for session-id extraction)
- [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex) ≥ 0.125, and/or `agy`

## How it works

```
┌──────────────────┐    ┌──────────────────┐
│ Claude Code hook │    │ Codex/Agy hook   │   shell scripts that
│  (shell script)  │    │  (shell script)  │   append one JSON line
└────────┬─────────┘    └────────┬─────────┘   per agent event
         │                       │
         ▼                       ▼
   ~/.local/state/agent-monitor/spool/<provider>/<session_hash>/YYYYMMDD.jsonl
         │
         │      (also: rollout reconciler tails ~/.claude/projects/
         │       and ~/.codex/sessions/ for sessions that started
         │       before the hooks were installed)
         ▼
   ┌────────────┐
   │  Indexer   │  drains spool + rollouts into SQLite
   └─────┬──────┘
         ▼
   ~/.local/state/agent-monitor/events.db   (WAL mode)
         ▲
         │
   ┌─────┴──────┐
   │   TUI      │  reads SQLite at 200 ms tick, renders grid
   └────────────┘
```

Hooks fire on every agent lifecycle event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`/`PermissionRequest`, `Stop`). Each is a small shell script that fails open — telemetry loss is acceptable, agent latency is not.

The reconciler tails the providers' own rollout JSONL files so sessions that started *before* the hooks were installed still show up. Both signal sources land in the same SQLite, deduped by `(source_path, source_offset)`.

A single TUI instance owns the writer lock (`indexer.lock`); other TUIs run read-only. Drain runs every ~1 s, reconcile every ~8 s, both inside the writer TUI.

## Reference

### Keybindings

| Key | Action |
|---|---|
| `j` `k` `h` `l` (or arrows) | Move focus |
| `gg` / `G` | Jump to first / last cell |
| `Ctrl-D` / `Ctrl-U` | Half-page scroll |
| `enter` | Open detail view |
| `esc` | Back to grid / exit filter mode |
| `/` | Filter (cwd, state, tool, model, prompt) |
| `a` | Toggle hidden (`done`) sessions. (`idle` stays visible, dimmed.) |
| `m` | Toggle MCP-spawned codex sessions |
| `c` | Copy ` --resume <sid>` to clipboard (OSC 52 + fallback file) |
| `d` | Cycle density (card → compact → row) |
| `r` | Force a one-pass reconcile |
| `?` | Help overlay |
| `q` / Ctrl-C | Quit |

### State semantics

| State | Meaning |
|---|---|
| `permission` | Awaiting your approval for a tool call. Status bar: **needs you** (red). |
| `waiting` | Turn finished; agent is waiting for your next prompt. Status bar: **waiting** (yellow). |
| `thinking` | Model is generating. |
| `tool` | Agent is executing a tool; cell shows the tool name. |
| `idle` | No events for 60+ minutes; agent still alive. Dimmed in the grid. |
| `done` | Process gone — `/proc`-based liveness check (Claude lock fd, Codex rollout fd, plus `--resume <sid>` in cmdline). Hidden by default; press `a` to show. |

For fresh sessions whose `.lock` fd hasn't been opened yet (Claude creates it lazily on the first TodoWrite — empirically up to ~90 s after `SessionStart`), a 120 s event-freshness grace keeps the row visible.

### CLI

```bash
agent-monitor tui                       # open the dashboard
agent-monitor doctor                    # system status (DB, spool, rollouts, hooks)
agent-monitor reconcile                 # one-pass scan of providers' rollout files
agent-monitor compact                   # drop events older than 7 days
agent-monitor rotate-spool              # delete fully-ingested spool files older than 3 days
agent-monitor install-hooks             # interactive Claude hook install (re-run safely)
agent-monitor install-hooks --uninstall # remove our entries from ~/.claude/settings.json
```

### File layout

| Path | Purpose |
|---|---|
| `~/.local/state/agent-monitor/events.db` | SQLite event store (WAL mode) |
| `~/.local/state/agent-monitor/spool/<provider>/<sha1>/YYYYMMDD.jsonl` | Per-session hook spool |
| `~/.local/state/agent-monitor/indexer.lock` | Single-writer election lock |
| `~/.local/state/agent-monitor/tui.log` | TUI log (never goes to stdout) |
| `~/.local/share/agent-monitor/hooks/{claude,codex,agy}-hook.sh` | Installed hook scripts |
| `~/.claude/settings.json` | Modified to register Claude hooks (with backup) |
| `~/.codex/hooks.json` | Modified to register Codex hooks (with backup) |
| `~/.codex/config.toml` | `[features] hooks = true` ensured |
| `~/.gemini/config/hooks.json` | Modified to register Agy hooks (with backup) |

The hook scripts append to JSONL spool files at sub-millisecond cost. The writer-elected indexer drains the spool every ~1 s and reconciles rollouts every ~8 s.

### Uninstall

```bash
agent-monitor install-hooks --uninstall   # remove our entries from ~/.claude/settings.json
# ~/.codex/hooks.json — open the file and delete entries whose `command` contains
#   ~/.local/share/agent-monitor/hooks/ (the file may be shared with other tools).
# ~/.codex/config.toml — remove `hooks = true` under [features] if you want.
# ~/.gemini/config/hooks.json — delete entries whose `command` contains
#   ~/.local/share/agent-monitor/hooks/ (the file may be shared with other tools).
rm -rf ~/.local/state/agent-monitor       # data: events.db, spool, tui.log
rm -rf ~/.local/share/agent-monitor       # deployed hook scripts
rm ~/.local/bin/agent-monitor             # PATH symlink
```

The Claude uninstall preserves any non-agent-monitor hooks you added independently. Backups (`*.bak.*`) from every install run are left in place — delete manually if you don't want them.

### Troubleshooting

- **No sessions after install.** Sessions started *before* the hook install have no `SessionStart` event but the reconciler picks them up within ~10 s of opening the TUI. If nothing shows: `agent-monitor reconcile`.
- **Sessions stuck in `tool` state.** A `PostToolUse` hook didn't fire (e.g. agent crashed mid-tool). They flip to `done` as soon as `/proc` stops proving the process alive *and* the 120 s event-freshness grace expires.
- **`jq: command not found`** in spool data. Install jq. The hook falls back to a sed parser but jq is more reliable.
- **Hook fires don't appear.** Check the `hooks` block in `~/.claude/settings.json`, `~/.codex/hooks.json`, or `~/.gemini/config/hooks.json`. Re-run `./install.sh` if missing.
- **`agent-monitor doctor` is the first stop** for any "is it working" question.

## Non-goals (v1)

- **macOS / Windows.** `/proc`, GNU date `%s%3N`, `sha1sum`. Adapters welcome.
- **`dead` distinct from `done`.** /proc liveness gives "process gone" but not crashed-vs-graceful.
- **Subagents nested under their parent.** Each Task-tool spawn renders as its own cell.
- **Remote viewing.** Local-only.
- **Transcript content in SQLite.** Only paths and metadata; drill-down shows event types, not message bodies.

## Development

```bash
bun test               # 92 tests
bun run typecheck      # tsc --noEmit
bun run src/cli.ts tui # run from source
```

Project layout follows the architecture diagram one-to-one (`src/store/`, `src/indexer/`, `src/reconciler/`, `src/tui/`). Hot paths:

- `src/indexer/spool.ts` and `src/reconciler/{claude,codex}.ts` — only writers to `events.db` today
- `src/store/queries.ts` — single home for SQL
- `src/state-machine.ts` — event-driven state at ingest; `src/liveness.ts` overlays /proc liveness + freshness grace at read time
- `src/tui/store.ts` — Zustand `applyDiff` returns stable Map ref when nothing changed, so `React.memo`'d cells skip re-render
