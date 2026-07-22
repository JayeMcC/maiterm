#!/usr/bin/env bash
# e2e-remote.sh [ref] [member] [test-filter] — dispatch the maiTerm e2e suite
# to a Fleet Hub pool member and wait for the verdict.
#
# The e2e suite spawns real maiTerm windows and must NEVER run on the
# operator's host (operator rule 2026-07-22) — this is the sanctioned
# local-dev path; GitHub CI covers pushes. The member runs
# `pool-maiterm-e2e` (forwood-dashboard scripts/pool-member-helpers/) in its
# GUI session; full log stays on the member at /tmp/maiterm-e2e-<ref>.log.
#
# Requires: hub reachable (default http://localhost:4318), curl, jq.
set -euo pipefail
HUB="${MAITERM_E2E_HUB_URL:-http://localhost:4318}"
REF="${1:-dev}"
MEMBER="${2:-}"
FILTER="${3:-}"

if [ -z "$MEMBER" ]; then
  MEMBER=$(curl -sf "$HUB/api/pool/status" | jq -r '.members[0].id // empty')
  [ -n "$MEMBER" ] || { echo "no pool members registered at $HUB — pass one explicitly" >&2; exit 1; }
fi

ID="maiterm-e2e:${MEMBER}:${REF//\//_}:$(date +%s)"
BODY=$(jq -n --arg id "$ID" --arg ref "$REF" --arg f "$FILTER" \
  '{directiveId: $id, kind: "maiterm-e2e", payload: ({ref: $ref} + (if $f != "" then {testFilter: $f} else {} end))}')
curl -sf -X POST "$HUB/api/pool/members/$MEMBER/directives" \
  -H 'content-type: application/json' -d "$BODY" > /dev/null
echo "dispatched $ID -> member '$MEMBER' (ref $REF${FILTER:+, filter $FILTER})"
echo "waiting (clone+debug-build+suite can take ~5-20 min on a cold member)..."

while true; do
  ROW=$(curl -sf "$HUB/api/pool/directives/$ID") || { echo "hub unreachable" >&2; exit 2; }
  STATE=$(jq -r .state <<< "$ROW")
  case "$STATE" in
    succeeded)
      echo "maiterm e2e GREEN at $REF on $MEMBER"
      exit 0
      ;;
    failed)
      echo "maiterm e2e FAILED at $REF on $MEMBER:" >&2
      jq -r '.outcome.error // .outcome // "no outcome detail"' <<< "$ROW" >&2
      exit 1
      ;;
    *) sleep 15 ;;
  esac
done
