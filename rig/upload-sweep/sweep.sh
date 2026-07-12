#!/usr/bin/env bash
# Upload-concurrency sweep harness (design 101 / uploader ceiling re-measure).
#
# Runs ON a benchmark host (e.g. flat-meadow), SEQUENTIALLY, one config point at a
# time — never parallel publishes. It isolates the blob-batch PUT lane (the ~35 Mbps
# ceiling) by building a subset corpus of SMALL (<=256 KiB) non-.git files and
# disabling git-sync, so multipart/git-pack traffic never pollutes the measurement.
#
# Design: ONE workspace, ONE `rbox init --new` for the whole sweep (a single device-
# identity clobber). The main daemon is stopped for the duration so the clobber is
# inert; each point re-salts every file (fresh content -> fresh blobs -> a real
# re-upload) and runs a foreground `rbox sync` with the concurrency knob set.
#
# Records is pinned at the server wire cap (32): apps/api MAX_BATCH_RECORDS rejects
# larger batches with 400, so the records axis is un-runnable against a live server
# without a coordinated server bump. Only the client-side SLOTS axis is swept here.
#
# Usage:
#   RBOX=/path/to/branch/rbox ./sweep.sh
# Env overrides: SRC (~/code), ROOT (/tmp/rbox-sweep), TARGET_BYTES (400 MiB),
#   MAX_FILE (256 KiB), SLOTS ("24 48 96 192"), RECORDS (32), MAIN_ROOT (~/Development).
set -euo pipefail

RBOX=${RBOX:?set RBOX to the branch-built rbox binary}
SRC=${SRC:-$HOME/code}
ROOT=${ROOT:-/tmp/rbox-sweep}
TARGET_BYTES=${TARGET_BYTES:-$((400 * 1024 * 1024))}
MAX_FILE=${MAX_FILE:-$((256 * 1024))}
SLOTS=${SLOTS:-"24 48 96 192"}
RECORDS=${RECORDS:-32}
MAIN_ROOT=${MAIN_ROOT:-$HOME/Development}
BACKUP=${BACKUP:-/tmp/rbox-id-backup}
# The host's real daemon must stop/start via the INSTALLED binary, never the
# bench build — `$RBOX start` would leave production running branch code.
INSTALLED_RBOX=${INSTALLED_RBOX:-$HOME/.rbox/bin/rbox}
[ -x "$INSTALLED_RBOX" ] || INSTALLED_RBOX="$RBOX"
WS="$ROOT/ws"
DATA="$WS/data"
BASE="$ROOT/corpus-base"
OUT="$ROOT/results"
CSV="$OUT/sweep.csv"
MD="$OUT/sweep.md"

log() { printf '\n=== %s ===\n' "$*"; }

restore_identity() {
  # Put the host's real device identity back after init clobbered ~/.rbox.
  if [ -d "$BACKUP/e2ee" ]; then
    rm -rf "$HOME/.rbox/e2ee"
    cp -a "$BACKUP/e2ee" "$HOME/.rbox/e2ee"
    cp -a "$BACKUP/credentials.json" "$HOME/.rbox/credentials.json"
    echo "identity restored from $BACKUP"
  else
    echo "WARN: no identity backup at $BACKUP — skipping restore" >&2
  fi
}

build_corpus() {
  log "building subset corpus from $SRC (<= $MAX_FILE B/file, target $TARGET_BYTES B, skip .git)"
  rm -rf "$BASE"; mkdir -p "$BASE"
  # Walk order + size cap + byte budget in one pass: find's own stat (-printf),
  # one awk cutoff, one bulk cpio copy — O(1) process spawns instead of the
  # 3-forks-per-file loop this replaces (~3 min for 36k files on the bench host).
  # Newline-separated paths are fine for a code corpus (no newline filenames).
  ( cd "$SRC" && find . -type d -name .git -prune -o -type f -printf '%s\t%P\n' 2>/dev/null \
      | awk -F'\t' -v max="$MAX_FILE" -v target="$TARGET_BYTES" \
          '$1 > 0 && $1 <= max { print $2; total += $1; if (total >= target) exit }' \
      | cpio -pdm --quiet "$BASE" )
  local count total
  count=$(find "$BASE" -type f | wc -l); total=$(du -sb --apparent-size "$BASE" | cut -f1)
  echo "corpus: $count files, $total bytes" | tee "$OUT/corpus.txt"
}

