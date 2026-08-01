#!/bin/bash
# maiTerm voice barge-in hook (interrupt half of the "conversational (voice)
# mode" work — see scripts/voice-status/speak-status.sh for the narration
# half this complements, and its header for the overall voice-mode plan).
#
# What this is: a UserPromptSubmit hook. The moment the operator submits a
# new prompt — the clearest, cheapest signal Claude Code exposes for "the
# user is interacting again" — this kills any `say` process speak-status.sh
# left running for THIS session, so voice narration never talks over a user
# who has already moved on. Registered by maiTerm itself under the same
# `voice_status` preference gate as speak-status.sh (see `build_our_hooks()`
# in src-tauri/src/claude_code/lockfile.rs); also hand-testable/standalone,
# same as that script — wire it manually to ~/.claude/settings.json under
# "UserPromptSubmit" using the same hook shape documented in
# speak-status.sh's header, just pointed at this file instead.
#
# Deliberately thin: this only ever kills a PID speak-status.sh already
# recorded for the current session, in the pid directory that script's
# header documents. It never blocks prompt submission, never fails a turn,
# and is a silent no-op wherever voice status itself would be (no live
# `say`, no pid file, MAITERM_VOICE_STATUS unset).
#
# Env vars:
#   MAITERM_VOICE_STATUS  Same opt-in gate as speak-status.sh — "1"/"true"/
#                          "yes" to act, anything else (incl. unset) is a
#                          silent no-op. Kept in sync so toggling voice off
#                          disables barge-in too, not just narration.
#
# Hook contract: reads the Claude Code UserPromptSubmit event JSON on stdin
# (documented at https://code.claude.com/docs/en/hooks.md). Always exits 0
# and writes nothing hook processing depends on — an empty stdout leaves the
# prompt untouched, it never blocks or adds context.

set -u

# Opt-in gate first — cheapest possible no-op path for the common case
# (hook registered globally but voice not enabled in this shell).
case "${MAITERM_VOICE_STATUS:-}" in
  1 | true | TRUE | yes | YES) ;;
  *) exit 0 ;;
esac

command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
session_id="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
session_id="${session_id//\//_}"
[ -z "$session_id" ] && exit 0

# Must match speak-status.sh's pid_dir exactly.
pid_dir="${TMPDIR:-/tmp}/maiterm-voice-pids"
pid_file="$pid_dir/$session_id.pid"

[ -f "$pid_file" ] || exit 0
say_pid="$(cat "$pid_file" 2>/dev/null)"
# Remove eagerly (before the kill below) so a second, near-simultaneous
# submit never double-acts on the same recorded pid.
rm -f "$pid_file"

case "$say_pid" in
  '' | *[!0-9]*) exit 0 ;; # not a plain pid — nothing safe to act on
esac

# TERM stops `say` (and its audio output) immediately; -0 first avoids
# signaling an unrelated process that may have since reused the pid.
kill -0 "$say_pid" 2>/dev/null && kill -TERM "$say_pid" 2>/dev/null

exit 0
