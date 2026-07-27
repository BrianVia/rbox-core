#!/usr/bin/env bash
# Tight phase1 loop — replaces round-2's step 4 only (floors/plan already done).
# No sleep; two curls pipelined so the next request is in flight while the
# previous response prints. Server-side cursors serialize actual work, so
# concurrency >2 buys nothing. Exits after 25 consecutive all-zero rounds.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source prod-keys.local.secret; set +a
API="https://api.rbox.to"
AUTH=(-H "x-rbox-platform: ${RBOX_PLATFORM_SECRET}")
zeros=0
for i in $(seq 1 1200); do
  out=$(curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/gc?phase=phase1&graceMs=0")
  rel=$(echo "$out" | grep -o '"released":[0-9]*' | cut -d: -f2)
  echo "[$i] released=$((${rel:-0}/1048576))MiB  $out"
  if echo "$out" | grep -Eq '"marked":\s*0.*"purged":\s*0|"purged":\s*0.*"marked":\s*0'; then
    zeros=$((zeros+1)); [ "$zeros" -ge 25 ] && break
  else
    zeros=0
  fi
done
echo "loop quiet — check rbox status / used_bytes"
