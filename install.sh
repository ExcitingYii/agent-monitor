#!/usr/bin/env bash
# agent-monitor installer.
#
# Bootstraps a fresh clone into a working `agent-monitor tui`:
#   1. Pre-flight (bun, jq, Linux; warn-only for claude/codex/agy)
#   2. bun install
#   3. Claude hooks   -> delegates to `bun run src/cli.ts install-hooks`
#                       (preserves its native diff + y/N prompt)
#   4. Codex hooks    -> writes ~/.codex/hooks.json (merge-aware via jq)
#                       and toggles [features] hooks = true in config.toml
#   5. Agy hooks      -> writes ~/.gemini/config/hooks.json (merge-aware via jq)
#   6. Symlink bin/agent-monitor into ~/.local/bin (idempotent)
#   7. agent-monitor doctor
#
# Re-runnable: each step is idempotent. Atomic file writes everywhere; backups
# stamped with UTC ISO time. No broad rollback — failed steps leave the prior
# atomic state intact and print rerun guidance.

set -euo pipefail

# ---- ui -------------------------------------------------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'
  BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=; YEL=; GRN=; BLD=; DIM=; RST=
fi
err()  { printf '%s%s%s\n' "$RED" "$*" "$RST" >&2; }
warn() { printf '%s%s%s\n' "$YEL" "$*" "$RST" >&2; }
ok()   { printf '%s%s%s\n' "$GRN" "$*" "$RST"; }
say()  { printf '\n%s==> %s%s\n' "$BLD" "$*" "$RST"; }
dim()  { printf '%s%s%s\n' "$DIM" "$*" "$RST"; }

usage() {
  cat <<EOF
Usage: ./install.sh [--yes] [--help]

Bootstraps agent-monitor on a fresh Linux box. Each step is idempotent.

  --yes, -y   Auto-accept every diff/prompt (CI / scripted setup).
              Diffs still print to stdout for the install log; consent is
              implied. Use the interactive default if you want to inspect
              before applying.
  --help, -h  Show this help.

What it touches on your system:
  - merges hook entries into  ~/.claude/settings.json   (backup left alongside)
  - writes/merges             ~/.codex/hooks.json       (backup if present)
  - sets hooks = true         ~/.codex/config.toml      (backup if present)
  - writes/merges             ~/.gemini/config/hooks.json (backup if present)
  - copies hook scripts to    ~/.local/share/agent-monitor/hooks/
  - symlinks                  ~/.local/bin/agent-monitor -> bin/agent-monitor
  - state dir created lazily  ~/.local/state/agent-monitor/  (events.db, spool, log)
EOF
}

# ---- args -----------------------------------------------------------------
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)   YES=1 ;;
    --help|-h)  usage; exit 0 ;;
    *)          err "unknown arg: $arg"; usage; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

confirm() {
  # confirm "<prompt>" — returns 0 on yes, 1 on no. Auto-yes if --yes was set.
  if [ "$YES" -eq 1 ]; then return 0; fi
  printf '%s%s [y/N]: %s' "$BLD" "$1" "$RST"
  local ans
  read -r ans || return 1
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

stamp() { date -u +%Y%m%dT%H%M%SZ; }

# ---- 1. preflight ---------------------------------------------------------
say "preflight"

case "$(uname -s)" in
  Linux) ;;
  *) err "agent-monitor is Linux-only (uses /proc liveness, sha1sum, date +%s%3N)"; exit 1 ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  err "bun not found. Install:  curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
BUN_VER="$(bun --version 2>/dev/null)"
BUN_MAJOR="${BUN_VER%%.*}"
BUN_REST="${BUN_VER#*.}"
BUN_MINOR="${BUN_REST%%.*}"
if [ "${BUN_MAJOR:-0}" -lt 1 ] \
   || { [ "${BUN_MAJOR:-0}" -eq 1 ] && [ "${BUN_MINOR:-0}" -lt 3 ]; }; then
  err "bun >= 1.3 required (found $BUN_VER)"
  exit 1
fi
ok "bun $BUN_VER"

if ! command -v jq >/dev/null 2>&1; then
  err "jq not found. Install:  apt install jq  /  dnf install jq  /  pacman -S jq"
  exit 1
fi
ok "jq $(jq --version)"

