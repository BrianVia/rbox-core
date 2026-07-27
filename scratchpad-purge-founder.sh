#!/usr/bin/env bash
# Founder-account manual purge — drops ALL version history (head survives) and
# drains stranded refs NOW instead of over ~3 weeks of 2000-row cron ticks.
#
# RUN AS:  ! bash scratchpad-purge-founder.sh          (from the repo root)
# PRECONDITION: rbox daemons STOPPED on all three hosts:
#   via-desktop-ubuntu / dfinitiv-macbook-pro / flat-meadow-prod-main-01:
#     cd ~/Development && ~/.rbox/bin/rbox stop
#
# What it does (all existing admin routes; no code shipped):
#   1. plan -> none            (retentionDays=0; Ryan's account NOT affected)
#   2. gc?phase=retention      (workspace DO floors to head-1; head never prunes)
#   3. plan -> pro&extraGB=100 (restores tier AND the +100GiB bump set-plan would clobber)
#   4. loop gc?phase=phase1&graceMs=0 until two consecutive all-zero rounds
#      (each call marks+purges <=2000 rows and releases used_bytes atomically)
set -euo pipefail
cd "$(dirname "$0")"
set -a; source prod-keys.local.secret; set +a
ACCT="acct_b4e0b8146b8535d7"
API="https://api.rbox.to"
AUTH=(-H "x-rbox-platform: ${RBOX_PLATFORM_SECRET}")

echo "== 1/4 plan -> none"
curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/account/$ACCT/plan?plan=none"; echo

echo "== 2/4 retention prune (floors to head-1 under retentionDays=0)"
curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/gc?phase=retention"; echo
# Sanity: the JSON above must show a nonzero floor/pruned for ws_2b6e15da….
# If it shows inGrace/skip for the account, STOP and report back.

echo "== 3/4 plan -> pro + extraGB=100 restored"
curl -fsS -X POST "${AUTH[@]}" "$API/v1/admin/account/$ACCT/plan?plan=pro&extraGB=100"; echo

echo "== 4/4 phase1 mark+purge loop (graceMs=0) — watch purged/released fall"
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
echo "done — restart daemons (rbox start) and check rbox status; expect ~4.3GiB used."
