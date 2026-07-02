#!/usr/bin/env bash
# Build a maiTerm bundle and install it to /Applications — with the mandatory
# ad-hoc RE-SIGN that a plain `ditto`/`cp` skips.
#
# Why this script exists: copying a locally-built .app into /Applications
# invalidates its ad-hoc code signature's resource seal. `codesign -v` then
# reports "code has no resources but signature indicates they must be present",
# macOS refuses to load the WebKit helper, and the app launches to a WHITE
# SCREEN (process alive, MCP may even boot). Re-signing after the copy is the
# fix — so it lives here where it can't be forgotten.
#
# Usage:
#   scripts/install-local.sh              # channel-dev → maiTerm3.app (the dev line)
#   scripts/install-local.sh --channel main   # tauri.conf.json → maiTerm2.app
#   scripts/install-local.sh --no-build   # skip the build; re-install + re-sign existing bundle
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHANNEL="dev"
DO_BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$CHANNEL" in
  dev)  CONFIG_FLAG=(--config src-tauri/tauri.channel-dev.conf.json); APP_NAME="maiTerm3" ;;
  main) CONFIG_FLAG=();                                                APP_NAME="maiTerm2" ;;
  *) echo "unknown channel '$CHANNEL' (expected: dev | main)" >&2; exit 2 ;;
esac

SRC="src-tauri/target/debug/bundle/macos/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"

if [[ "$DO_BUILD" == 1 ]]; then
  echo "→ building ${APP_NAME} (channel: ${CHANNEL})…"
  npx tauri build --debug "${CONFIG_FLAG[@]}"
fi

[[ -d "$SRC" ]] || { echo "bundle not found: $SRC (run without --no-build)" >&2; exit 1; }

echo "→ installing to ${DEST}…"
rm -rf "$DEST"
ditto "$SRC" "$DEST"

# The load-bearing line: ditto broke the seal; re-seal so macOS will load it.
echo "→ re-signing (ad-hoc)…"
codesign --force --deep --sign - "$DEST"

# VERIFY the seal (codesign -v), not just display it (codesign -dv always "looks" fine).
if codesign -v "$DEST" 2>/dev/null; then
  echo "✓ ${APP_NAME} installed and signature verified — safe to launch."
else
  echo "✗ signature still invalid after re-sign — do NOT launch, investigate." >&2
  exit 1
fi
