#!/bin/bash
# maiTerm voice-stream prototype — real-time assistant-text streaming, the
# "hear it as it types" half of the same TTS-out slice as speak-status.sh
# (see that script's header for the full STT/TTS roadmap; this is slice 2).
#
# What this is: a stdin filter. Feed it the raw stream-json JSONL from a
#
#   claude -p "..." --output-format stream-json --include-partial-messages --verbose
#
# invocation and it extracts the assistant's text deltas as they arrive,
# buffers them into whole sentences/clauses (so speech sounds natural
# instead of a per-token stutter), and speaks each clause via macOS `say` as
# soon as it's ready — not waiting for the whole turn to finish like
# speak-status.sh's Stop-hook summary does. The actual parsing/buffering
# lives in lib/stream_speak.py (one long-lived python3 process for the
# whole stream); this script is just the opt-in gate + dependency checks.
#
# Usage — pipe a fresh `claude -p` run straight through:
#
#   export MAITERM_VOICE_STATUS=1
#   claude -p "explain the plan" --output-format stream-json \
#     --include-partial-messages --verbose \
#     | scripts/voice-status/stream-speak.sh
#
# Or against captured/fixture JSONL, for testing without spending a turn:
#
#   MAITERM_VOICE_STATUS=1 scripts/voice-status/stream-speak.sh < fixture.jsonl
#
# NOT wired to a *running* interactive maiTerm tab's `claude` session — tabs
# run interactive `claude`, not `claude -p`, and interactive mode doesn't
# expose this stream-json format. Attaching to a live tab's output is a
# separate maiTerm-side integration concern (a real design question: does
# maiTerm re-invoke Claude Code in `-p` mode for narration, tee interactive
# PTY output, or something else — no sensible default, needs a human call).
# This script only ever consumes stream-json JSONL from stdin, wherever it
# comes from — a standalone, demonstrable prototype of the extraction +
# clause-buffering + speaking mechanism, same spirit as speak-status.sh.
#
# Env vars (all optional except the opt-in gate):
#   MAITERM_VOICE_STATUS            "1"/"true"/"yes" to enable (same gate as
#                                    speak-status.sh — reused rather than a
#                                    second toggle). Anything else (incl.
#                                    unset) is a silent no-op.
#   MAITERM_VOICE_VOICE              `say -v` voice name (e.g. "Samantha").
#   MAITERM_VOICE_RATE               `say -r` words per minute.
#   MAITERM_VOICE_STREAM_MAX_CHARS   Force a clause break after this many
#                                    buffered chars even with no punctuation
#                                    in sight (default 200) — keeps a long
#                                    unpunctuated run from delaying speech
#                                    until the whole turn ends.
#   MAITERM_VOICE_OUTDIR             Write each spoken clause to
#                                    "<dir>/NNN.aiff" (`say -o`) instead of
#                                    the speakers — silent/unattended
#                                    testing. Directory must already exist.
#   MAITERM_VOICE_VERBOSE            "1" to also print each spoken clause to
#                                    stderr, for verifying extraction
#                                    without needing to listen.
#
# Never blocks or fails the process feeding it — this is a pure consumer at
# the end of a pipe. Malformed/unexpected JSON lines and non-text event
# types (tool_use, thinking, system/result/rate_limit events, ...) are
# skipped, not fatal.

set -u

# Opt-in gate first — cheapest possible no-op path.
case "${MAITERM_VOICE_STATUS:-}" in
  1 | true | TRUE | yes | YES) ;;
  *) exit 0 ;;
esac

# macOS-only prototype (`say` isn't portable) — silent no-op elsewhere.
command -v say >/dev/null 2>&1 || exit 0
# python3 does the JSON parsing/buffering here (no whitespace-only fallback
# like speak-status.sh's cleanup step — without it there's no way to
# extract deltas from the stream at all).
command -v python3 >/dev/null 2>&1 || exit 0

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/lib/stream_speak.py"
