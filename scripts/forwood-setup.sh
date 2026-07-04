#!/usr/bin/env bash
# forwood-setup.sh — one-shot, idempotent setup for maiTerm + the forwood task runner.
#
# Installs/updates everything a dev needs, skipping anything already in place:
#   1. Node >= 22.6 (via Homebrew if available)
#   2. @devcontainers/cli (host-side devcontainer up/exec)
#   3. Docker Desktop check (warn-only — container tasks need it, the rest doesn't)
#   4. maiTerm3.app — latest signed release DMG (or --build from this checkout)
#   5. forwood-launcher + task-engine deps, linked onto PATH
#   6. Verification + first launch (the app self-registers its Claude Code wiring)
#
# Usage: bash scripts/forwood-setup.sh [--build] [--no-launch]
#   --build      build the app from this checkout (install-local.sh --release)
#                instead of downloading the release DMG
#   --no-launch  don't launch maiTerm at the end
#
# Re-running is always safe: completed steps print a ✓ and are skipped.
# VERBOSE=1 streams full output of every step.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="maiTerm3"
APP_PATH="/Applications/${APP_NAME}.app"
GH_REPO="JayeMcC/maiterm"
MIN_NODE_MINOR="22.6"

BUILD_FROM_SOURCE=0
LAUNCH_APP=1
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_FROM_SOURCE=1 ;;
    --no-launch) LAUNCH_APP=0 ;;
    *) echo "unknown flag: $arg (expected --build / --no-launch)" >&2; exit 2 ;;
  esac
done

ok()   { printf '✓ %s\n' "$1"; }
warn() { printf '⚠ %s\n' "$1"; }
die()  { printf '✗ %s\n' "$1" >&2; exit 1; }

# Quiet on success, full captured output + exit code on failure. VERBOSE=1 streams.
run() {
  local label="$1"; shift
  if [ "${VERBOSE:-0}" = "1" ]; then
    echo "── $label"
    "$@" || die "$label failed (exit $?)"
  else
    local out
    if ! out="$("$@" 2>&1)"; then
      local code=$?
      printf '✗ %s failed (exit %s)\n%s\n' "$label" "$code" "$out" >&2
      exit "$code"
    fi
  fi
  ok "$label"
}

[ "$(uname)" = "Darwin" ] || die "macOS only — the rail and app install are macOS-specific."

# ── 1. Node >= 22.6 ─────────────────────────────────────────────────────────
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [maj,min]=process.versions.node.split(".").map(Number); process.exit(maj>22||(maj===22&&min>=6)?0:1)'
}
if node_ok; then
  ok "node $(node -v) (>= ${MIN_NODE_MINOR})"
elif command -v brew >/dev/null 2>&1; then
  run "brew install node" brew install node
  node_ok || die "node still < ${MIN_NODE_MINOR} after brew install — is an old node earlier on PATH? (which node → $(which node || true))"
else
  die "node >= ${MIN_NODE_MINOR} required and Homebrew not found. Install Homebrew (https://brew.sh) or Node ${MIN_NODE_MINOR}+, then re-run."
fi

# ── 2. @devcontainers/cli ───────────────────────────────────────────────────
if command -v devcontainer >/dev/null 2>&1; then
  ok "devcontainer CLI present"
else
  run "npm i -g @devcontainers/cli" npm install -g @devcontainers/cli
fi

# ── 3. Docker (warn-only) ───────────────────────────────────────────────────
if docker info >/dev/null 2>&1; then
  ok "Docker running"
else
  warn "Docker not running/installed — host tasks and the rail still work; container tasks (API/WEB/DBs) need Docker Desktop."
fi

# ── 4. maiTerm3.app ─────────────────────────────────────────────────────────
installed_version() {
  defaults read "${APP_PATH}/Contents/Info" CFBundleShortVersionString 2>/dev/null || true
}
if [ "$BUILD_FROM_SOURCE" = "1" ]; then
  xcode-select -p >/dev/null 2>&1 || die "--build needs the Xcode Command Line Tools: xcode-select --install"
  command -v cargo >/dev/null 2>&1 || die "--build needs Rust: brew install rustup && rustup-init -y, then re-run (or drop --build to install the release DMG)"
  ( cd "$REPO_ROOT" && run "npm ci (app)" npm ci )
  # install-local.sh builds, copies to /Applications, and re-signs (mandatory —
  # a plain copy of a local build breaks the signature → white screen).
  ( cd "$REPO_ROOT" && run "build + install ${APP_NAME} (install-local.sh --release)" bash scripts/install-local.sh --release )
