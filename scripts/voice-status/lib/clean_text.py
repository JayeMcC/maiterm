#!/usr/bin/env python3
"""Shared text-cleaning helper for maiTerm voice scripts.

Strips markdown/code noise out of assistant or status text so it reads as
speech, not as a rendered document: drops fenced code blocks (reading code
aloud is useless), strips inline emphasis/heading/blockquote/code markers,
collapses whitespace.

Used two ways:
  - As a CLI filter (stdin -> stdout) from speak-status.sh, which cleans one
    text blob per Stop/Notification hook event.
  - As an importable module (`from clean_text import clean`) from
    stream_speak.py, which cleans many small streamed clauses inside one
    long-lived process and can't afford a python3 spawn per clause.
"""

import re
import sys


def clean(text: str) -> str:
    t = re.sub(r"```.*?```", " code omitted ", text, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"[*_#>]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


if __name__ == "__main__":
    sys.stdout.write(clean(sys.stdin.read()))