salt_corpus() {
  # point index $1: overwrite DATA from BASE, then append a per-point nonce to
  # every file so all content hashes are fresh and the whole set re-uploads.
  # One nonce per point suffices (files already differ from each other).
  local point="$1"
  local nonce; nonce=$(date +%s%N)
  rm -rf "$DATA"; cp -a "$BASE" "$DATA"
  find "$DATA" -type f -print0 | xargs -0 -P16 -I{} \
    bash -c 'printf "\n# rbox-sweep point %s %s\n" "$0" "$1" >> "$2"' "$point" "$nonce" {}
}

init_workspace() {
  log "init bench workspace (single clobber; main daemon stopped)"
  "$INSTALLED_RBOX" stop "$MAIN_ROOT" >/dev/null 2>&1 || true
  rm -rf "$WS"; mkdir -p "$WS"
  ( cd "$WS" && setsid env RBOX_METRICS=1 "$RBOX" init --new --no-interactive --git false \
      > "$ROOT/init.log" 2>&1 < /dev/null & echo $! > "$ROOT/init.pid" )
  local waited=0
  until grep -q "rbox is set up" "$ROOT/init.log" 2>/dev/null; do
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge 300 ]; then echo "ERROR: init did not finish in 300s" >&2; cat "$ROOT/init.log" >&2; exit 1; fi
  done
  local pid pgid; pid=$(cat "$ROOT/init.pid")
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  [ -n "$pgid" ] && kill -- "-$pgid" 2>/dev/null || true
  sleep 2
  WSID=$(grep -oE 'ws_[0-9a-f]+' "$ROOT/init.log" | head -1 || echo "unknown")
  echo "bench workspace: $WSID"
}

run_point() {
  local slots="$1" idx="$2"
  log "point $idx: slots=$slots records=$RECORDS"
  salt_corpus "$idx"
  local bytes; bytes=$(du -sb "$DATA" | cut -f1)
  local plog="$OUT/point-s${slots}-r${RECORDS}.log"
  local t0 t1; t0=$(date +%s.%N)
  ( cd "$WS" && env RBOX_UPLOAD_SLOTS="$slots" RBOX_BATCH_RECORDS="$RECORDS" \
      RBOX_LANE_TIMING=1 RBOX_METRICS=1 "$RBOX" sync > "$plog" 2>&1 ) || echo "WARN: sync exit $?" >&2
  t1=$(date +%s.%N)
  local wall; wall=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')
  local laneline; laneline=$(grep -oE 'lane timing \(push\):.*' "$plog" | head -1 || echo "")
  local fpline; fpline=$(grep -oE 'fp ready.*' "$plog" | head -1 || echo "")
  local blobs; blobs=$(echo "$laneline" | grep -oE '[0-9]+ blobs' | grep -oE '[0-9]+' | head -1 || echo 0)
  [ -z "$blobs" ] && blobs=0
  # upload critical path (elapsed upload-phase wall) and encrypt wall, from FirstPublishStats.
  local up_ms enc_ms; up_ms=$(echo "$fpline" | grep -oE ' up[0-9]+' | grep -oE '[0-9]+' | head -1 || echo "")
  enc_ms=$(echo "$fpline" | grep -oE ' enc[0-9]+' | grep -oE '[0-9]+' | head -1 || echo "")
  # per-blob upload ms from the lane-timing line (x RECORDS ~= per-batch round trip proxy)
  local upms; upms=$(echo "$laneline" | grep -oE 'upload [0-9.]+ms' | grep -oE '[0-9.]+' | tail -1 || echo "")
  # ciphertext wire bytes (the sync summary's wire= token) — compression makes this
  # much smaller than plaintext, and it's the honest basis for link-utilization Mbps.
  local wire_mb; wire_mb=$(grep -oE 'wire=[0-9.]+MB' "$plog" | head -1 | grep -oE '[0-9.]+' | head -1 || echo "")
  local wall_mbps up_mbps wire_mbps up_blobps
  wall_mbps=$(awk -v b="$bytes" -v w="$wall" 'BEGIN{ if(w>0) printf "%.1f", (b*8)/(w*1e6); else print "0" }')
  up_mbps=$(awk -v b="$bytes" -v u="${up_ms:-0}" 'BEGIN{ if(u>0) printf "%.1f", (b*8)/(u*1000); else print "NA" }')
  wire_mbps=$(awk -v w="${wire_mb:-0}" -v u="${up_ms:-0}" 'BEGIN{ if(u>0 && w>0) printf "%.1f", (w*8*1000)/u; else print "NA" }')
  up_blobps=$(awk -v n="$blobs" -v u="${up_ms:-0}" 'BEGIN{ if(u>0) printf "%.0f", n/(u/1000); else print "NA" }')
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$slots" "$RECORDS" "$bytes" "$blobs" "$wall" "${up_ms:-NA}" "${enc_ms:-NA}" "$wall_mbps" "${up_mbps}" "${wire_mb:-NA}" "${wire_mbps}" "${up_blobps}" "${upms:-NA}" >> "$CSV"
  echo "  wall=${wall}s up_crit=${up_ms:-NA}ms enc=${enc_ms:-NA}ms blobs=${blobs} wire=${wire_mb:-NA}MB"
  echo "  => UPLOAD-LANE ${up_mbps} Mbps plaintext / ${wire_mbps} Mbps wire / ${up_blobps} blobs-s   |   wall ${wall_mbps} Mbps"
  echo "  lane: $laneline"
  echo "  fp:   $fpline"
}