else
  release_json="$(curl -fsSL "https://api.github.com/repos/${GH_REPO}/releases/latest")" \
    || die "could not query latest release from github.com/${GH_REPO}"
  latest_tag="$(printf '%s' "$release_json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tag_name')"
  latest_version="${latest_tag#v}"
  # Skip when installed >= latest (never downgrade a newer local build).
  version_current() {
    node -e '
      const [inst, latest] = process.argv.slice(1);
      if (!inst) process.exit(1);
      const p = v => v.split(".").map(Number);
      const [a, b] = [p(inst), p(latest)];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] || 0) - (b[i] || 0);
        if (d) process.exit(d > 0 ? 0 : 1);
      }
      process.exit(0)' "$(installed_version)" "$latest_version"
  }
  if version_current; then
    ok "${APP_NAME} $(installed_version) already installed (latest release: ${latest_version})"
  else
    dmg_url="$(printf '%s' "$release_json" | node -pe '
      const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const a=r.assets.find(a=>a.name.endsWith(".dmg"));
      if(!a) throw new Error("no DMG asset on latest release");
      a.browser_download_url')"
    tmp_dmg="$(mktemp -d)/maiterm.dmg"
    run "download ${APP_NAME} ${latest_version}" curl -fSL --progress-bar -o "$tmp_dmg" "$dmg_url"
    mount_point="$(hdiutil attach "$tmp_dmg" -nobrowse -readonly | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
    [ -d "${mount_point}/${APP_NAME}.app" ] || { hdiutil detach "$mount_point" >/dev/null 2>&1 || true; die "${APP_NAME}.app not found in DMG"; }
    run "install to ${APP_PATH}" ditto "${mount_point}/${APP_NAME}.app" "$APP_PATH"
    hdiutil detach "$mount_point" >/dev/null 2>&1 || warn "could not detach ${mount_point}"
    # Signed but not Apple-notarized → clear quarantine once per download.
    run "clear Gatekeeper quarantine" xattr -dr com.apple.quarantine "$APP_PATH"
    ok "${APP_NAME} ${latest_version} installed (was: $(installed_version))"
  fi
fi

# ── 5. task engine + launcher ───────────────────────────────────────────────
deps_current() { [ -f "$1/node_modules/.package-lock.json" ] && [ "$1/node_modules/.package-lock.json" -nt "$1/package-lock.json" ]; }
for pkg in task-engine launcher; do
  dir="${REPO_ROOT}/scripts/${pkg}"
  if deps_current "$dir"; then
    ok "${pkg} deps current"
  else
    ( cd "$dir" && run "npm ci (${pkg})" npm ci )
  fi
done

launcher_bin="$(command -v forwood-launcher || true)"
if [ -n "$launcher_bin" ] && [ "$(readlink -f "$launcher_bin" 2>/dev/null || true)" = "${REPO_ROOT}/scripts/launcher/bin/forwood-launcher" ]; then
  ok "forwood-launcher linked on PATH (${launcher_bin})"
else
  ( cd "${REPO_ROOT}/scripts/launcher" && run "npm link forwood-launcher" npm link )
fi

# ── 6. Verify + launch ──────────────────────────────────────────────────────
command -v forwood-launcher >/dev/null 2>&1 || die "forwood-launcher not on PATH after npm link — check 'npm prefix -g' is on PATH."
run "forwood-launcher responds" forwood-launcher --help
[ -d "$APP_PATH" ] || die "${APP_PATH} missing after install"

echo
ok "setup complete — ${APP_NAME} $(installed_version), launcher on PATH"
echo "  Next: open a maiTerm tab and cd into a forwood clone (wherever yours live) — the task rail appears on the right."
echo "  First launch self-registers maiTerm's Claude Code wiring (MCP server, hooks, /maiterm skill) — nothing manual."
if [ "$LAUNCH_APP" = "1" ]; then
  open -a "$APP_NAME" || warn "could not launch ${APP_NAME} — open it from /Applications"
fi