HAVE_CLAUDE=0; HAVE_CODEX=0; HAVE_AGY=0
if command -v claude >/dev/null 2>&1; then HAVE_CLAUDE=1; ok "claude $(claude --version 2>/dev/null | head -1)"; fi
if command -v codex  >/dev/null 2>&1; then HAVE_CODEX=1;  ok "codex $(codex --version 2>/dev/null | head -1)"; fi
if command -v agy    >/dev/null 2>&1; then HAVE_AGY=1;    ok "agy $(agy --help 2>&1 | head -1 || echo 'found')"; fi
if [ "$HAVE_CLAUDE" -eq 0 ]; then warn "claude not on PATH — Claude hooks will install but stay inert"; fi
if [ "$HAVE_CODEX"  -eq 0 ]; then warn "codex not on PATH  — Codex hooks will install but stay inert"; fi
if [ "$HAVE_AGY"    -eq 0 ]; then warn "agy not on PATH    — Agy hooks will install but stay inert"; fi

# ---- 2. bun install -------------------------------------------------------
say "bun install"
bun install
ok "deps installed"

# ---- 3a. Deploy hook scripts ---------------------------------------------
# Decoupled from the settings-merge step so step 4 (Codex) never depends on
# the user having accepted the Claude diff first. No prompt — hook scripts
# under ~/.local/share/agent-monitor/hooks/ are inert until something
# references them in a config file.
say "deploy hook scripts"
bun run src/cli.ts install-hooks --files-only

# ---- 3b. Claude hooks (settings merge) ------------------------------------
# Delegate to the existing CLI command. It prints a unified diff and prompts
# y/N — we PRESERVE that on purpose. The diff/prompt is the project's trust
# gate; install.sh only orchestrates, never bypasses consent.
# When --yes is set, we pipe `y\n` so the prompt auto-confirms; the diff
# still scrolls past so the user sees what was applied in their terminal log.
say "Claude hooks (~/.claude/settings.json)"
if [ "$YES" -eq 1 ]; then
  # Single 'y' line + EOF; using `yes` would trip SIGPIPE under pipefail.
  printf 'y\n' | bun run src/cli.ts install-hooks \
    || warn "claude install-hooks reported non-zero (continuing)"
else
  bun run src/cli.ts install-hooks \
    || warn "claude install-hooks reported non-zero (continuing)"
fi

# ---- 4. Codex hooks -------------------------------------------------------
say "Codex hooks (~/.codex/hooks.json + config.toml feature flag)"

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOOKS_FILE="$CODEX_DIR/hooks.json"
CODEX_CONFIG="$CODEX_DIR/config.toml"
HOOKS_DIR="$HOME/.local/share/agent-monitor/hooks"
CODEX_HOOK="$HOOKS_DIR/codex-hook.sh"

# Step 3a (--files-only) deployed hook scripts unconditionally; this is just
# a defensive guard against someone hand-deleting them between steps.
if [ ! -x "$CODEX_HOOK" ]; then
  err "$CODEX_HOOK is missing. Step 3 (deploy hook scripts) didn't run or was rolled back."
  err "Re-run install.sh, or hand-copy hooks/codex-hook.sh into ~/.local/share/agent-monitor/hooks/"
  exit 1
fi

mkdir -p "$CODEX_DIR"

# Build the desired hooks block from scratch. Codex omits `matcher` (canonical
# "match all"); per-event we register one group with one command handler.
build_codex_json() {
  jq -n --arg s "$CODEX_HOOK" '
    def events: ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PermissionRequest","Stop"];
    {
      hooks: (
        events
        | map({key: ., value: [{hooks: [{type: "command", command: ($s + " codex " + .)}]}]})
        | from_entries
      )
    }'
}

