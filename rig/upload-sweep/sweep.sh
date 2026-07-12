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
  local total=0 count=0
  # find in walk order; skip any .git dir; regular files only, within size cap.
  while IFS= read -r -d '' f; do
    local sz; sz=$(stat -c %s "$f" 2>/dev/null) || continue
    [ "$sz" -gt 0 ] && [ "$sz" -le "$MAX_FILE" ] || continue
    local rel="${f#$SRC/}"
    mkdir -p "$BASE/$(dirname "$rel")"
    cp -- "$f" "$BASE/$rel" 2>/dev/null || continue
    total=$((total + sz)); count=$((count + 1))
    [ "$total" -ge "$TARGET_BYTES" ] && break
  done < <(find "$SRC" -type d -name .git -prune -o -type f -print0 2>/dev/null)
  echo "corpus: $count files, $total bytes" | tee "$OUT/corpus.txt"
}

salt_corpus() {
  # point index $1: overwrite DATA from BASE, then append a unique nonce to every
  # file so all content hashes are fresh and the whole set re-uploads.
  local point="$1"
  rm -rf "$DATA"; cp -a "$BASE" "$DATA"
  find "$DATA" -type f -print0 | xargs -0 -P16 -I{} \
    bash -c 'printf "\n# rbox-sweep point %s %s\n" "$0" "$(date +%s%N)" >> "$1"' "$point" {}
}

parse_num() { grep -oE "$2" "$1" | head -1 | grep -oE '[0-9]+' | head -1 || true; }

init_workspace() {
  log "init bench workspace (single clobber; main daemon stopped)"
  "$RBOX" stop "$MAIN_ROOT" >/dev/null 2>&1 || true
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
  local blobs; blobs=$(grep -oE 'lane timing \(push\): [0-9]+ blobs' "$plog" | grep -oE '[0-9]+' | head -1 || echo 0)
  [ -z "$blobs" ] && blobs=0
  local mbps blobps upms
  mbps=$(awk -v b="$bytes" -v w="$wall" 'BEGIN{ if(w>0) printf "%.1f", (b*8)/(w*1e6); else print "0" }')
  blobps=$(awk -v n="$blobs" -v w="$wall" 'BEGIN{ if(w>0) printf "%.0f", n/w; else print "0" }')
  # per-blob upload ms from the lane-timing line (proxy: x RECORDS ~= per-batch round trip)
  upms=$(grep -oE 'upload [0-9.]+ms' "$plog" | grep -oE '[0-9.]+' | tail -1 || echo "")
  local laneline; laneline=$(grep -oE 'lane timing \(push\):.*' "$plog" | head -1 || echo "")
  local fpline; fpline=$(grep -oE 'fp ready.*' "$plog" | head -1 || echo "")
  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' "$slots" "$RECORDS" "$bytes" "$blobs" "$wall" "$mbps" "$blobps" "${upms:-NA}" >> "$CSV"
  echo "  wall=${wall}s bytes=${bytes} blobs=${blobs} => ${mbps} Mbps, ${blobps} blobs/s (per-blob upload ${upms:-NA}ms)"
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
    echo "| slots | records | plaintext MB | blobs | wall s | Mbps | blobs/s | per-blob up ms |"
    echo "|---:|---:|---:|---:|---:|---:|---:|---:|"
    while IFS=, read -r s r b n w m bp u; do
      [ "$s" = "slots" ] && continue
      printf '| %s | %s | %.0f | %s | %s | %s | %s | %s |\n' "$s" "$r" "$(awk -v x="$b" 'BEGIN{print x/1048576}')" "$n" "$w" "$m" "$bp" "$u"
    done < "$CSV"
  } > "$MD"
  echo; cat "$MD"
}

main() {
  mkdir -p "$OUT"
  echo "slots,records,bytes,blobs,wall_s,mbps,blobs_per_s,per_blob_up_ms" > "$CSV"
  build_corpus
  init_workspace
  local idx=0
  for s in $SLOTS; do idx=$((idx + 1)); run_point "$s" "$idx"; done
  log "teardown: restore identity + restart main daemon"
  restore_identity
  "$RBOX" start "$MAIN_ROOT" >/dev/null 2>&1 || echo "WARN: could not restart main daemon — start it manually" >&2
  emit_markdown
  echo; echo "DONE. Results: $CSV / $MD"
}

main "$@"
