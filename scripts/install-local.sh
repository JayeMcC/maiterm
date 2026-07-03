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
# CRITICAL: the app's DATA-DIR IDENTITY (com.aiterm.{app3,dev3,app2,dev2}) is
# chosen at COMPILE TIME by `app_data_slug()` from `cfg!(debug_assertions)` +
# the `MAITERM_CHANNEL` env var — NOT by the --config bundle rename. So the
# channel env MUST be exported for the build, or you get a mismatched binary
# (e.g. a bundle named maiTerm3 that internally runs as dev2 → wrong state
# dir → white screen). This script sets it. Release vs debug also changes the
# slug: only a RELEASE dev build is `com.aiterm.app3` (the daily-driver dir);
# a --debug dev build is the coherent-but-separate `com.aiterm.dev3`.
#
# Usage:
#   scripts/install-local.sh --release        # RELEASE maiTerm3 → com.aiterm.app3 (daily driver; slow)
#   scripts/install-local.sh                   # debug maiTerm3 → com.aiterm.dev3 (fast; test instance)
#   scripts/install-local.sh --channel main    # maiTerm2 line
#   scripts/install-local.sh --no-build        # reinstall + re-sign existing bundle
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHANNEL="dev"
DO_BUILD=1
RELEASE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --release) RELEASE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$CHANNEL" in
  dev)  CONFIG_FLAG=(--config src-tauri/tauri.channel-dev.conf.json); APP_NAME="maiTerm3"; export MAITERM_CHANNEL=dev ;;
  main) CONFIG_FLAG=();                                                APP_NAME="maiTerm2"; export MAITERM_CHANNEL= ;;
  *) echo "unknown channel '$CHANNEL' (expected: dev | main)" >&2; exit 2 ;;
esac

if [[ "$RELEASE" == 1 ]]; then
  PROFILE_DIR="release"; BUILD_FLAG=()
else
  PROFILE_DIR="debug"; BUILD_FLAG=(--debug)
fi

SRC="src-tauri/target/${PROFILE_DIR}/bundle/macos/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"

if [[ "$DO_BUILD" == 1 ]]; then
  echo "→ building ${APP_NAME} (channel=${CHANNEL}, MAITERM_CHANNEL='${MAITERM_CHANNEL}', profile=${PROFILE_DIR})…"
  # Tolerate a non-zero exit: a RELEASE build produces the .app, then fails
  # signing the UPDATER tarball (needs TAURI_SIGNING_PRIVATE_KEY, a CI-only
  # secret). That failure is post-bundle and irrelevant to a local install —
  # the .app existence check below is the real gate.
  npx tauri build "${BUILD_FLAG[@]}" "${CONFIG_FLAG[@]}" || \
    echo "→ tauri build exited non-zero (likely updater signing) — checking for the .app anyway…"
fi

[[ -d "$SRC" ]] || { echo "bundle not found: $SRC (build failed before producing the .app)" >&2; exit 1; }

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
