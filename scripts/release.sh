#!/usr/bin/env bash
# Cut a maiTerm release: bump the version to match, commit, tag, and push —
# which triggers .github/workflows/release.yml to build, sign, and publish a
# GitHub Release (DMG + signed updater feed) on JayeMcC/maiterm.
#
# Usage:  bash scripts/release.sh <version>     e.g.  bash scripts/release.sh 1.18.1
#
# The version MUST be higher than the last release for the in-app updater to
# offer it (Tauri compares semver). One-time prerequisite: the repo secrets
# TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set
# (Settings → Secrets → Actions) or the build's signing step fails.
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: bash scripts/release.sh <version>   e.g. 1.18.1" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ version must be semver X.Y.Z (got '$VERSION')" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ working tree not clean — commit or stash first" >&2
  exit 1
fi
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "❌ tag v$VERSION already exists" >&2
  exit 1
fi

# Bump the version value in place (regex, so file formatting is preserved).
node -e '
const fs = require("fs");
const v = process.argv[1];
for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const s = fs.readFileSync(f, "utf8").replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${v}$2`);
  fs.writeFileSync(f, s);
}
' "$VERSION"

git add package.json src-tauri/tauri.conf.json
git commit -m "chore(release): v$VERSION"
git tag "v$VERSION"

echo "→ pushing commit + tag (triggers the Release workflow)…"
git push origin HEAD
git push origin "v$VERSION"

echo "✓ Released v$VERSION — watch it build at https://github.com/JayeMcC/maiterm/actions"
echo "  When green, the Release (with .dmg + updater feed) is at https://github.com/JayeMcC/maiterm/releases/tag/v$VERSION"