emit_markdown() {
  {
    echo "# Upload concurrency sweep — $(hostname) — $(date -u +%FT%TZ)"
    echo
    echo "Corpus: $(cat "$OUT/corpus.txt"). Bench workspace: \`${WSID:-unknown}\` (junk — delete server-side)."
    echo "Records pinned at $RECORDS (server wire cap). Slots axis only."
    echo
    echo "| slots | records | MB | blobs | wall s | up-crit s | enc s | UPLOAD Mbps | wire MB | wire Mbps | up blobs/s | wall Mbps | per-blob up ms |"
    echo "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    while IFS=, read -r s r b n w upms encms wm um wmb wmbps ubp pbu; do
      [ "$s" = "slots" ] && continue
      printf '| %s | %s | %.0f | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
        "$s" "$r" "$(awk -v x="$b" 'BEGIN{print x/1048576}')" "$n" "$w" \
        "$(awk -v x="$upms" 'BEGIN{if(x=="NA")print "NA"; else printf "%.1f", x/1000}')" \
        "$(awk -v x="$encms" 'BEGIN{if(x=="NA")print "NA"; else printf "%.1f", x/1000}')" \
        "$um" "$wmb" "$wmbps" "$ubp" "$wm" "$pbu"
    done < "$CSV"
  } > "$MD"
  echo; cat "$MD"
}

main() {
  mkdir -p "$OUT"
  echo "slots,records,bytes,blobs,wall_s,up_crit_ms,enc_ms,wall_mbps,upload_mbps,wire_mb,wire_mbps,upload_blobs_per_s,per_blob_up_ms" > "$CSV"
  build_corpus
  init_workspace
  local idx=0
  for s in $SLOTS; do idx=$((idx + 1)); run_point "$s" "$idx"; done
  log "teardown: restore identity + restart main daemon"
  restore_identity
  "$INSTALLED_RBOX" start "$MAIN_ROOT" >/dev/null 2>&1 || echo "WARN: could not restart main daemon — start it manually" >&2
  emit_markdown
  echo; echo "DONE. Results: $CSV / $MD"
}

main "$@"