# Merge into existing JSON: per event, drop our prior handlers (idempotent
# rerun), preserve unknown groups/handlers, append our group. `~/.codex/hooks.json`
# is shared (Codex loads hooks from multiple sources within and across files).
merge_codex_json() {
  local existing="$1"
  jq --arg s "$CODEX_HOOK" --arg dir "$HOOKS_DIR" '
    def events: ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PermissionRequest","Stop"];
    def is_ours(h): ((h.command // "") | tostring | contains($dir));
    .hooks //= {} |
    .hooks = (
      reduce events[] as $ev (.hooks;
        ( .[$ev] // [] ) as $groups |
        ( [ $groups[]
            | .hooks = ((.hooks // []) | map(select(is_ours(.) | not)))
            | select((.hooks | length) > 0) ] ) as $cleaned |
        .[$ev] = ( $cleaned + [{hooks: [{type: "command", command: ($s + " codex " + $ev)}]}] )
      )
    )
  ' <<<"$existing"
}

if [ -e "$CODEX_HOOKS_FILE" ]; then
  EXISTING="$(cat "$CODEX_HOOKS_FILE")"
  if ! printf '%s' "$EXISTING" | jq -e . >/dev/null 2>&1; then
    err "$CODEX_HOOKS_FILE is not valid JSON. Refusing to overwrite — move it aside and rerun."
    exit 1
  fi
  NEXT="$(merge_codex_json "$EXISTING")"
else
  EXISTING=""
  NEXT="$(build_codex_json)"
fi

# Normalize current for diffing (jq pretty-print) so noise from formatting
# doesn't fake a change.
CURRENT_NORM=""
if [ -n "$EXISTING" ]; then
  CURRENT_NORM="$(printf '%s' "$EXISTING" | jq .)"
fi

if [ "$CURRENT_NORM" = "$NEXT" ]; then
  dim "$CODEX_HOOKS_FILE already up to date"
  SKIP_CODEX_HOOKS=1
else
  if [ -e "$CODEX_HOOKS_FILE" ]; then
    diff -u --label "$CODEX_HOOKS_FILE" --label "$CODEX_HOOKS_FILE (proposed)" \
      <(printf '%s\n' "$CURRENT_NORM") <(printf '%s\n' "$NEXT") || true
  else
    dim "(creating new file: $CODEX_HOOKS_FILE)"
    printf '%s\n' "$NEXT"
  fi
  if confirm "Apply this change to $CODEX_HOOKS_FILE?"; then
    if [ -e "$CODEX_HOOKS_FILE" ]; then
      cp -p "$CODEX_HOOKS_FILE" "${CODEX_HOOKS_FILE}.bak.$(stamp)"
    fi
    printf '%s\n' "$NEXT" > "${CODEX_HOOKS_FILE}.tmp"
    mv "${CODEX_HOOKS_FILE}.tmp" "$CODEX_HOOKS_FILE"
    ok "wrote $CODEX_HOOKS_FILE"
  else
    warn "skipped Codex hooks.json"
    SKIP_CODEX_HOOKS=1
  fi
fi

# Codex feature flag. The old name was `codex_hooks`; new Codex warns on it.
# Keep the install idempotent by migrating the legacy key to `hooks`.
if [ -e "$CODEX_CONFIG" ]; then
  if grep -qE '^[[:space:]]*hooks[[:space:]]*=[[:space:]]*true' "$CODEX_CONFIG" \
     && ! grep -qE '^[[:space:]]*codex_hooks[[:space:]]*=' "$CODEX_CONFIG"; then
    dim "hooks = true already present in $CODEX_CONFIG"
  else
    SECTIONS="$(grep -cE '^\[features\]([[:space:]]|$|#)' "$CODEX_CONFIG" || true)"
    if [ "${SECTIONS:-0}" -gt 1 ]; then
      err "$CODEX_CONFIG has multiple [features] sections — refusing to edit. Add manually:"
      err "  [features]"
      err "  hooks = true"
    elif [ "${SECTIONS:-0}" -eq 1 ]; then
      cp -p "$CODEX_CONFIG" "${CODEX_CONFIG}.bak.$(stamp)"
      awk '
        BEGIN { in_features = 0; saw_hooks = 0 }
        /^\[/ {
          if (in_features && !saw_hooks) print "hooks = true"
          in_features = ($0 ~ /^\[features\]([[:space:]]|$|#)/)
          saw_hooks = 0
          print
          next
        }
        in_features && /^[[:space:]]*codex_hooks[[:space:]]*=/ { next }
        in_features && /^[[:space:]]*hooks[[:space:]]*=/ {
          if (!saw_hooks) print "hooks = true"
          saw_hooks = 1
          next
        }
        { print }
        END {
          if (in_features && !saw_hooks) print "hooks = true"
        }
      ' "$CODEX_CONFIG" > "${CODEX_CONFIG}.tmp"
      mv "${CODEX_CONFIG}.tmp" "$CODEX_CONFIG"
      ok "ensured hooks = true under existing [features] in $CODEX_CONFIG"
    else
      cp -p "$CODEX_CONFIG" "${CODEX_CONFIG}.bak.$(stamp)"
      printf '\n[features]\nhooks = true\n' >> "$CODEX_CONFIG"
      ok "appended [features] hooks = true to $CODEX_CONFIG"
    fi
  fi
else
  printf '[features]\nhooks = true\n' > "$CODEX_CONFIG"
  ok "created $CODEX_CONFIG with hooks = true"
fi

# ---- 4b. Agy hooks -------------------------------------------------------
say "Agy hooks (~/.gemini/config/hooks.json)"

AGY_DIR="$HOME/.gemini/config"
AGY_HOOKS_FILE="$AGY_DIR/hooks.json"
AGY_HOOK="$HOOKS_DIR/agy-hook.sh"

if [ ! -x "$AGY_HOOK" ]; then
  err "$AGY_HOOK is missing. Step 3 (deploy hook scripts) didn't run or was rolled back."
  err "Re-run install.sh, or hand-copy hooks/agy-hook.sh into ~/.local/share/agent-monitor/hooks/"
  exit 1
fi

mkdir -p "$AGY_DIR"

build_agy_json() {
  jq -n --arg s "$AGY_HOOK" '
    def events: ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PermissionRequest","Stop"];
    {
      hooks: (
        events
        | map({key: ., value: [{hooks: [{type: "command", command: ($s + " agy " + .)}]}]})
        | from_entries
      )
    }'
}

merge_agy_json() {
  local existing="$1"
  jq --arg s "$AGY_HOOK" --arg dir "$HOOKS_DIR" '
    def events: ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PermissionRequest","Stop"];
    def is_ours(h): ((h.command // "") | tostring | contains($dir));
    .hooks //= {} |
    .hooks = (
      reduce events[] as $ev (.hooks;
        ( .[$ev] // [] ) as $groups |
        ( [ $groups[]
            | .hooks = ((.hooks // []) | map(select(is_ours(.) | not)))
            | select((.hooks | length) > 0) ] ) as $cleaned |
        .[$ev] = ( $cleaned + [{hooks: [{type: "command", command: ($s + " agy " + $ev)}]}] )
      )
    )
  ' <<<"$existing"
}

if [ -e "$AGY_HOOKS_FILE" ]; then
  EXISTING="$(cat "$AGY_HOOKS_FILE")"
  if ! printf '%s' "$EXISTING" | jq -e . >/dev/null 2>&1; then
    err "$AGY_HOOKS_FILE is not valid JSON. Refusing to overwrite — move it aside and rerun."
    exit 1
  fi
  NEXT="$(merge_agy_json "$EXISTING")"
else
  EXISTING=""
  NEXT="$(build_agy_json)"
fi

CURRENT_NORM=""
if [ -n "$EXISTING" ]; then
  CURRENT_NORM="$(printf '%s' "$EXISTING" | jq .)"
fi

if [ "$CURRENT_NORM" = "$NEXT" ]; then
  dim "$AGY_HOOKS_FILE already up to date"
else
  if [ -e "$AGY_HOOKS_FILE" ]; then
    diff -u --label "$AGY_HOOKS_FILE" --label "$AGY_HOOKS_FILE (proposed)" \
      <(printf '%s\n' "$CURRENT_NORM") <(printf '%s\n' "$NEXT") || true
  else
    dim "(creating new file: $AGY_HOOKS_FILE)"
    printf '%s\n' "$NEXT"
  fi
  if confirm "Apply this change to $AGY_HOOKS_FILE?"; then
    if [ -e "$AGY_HOOKS_FILE" ]; then
      cp -p "$AGY_HOOKS_FILE" "${AGY_HOOKS_FILE}.bak.$(stamp)"
    fi
    printf '%s\n' "$NEXT" > "${AGY_HOOKS_FILE}.tmp"
    mv "${AGY_HOOKS_FILE}.tmp" "$AGY_HOOKS_FILE"
    ok "wrote $AGY_HOOKS_FILE"
  else
    warn "skipped Agy hooks.json"
  fi
fi

# ---- 5. PATH symlink ------------------------------------------------------
say "PATH symlink (~/.local/bin/agent-monitor)"
LOCAL_BIN="$HOME/.local/bin"
TARGET="$LOCAL_BIN/agent-monitor"
SOURCE="$REPO_ROOT/bin/agent-monitor"

mkdir -p "$LOCAL_BIN"

if [ -L "$TARGET" ]; then
  CUR="$(readlink "$TARGET")"
  if [ "$CUR" = "$SOURCE" ]; then
    dim "$TARGET → $SOURCE (already)"
  else
    warn "$TARGET currently points to $CUR (not this clone)"
    if confirm "Replace it?"; then
      ln -sfn "$SOURCE" "$TARGET"
      ok "replaced symlink: $TARGET → $SOURCE"
    else
      warn "skipped — $TARGET unchanged"
    fi
  fi
elif [ -e "$TARGET" ]; then
  warn "$TARGET exists and is NOT a symlink — refusing to replace. Move it aside and rerun."
else
  ln -s "$SOURCE" "$TARGET"
  ok "linked $TARGET → $SOURCE"
fi

case ":$PATH:" in
  *":$LOCAL_BIN:"*) ;;
  *) warn "$LOCAL_BIN is not on \$PATH. Add to your shell rc:"
     warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
     ;;
esac

# ---- 6. verification ------------------------------------------------------
say "verification (agent-monitor doctor)"
if command -v agent-monitor >/dev/null 2>&1; then
  agent-monitor doctor || warn "doctor reported non-zero — inspect output above"
else
  bun run src/cli.ts doctor || warn "doctor reported non-zero — inspect output above"
fi

printf '\n%sdone.%s Run %sagent-monitor tui%s to open the dashboard.\n' \
  "$BLD" "$RST" "$BLD" "$RST"
