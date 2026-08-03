#!/usr/bin/env bash
# Round 2 — history prune. Round 1's plan-flip stamped grace_until (design-13
# downgrade grace), and retentionPrune skips any account with live grace, so
# perWorkspace came back empty. This round clears grace atomically with the
# plan flip via D1 SQL, runs retention (floors -> head-1), restores pro+100.
# Run AFTER the round-1 phase1 loop exits, daemons still stopped:
#   ! bash scripts/purge-founder-history-2.sh
set -euo pipefail
cd "$(dirname "$0")"
set -a; source prod-keys.local.secret; source ~/.secret_env_vars; set +a
ACCT="acct_b4e0b8146b8535d7"
API="https://api.rbox.to"
AUTH=(-H "x-rbox-platform: ${RBOX_PLATFORM_SECRET}")

echo "== 1/4 plan -> none WITH grace cleared (single D1 statement)"
(cd apps/api && npx wrangler d1 execute rbox-prod-db --remote --env production \
  --command "UPDATE accounts SET plan='none', grace_until=NULL WHERE id='${ACCT}'")

echo "== 2/4 retention prune — perWorkspace MUST now show ws_2b6e15da… with a floor"
curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/gc?phase=retention"; echo

echo "== 3/4 restore pro + extraGB=100"
curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/account/$ACCT/plan?plan=pro&extraGB=100"; echo

echo "== 4/4 phase1 loop (graceMs=0) — history refs now unreachable, watch released climb"
zeros=0
for i in $(seq 1 900); do
  out=$(curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/gc?phase=phase1&graceMs=0")
  echo "[$i] $out"
  if echo "$out" | grep -Eq '"marked":\s*0.*"purged":\s*0|"purged":\s*0.*"marked":\s*0'; then
    zeros=$((zeros+1)); [ "$zeros" -ge 25 ] && break
  else
    zeros=0
  fi
  sleep 1
done
echo "done — rbox start on all hosts; expect ~4.3GiB used."
