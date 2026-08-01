#!/bin/bash
# maiTerm voice-status prototype (TTS-out half of "conversational (voice) mode").
#
# What this is: a standalone Claude Code hook script. Wired to the `Stop` and
# `Notification` hooks, it pipes the agent's status to macOS `say` so an
# operator away from the screen still hears "what it's doing" without
# reading the terminal. This is the smallest end-to-end slice of the voice
# investigation TODO:
#
#   STT (talk to it)  -> adopt native Claude Code `/voice` (NOT built here)
#   TTS (hear it)      -> THIS script (Stop -> spoken turn summary,
#                         Notification -> spoken "needs your input" alert)
#
# Deliberately thin: no assistant-text *streaming* (that's a follow-up
# slice), no barge-in/interrupt handling, no continuously-listening daemon.
# It only ever runs once per hook event, and only when explicitly opted in
# (see MAITERM_VOICE_STATUS below) — never a background process burning
# credits or attention on its own.
#
# Auto-registered by maiTerm when the "Speak Status Aloud" preference
# (`voice_status`, Preferences -> Integrations -> Claude Code) is on and
# "Enable Hooks Integration" (`claude_hooks`) is also on: maiTerm bundles this
# exact file (see VOICE_STATUS_SCRIPT in src-tauri/src/claude_code/lockfile.rs),
# installs it to ~/.claude/skills/maiterm2/bin/speak-status.sh, and registers it
# as a second Stop/Notification command hook alongside its own HTTP hooks
# (build_our_hooks in lockfile.rs). Toggling the preference is picked up within
# one reassert tick (~30s) or on next app start — no manual settings.json
# editing needed. The opt-in gate below stays per-shell: with the preference on,
# maiTerm exports MAITERM_VOICE_STATUS=1 into every newly spawned PTY's shell
# env (src-tauri/src/pty/manager.rs), so `claude` processes started in those
# tabs — and thus their hook subprocesses, which inherit shell env — narrate.
# Already-open tabs need to be reopened to pick up the env var.
#
# You can still wire this manually (e.g. to test a local edit before it's
# picked up by the bundled copy, or in a shell maiTerm didn't spawn) by adding
# to ~/.claude/settings.json (merge with any existing Stop/Notification hooks
# rather than replacing them — see src-tauri/src/claude_code/CLAUDE.md for how
# maiTerm's own hooks are structured):
#
#   "hooks": {
#     "Stop": [
#       { "matcher": "", "hooks": [
#         { "type": "command", "command": "/absolute/path/to/speak-status.sh" }
#       ] }
#     ],
#     "Notification": [
#       { "matcher": "", "hooks": [
#         { "type": "command", "command": "/absolute/path/to/speak-status.sh" }
#       ] }
#     ]
#   }
#
# Then, in the ONE shell/tab you want narrated (never globally — this is
# opt-in, per-session):
#
#   export MAITERM_VOICE_STATUS=1
#
# Env vars (all optional except the opt-in gate):
#   MAITERM_VOICE_STATUS     "1"/"true"/"yes" to enable. Anything else (incl.
#                             unset) is a silent no-op — the default is OFF.
#   MAITERM_VOICE_VOICE      `say -v` voice name (e.g. "Samantha").
#   MAITERM_VOICE_RATE       `say -r` words per minute.
#   MAITERM_VOICE_MAX_CHARS  Max spoken length of a Stop-event summary before
#                             it's trimmed to the last whole word (default 400).
#                             Notification messages are short by nature and
#                             are never trimmed.
#   MAITERM_VOICE_OUTFILE    Write synthesized audio to this file (`say -o`)
#                             instead of speaking through the speakers.
#                             Useful for testing/debugging without making
#                             noise; unset in normal use.
#
# Hook contract: reads the Claude Code hook event JSON on stdin (documented
# at https://code.claude.com/docs/en/hooks.md). Always exits 0 and never
# writes to stdout/stderr in a way hook processing depends on — narration is
# a pure side effect and must never block or fail a turn.

set -u

# Opt-in gate first — cheapest possible no-op path for the common case
# (hook registered globally but not enabled in this shell).
case "${MAITERM_VOICE_STATUS:-}" in
  1 | true | TRUE | yes | YES) ;;
  *) exit 0 ;;
esac

# macOS-only prototype (`say` isn't portable) — silent no-op elsewhere so
# the same settings.json hook entry is harmless on Linux/CI.
command -v say >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)"

text=""
case "$event" in
Stop | SubagentStop)
  # Stop's hook input carries the final assistant text of the turn directly
  # in last_assistant_message — the docs explicitly say to use this instead
  # of reading transcript_path, which is written asynchronously and can lag
  # the in-memory conversation.
  text="$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)"
  ;;
Notification)
  # Notification's .message is already a short human-readable string, e.g.
  # "Claude needs your permission to use Bash" / "Claude is waiting for your
  # input" — exactly the "what it's doing right now" moment worth a spoken
  # alert when you're not looking at the screen.
  text="$(printf '%s' "$input" | jq -r '.message // empty' 2>/dev/null)"
  ;;
*)
  exit 0
  ;;
esac

[ -z "$text" ] && exit 0

# Clean markdown noise out of the text so it reads as speech, not as a
# rendered document: drop fenced code blocks (reading code aloud is
# useless), strip inline emphasis/heading/code markers, collapse
# whitespace. python3 is already a soft dependency elsewhere in this repo's
# Claude Code tooling (see claude_code/CLAUDE.md, SSH hook setup) — but
# degrade gracefully to whitespace-only cleanup if it's missing so this
# never hard-fails.
if command -v python3 >/dev/null 2>&1; then
  clean="$(printf '%s' "$text" | python3 -c '
import re
import sys

t = sys.stdin.read()
t = re.sub(r"```.*?```", " code omitted ", t, flags=re.S)
t = re.sub(r"`([^`]*)`", r"\1", t)
t = re.sub(r"[*_#>]+", " ", t)
t = re.sub(r"\s+", " ", t).strip()
sys.stdout.write(t)
' 2>/dev/null)"
else
  clean="$(printf '%s' "$text" | tr '\n\t' '  ' | sed -E 's/  +/ /g')"
fi
[ -z "$clean" ] && clean="$text"

max_chars="${MAITERM_VOICE_MAX_CHARS:-400}"
if [ "${#clean}" -gt "$max_chars" ]; then
  trimmed="${clean:0:$max_chars}"
  # Cut at the last whole word rather than mid-word.
  word_trimmed="${trimmed% *}"
  [ -n "$word_trimmed" ] && trimmed="$word_trimmed"
  clean="$trimmed"
fi

say_args=()
[ -n "${MAITERM_VOICE_VOICE:-}" ] && say_args+=(-v "$MAITERM_VOICE_VOICE")
[ -n "${MAITERM_VOICE_RATE:-}" ] && say_args+=(-r "$MAITERM_VOICE_RATE")
[ -n "${MAITERM_VOICE_OUTFILE:-}" ] && say_args+=(-o "$MAITERM_VOICE_OUTFILE")

say "${say_args[@]}" "$clean" >/dev/null 2>&1 || true

# Always a valid no-op decision — this hook never blocks or influences the
# turn, it only observes.
exit 0
