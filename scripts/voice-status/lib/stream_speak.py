#!/usr/bin/env python3
"""Core engine for stream-speak.sh — see that script's header for usage,
env vars, and the "why not attach to a live tab" note.

Reads Claude Code `--output-format stream-json --include-partial-messages`
JSONL from stdin, extracts the assistant's text_delta chunks (ignoring
thinking_delta / input_json_delta / every other event type), buffers them
into whole sentences/clauses, and speaks each clause via macOS `say` as soon
as it's ready — not waiting for the whole turn.

One long-lived process for the whole stream (rather than a fresh python3
per JSONL line, or per clause) so `say` calls only pay the punctuation-wait
latency, not process-spawn overhead too.
"""

import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clean_text import clean  # noqa: E402

# Break the buffer into a speakable clause at sentence/clause punctuation
# followed by whitespace (or end of buffer) — matches speak-status.sh's
# "reads as speech" goal without waiting for a full multi-sentence turn.
CLAUSE_BREAK_RE = re.compile(r"[.!?:;\n]+(?:\s+|$)")


def voice_flag_on(value: str) -> bool:
    return value in ("1", "true", "TRUE", "yes", "YES")


def build_say_args(outfile):
    args = []
    voice = os.environ.get("MAITERM_VOICE_VOICE", "")
    rate = os.environ.get("MAITERM_VOICE_RATE", "")
    if voice:
        args += ["-v", voice]
    if rate:
        args += ["-r", rate]
    if outfile:
        args += ["-o", outfile]
    return args


class ClauseSpeaker:
    """Buffers streamed text_delta chunks and speaks completed clauses."""

    def __init__(self):
        self.buffer = ""
        try:
            self.max_chars = int(os.environ.get("MAITERM_VOICE_STREAM_MAX_CHARS", "200") or "200")
        except ValueError:
            self.max_chars = 200
        self.outdir = os.environ.get("MAITERM_VOICE_OUTDIR", "")
        self.verbose = voice_flag_on(os.environ.get("MAITERM_VOICE_VERBOSE", ""))
        self.chunk_index = 0

    def feed(self, text_delta: str) -> None:
        self.buffer += text_delta
        self._flush_ready()

    def flush_remaining(self) -> None:
        """Speak whatever's left in the buffer, even without a clause break
        (end of a content block / message / stream — don't drop a trailing
        fragment that never hit terminal punctuation)."""
        text = self.buffer.strip()
        self.buffer = ""
        if text:
            self._speak(text)

    def _flush_ready(self) -> None:
        while True:
            m = CLAUSE_BREAK_RE.search(self.buffer)
            if m:
                piece, self.buffer = self.buffer[: m.end()], self.buffer[m.end():]
                self._speak(piece)
                continue
            if len(self.buffer) > self.max_chars:
                # No punctuation in sight for a while (e.g. a long unpunctuated
                # list) — force a break at the last whole word within the cap
                # rather than waiting indefinitely.
                cut = self.buffer.rfind(" ", 0, self.max_chars)
                if cut <= 0:
                    cut = self.max_chars
                piece, self.buffer = self.buffer[: cut + 1], self.buffer[cut + 1:]
                self._speak(piece)
                continue
            break

    def _speak(self, raw_piece: str) -> None:
        text = clean(raw_piece)
        if not text:
            return
        outfile = None
        if self.outdir:
            self.chunk_index += 1
            outfile = os.path.join(self.outdir, f"{self.chunk_index:03d}.aiff")
        if self.verbose:
            print(f"[stream-speak] {text}", file=sys.stderr)
        args = ["say", *build_say_args(outfile), text]
        try:
            subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        except OSError:
            # Fail-open: narration is a pure side effect, never fatal to the
            # stream it's reading.
            pass


def main() -> None:
    speaker = ClauseSpeaker()
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict) or obj.get("type") != "stream_event":
            continue
        event = obj.get("event") or {}
        etype = event.get("type")
        if etype == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                if text:
                    speaker.feed(text)
        elif etype in ("content_block_stop", "message_stop"):
            speaker.flush_remaining()
    speaker.flush_remaining()


if __name__ == "__main__":
    main()
