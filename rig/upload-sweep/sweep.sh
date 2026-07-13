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
# Sweeps the SLOTS x RECORDS_SET x FILL_SET cross-product. REPEATS duplicates each
# cell, and the complete point list is shuffled when `shuf` is available. Points
# remain serial.
#
# RBOX_API is mandatory. Production is refused because this creates junk workspaces
# and thousands of junk blobs; ALLOW_PROD=1 is the conscious operator override.
# RBOX_API only sets the client's DEFAULT remote — stored credentials win
# (init-plan.ts / e2ee-client.ts) — so after init the EFFECTIVE remote in
# ~/.rbox/credentials.json is asserted against RBOX_API before any point runs.
#
# Usage:
#   RBOX=/path/to/branch/rbox RBOX_API=https://rbox-dev-api.<acct>.workers.dev ./sweep.sh
# Env overrides: SRC (~/code), ROOT (/tmp/rbox-sweep), TARGET_BYTES (400 MiB),
#   MAX_FILE (256 KiB), SLOTS ("24"), RECORDS_SET ("32"), FILL_SET ("v1"),
#   REPEATS (1), MAIN_ROOT (~/Development), ALLOW_PROD (1 to override refusal).
set -euo pipefail

RBOX=${RBOX:?set RBOX to the branch-built rbox binary}
RBOX_API=${RBOX_API:?set RBOX_API to the dev worker base URL (e.g. https://rbox-dev-api.<acct>.workers.dev); the sweep refuses to run against prod}
SRC=${SRC:-$HOME/code}
ROOT=${ROOT:-/tmp/rbox-sweep}
TARGET_BYTES=${TARGET_BYTES:-$((400 * 1024 * 1024))}
MAX_FILE=${MAX_FILE:-$((256 * 1024))}
SLOTS=${SLOTS:-"24"}
RECORDS_SET=${RECORDS_SET:-${RECORDS:-32}}
FILL_SET=${FILL_SET:-"v1"}
REPEATS=${REPEATS:-1}
# Wire twin of the client clamp (config.ts BATCH_RECORDS_FLOOR): fill-v1 records
# are capped here, so a v1/records>floor cell would run clamped but be mislabeled.
BATCH_RECORDS_FLOOR=32
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

TEARDOWN_DONE=0
teardown() {
  # Armed (trap EXIT) once the daemon is stopped/identity clobbered, so an abort
  # mid-sweep still restores the host. Idempotent: the happy path calls it too.
  if [ "$TEARDOWN_DONE" = 1 ]; then return 0; fi
  TEARDOWN_DONE=1
  log "teardown: restore identity + restart main daemon"
  restore_identity
  "$INSTALLED_RBOX" start "$MAIN_ROOT" >/dev/null 2>&1 || echo "WARN: could not restart main daemon — start it manually" >&2
}

assert_effective_remote() {
  # RBOX_API is only the client DEFAULT: stored credentials override it for sync
  # (e2ee-client.ts `creds.remoteUrl ?? cfg.remoteUrl`; init gets an explicit
  # --remote). Refuse to sweep if the credential the points will actually use
  # names a different remote than RBOX_API.
  local eff
  eff=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("remoteUrl") or "")' \
    "$HOME/.rbox/credentials.json" 2>/dev/null || true)
  [ -n "$eff" ] || return 0 # no stored remote — the RBOX_API default applies
  if [ "${eff%/}" != "${RBOX_API%/}" ]; then
    printf '%s\n' \
      "ERROR: effective remote is $eff — stored credentials override RBOX_API=$RBOX_API." \
      "Log in against the target first (RBOX_API=$RBOX_API rbox login) or move" \
      "\$HOME/.rbox/credentials.json aside, then re-run." >&2
    exit 1
  fi
}

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
  # The awk byte-budget cutoff exits early when SRC exceeds TARGET_BYTES; find then
  # dies of SIGPIPE (141), which pipefail would turn into a script abort — tolerate
  # exactly that exit code (found the hard way on flat-meadow's 13G corpus).
  ( cd "$SRC" && { find . -type d -name .git -prune -o -type f -printf '%s\t%P\n' 2>/dev/null || [ "$?" -eq 141 ]; } \
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
  # shellcheck disable=SC2016  # deliberate: the inner bash expands $0/$1/$2, not this shell
  find "$DATA" -type f -print0 | xargs -0 -P16 -I{} \
    bash -c 'printf "\n# rbox-sweep point %s %s\n" "$0" "$1" >> "$2"' "$point" "$nonce" {}
}

init_workspace() {
  log "init bench workspace (single clobber; main daemon stopped)"
  trap teardown EXIT
  "$INSTALLED_RBOX" stop "$MAIN_ROOT" >/dev/null 2>&1 || true
  rm -rf "$WS"; mkdir -p "$WS"
  ( cd "$WS" && setsid env RBOX_API="$RBOX_API" RBOX_METRICS=1 "$RBOX" init --new --no-interactive --git false \
      --remote "$RBOX_API" > "$ROOT/init.log" 2>&1 < /dev/null & echo "$!" > "$ROOT/init.pid" )
  local waited=0
  until grep -q "rbox is set up" "$ROOT/init.log" 2>/dev/null; do
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge 300 ]; then echo "ERROR: init did not finish in 300s" >&2; cat "$ROOT/init.log" >&2; exit 1; fi
  done
  local pid pgid; pid=$(cat "$ROOT/init.pid")
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  if [ -n "$pgid" ]; then kill -- "-$pgid" 2>/dev/null || true; fi
  sleep 2
  WSID=$(grep -oE 'ws_[0-9a-f]+' "$ROOT/init.log" | head -1 || echo "unknown")
  echo "bench workspace: $WSID"
}

run_point() {
  local slots="$1" records="$2" fill="$3" idx="$4"
  log "point $idx: slots=$slots records=$records fill=$fill"
  salt_corpus "$idx"
  local bytes; bytes=$(du -sb "$DATA" | cut -f1)
  local plog="$OUT/point-${idx}-s${slots}-r${records}-f${fill}.log"
  local t0 t1; t0=$(date +%s.%N)
  ( cd "$WS" && env RBOX_API="$RBOX_API" RBOX_UPLOAD_SLOTS="$slots" \
      RBOX_BATCH_RECORDS="$records" RBOX_BATCH_FILL="$fill" RBOX_LANE_TIMING=1 \
      RBOX_METRICS=1 "$RBOX" sync > "$plog" 2>&1 < /dev/null ) || echo "WARN: sync exit $?" >&2
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
  # Total client-side slot work = the lane line's total `upload U.Us (NN%)` token
  # (sum of per-request HTTP durations). The `s (` suffix keeps the per-blob
  # `upload Y.Yms` token from matching.
  local slot_work_s
  slot_work_s=$(echo "$laneline" | grep -oE 'upload [0-9.]+s \(' | head -1 | grep -oE '[0-9.]+' | head -1 || echo "")
  local dispatch_raw dispatch_text
  dispatch_text=$(echo "$laneline" | sed -n 's/.* · dispatch //p')
  dispatch_raw=$(printf '%s' "$dispatch_text" | tr ' ' ';')
  [ -n "$dispatch_raw" ] || dispatch_raw=NA
  # Missing dispatch telemetry (no lane line, or a client without the segment)
  # must stay NA, never six genuine zeros — zeros would fabricate a dominance verdict.
  local d_full_records d_full_bytes d_fixed_timer d_quiet d_absolute d_idle_tail
  if [ "$dispatch_raw" = "NA" ]; then
    d_full_records=NA; d_full_bytes=NA; d_fixed_timer=NA; d_quiet=NA; d_absolute=NA; d_idle_tail=NA
  else
    read -r d_full_records d_full_bytes d_fixed_timer d_quiet d_absolute d_idle_tail < <(
      awk -v dispatch="$dispatch_text" 'BEGIN {
        # order mirrors uploadDispatchReasons (src/cli/upload-lane-timing.ts)
        split("full_records full_bytes fixed_timer quiet absolute idle_tail", reasons, " ")
        for (i = 1; i <= 6; i++) count[reasons[i]] = 0
        n = split(dispatch, token, " ")
        for (i = 1; i <= n; i++) {
          split(token[i], field, ":")
          if (field[1] in count) {
            sub(/\(.*/, "", field[2]); count[field[1]] = field[2] + 0
          }
        }
        for (i = 1; i <= 6; i++) printf "%d%s", count[reasons[i]], (i == 6 ? ORS : OFS)
      }'
    )
  fi
  # ciphertext wire bytes (the sync summary's wire= token) — compression makes this
  # much smaller than plaintext, and it's the honest basis for link-utilization Mbps.
  local wire_mb; wire_mb=$(grep -oE 'wire=[0-9.]+MB' "$plog" | head -1 | grep -oE '[0-9.]+' | head -1 || echo "")
  local wall_mbps up_mbps wire_mbps up_blobps
  wall_mbps=$(awk -v b="$bytes" -v w="$wall" 'BEGIN{ if(w>0) printf "%.1f", (b*8)/(w*1e6); else print "0" }')
  up_mbps=$(awk -v b="$bytes" -v u="${up_ms:-0}" 'BEGIN{ if(u>0) printf "%.1f", (b*8)/(u*1000); else print "NA" }')
  wire_mbps=$(awk -v w="${wire_mb:-0}" -v u="${up_ms:-0}" 'BEGIN{ if(u>0 && w>0) printf "%.1f", (w*8*1000)/u; else print "NA" }')
  up_blobps=$(awk -v n="$blobs" -v u="${up_ms:-0}" 'BEGIN{ if(u>0) printf "%.0f", n/(u/1000); else print "NA" }')
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$slots" "$records" "$fill" "$bytes" "$blobs" "$wall" "${up_ms:-NA}" \
    "${enc_ms:-NA}" "$wall_mbps" "$up_mbps" "${wire_mb:-NA}" "$wire_mbps" \
    "$up_blobps" "${upms:-NA}" "${slot_work_s:-NA}" "$d_full_records" \
    "$d_full_bytes" "$d_fixed_timer" "$d_quiet" "$d_absolute" "$d_idle_tail" \
    "$dispatch_raw" "$RBOX_API" "$BUILD" >> "$CSV"
  echo "  wall=${wall}s up_crit=${up_ms:-NA}ms enc=${enc_ms:-NA}ms blobs=${blobs} wire=${wire_mb:-NA}MB"
  echo "  => UPLOAD-LANE ${up_mbps} Mbps plaintext / ${wire_mbps} Mbps wire / ${up_blobps} blobs-s   |   wall ${wall_mbps} Mbps"
  echo "  lane: $laneline"
  echo "  fp:   $fpline"
}

emit_gates() {
  # Columns are resolved by header name (col[]), never by position — the schema
  # is actively growing and a silent index shift would poison a verdict.
  awk -F, '
    # ≥10% mean slot-work reduction of cand over base (design 112 gates 4/fill).
    function gate_line(label, base, cand,   m1, m2, reduction) {
      if (!(base in seen) || !(cand in seen) || slot_na[base] || slot_na[cand] || !slot_n[base] || !slot_n[cand] || slot_sum[base] <= 0)
        return sprintf("- %s: n/a (missing cell)", label)
      m1 = slot_sum[base] / slot_n[base]; m2 = slot_sum[cand] / slot_n[cand]
      reduction = (m1 - m2) / m1
      return sprintf("- %s: baseline=%.3fs, candidate=%.3fs; reduction=%.1f%% — %s", label, m1, m2, reduction * 100, reduction >= 0.1 ? "PASS" : "FAIL")
    }
    BEGIN { split("d_full_records d_full_bytes d_fixed_timer d_quiet d_absolute d_idle_tail", dnames, " ") }
    NR == 1 { for (i = 1; i <= NF; i++) col[$i] = i; next }
    {
      s = $(col["slots"]); r = $(col["records"]); f = $(col["fill"])
      cell = s SUBSEP r SUBSEP f
      seen[cell] = 1; pairs[s SUBSEP r] = 1
      # NA dispatch rows carry no telemetry — exclude them from dispatch means
      # entirely rather than diluting the cell with zeros.
      if ($(col["d_full_records"]) != "NA") {
        dispatch_n[cell]++
        for (i = 1; i <= 6; i++) dsum[cell, dnames[i]] += $(col[dnames[i]])
      }
      sw = $(col["slot_work_s"])
      if (sw == "NA" || sw == "") slot_na[cell] = 1
      else { slot_sum[cell] += sw; slot_n[cell]++ }
      if (f == "v2" && (!(s in base_record) || (r + 0) < base_record[s])) base_record[s] = r + 0
    }
    END {
      print "## Gates (design 112)"
      print ""
      print "### fill-v1 dominance baseline"
      found = 0
      for (cell in seen) {
        split(cell, key, SUBSEP)
        if (key[3] != "v1") continue
        found = 1
        if (!dispatch_n[cell]) {
          printf "- slots=%s records=%s: n/a (missing dispatch telemetry)\n", key[1], key[2]
          continue
        }
        fixed = dsum[cell, "d_fixed_timer"] / dispatch_n[cell]
        idle = dsum[cell, "d_idle_tail"] / dispatch_n[cell]
        total = 0
        for (i = 1; i <= 6; i++) total += dsum[cell, dnames[i]] / dispatch_n[cell]
        share = total > 0 ? (fixed + idle) / total : 0
        verdict = share > 0.5 ? "DOMINANT" : "NOT DOMINANT — causal claim not supported"
        printf "- slots=%s records=%s: fixed_timer=%.2f, idle_tail=%.2f, total=%.2f; %.1f%% — %s\n", key[1], key[2], fixed, idle, total, share * 100, verdict
      }
      if (!found) print "- n/a (missing cell)"
      print ""
      print "### fill gate — matched cell, v2 vs v1 (baseline=v1)"
      found = 0
      for (pair in pairs) {
        split(pair, key, SUBSEP)
        found = 1
        print gate_line(sprintf("slots=%s records=%s", key[1], key[2]), pair SUBSEP "v1", pair SUBSEP "v2")
      }
      if (!found) print "- n/a (missing cell)"
      print ""
      print "### cap gate — matched fill-v2 cells (baseline=lowest v2 records)"
      found = 0
      for (cell in seen) {
        split(cell, key, SUBSEP)
        if (key[3] != "v2" || (key[2] + 0) <= base_record[key[1]]) continue
        found = 1
        print gate_line(sprintf("slots=%s records=%s vs %s", key[1], key[2], base_record[key[1]]), key[1] SUBSEP base_record[key[1]] SUBSEP "v2", cell)
      }
      if (!found) print "- n/a (missing cell)"
    }
  ' "$CSV"
}

emit_markdown() {
  {
    echo "# Upload concurrency sweep — $(hostname) — $(date -u +%FT%TZ)"
    echo
    echo "API: \`$RBOX_API\`. Build: \`$BUILD\`. Corpus: $(cat "$OUT/corpus.txt"). Bench workspace: \`${WSID:-unknown}\` (junk — delete server-side)."
    echo
    echo "| slots | records | fill | MB | blobs | wall s | up-crit s | enc s | UPLOAD Mbps | wire MB | wire Mbps | up blobs/s | wall Mbps | per-blob up ms | slot work s | dispatch |"
    echo "|---:|---:|:---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|"
    while IFS=, read -r s r f b n w upms encms wm um wmb wmbps ubp pbu sw _ _ _ _ _ _ dispatch _; do
      [ "$s" = "slots" ] && continue
      printf '| %s | %s | %s | %.0f | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
        "$s" "$r" "$f" "$(awk -v x="$b" 'BEGIN{print x/1048576}')" "$n" "$w" \
        "$(awk -v x="$upms" 'BEGIN{if(x=="NA")print "NA"; else printf "%.1f", x/1000}')" \
        "$(awk -v x="$encms" 'BEGIN{if(x=="NA")print "NA"; else printf "%.1f", x/1000}')" \
        "$um" "$wmb" "$wmbps" "$ubp" "$wm" "$pbu" "$sw" "$dispatch"
    done < "$CSV"
    echo
    emit_gates
  } > "$MD"
  echo; cat "$MD"
}

main() {
  if [[ "${RBOX_API,,}" == *api.rbox.to* && "${ALLOW_PROD:-0}" != "1" ]]; then
    printf '%s\n' \
      "REFUSING production upload sweep." \
      "This sweep creates junk workspaces and thousands of junk blobs." \
      "Point RBOX_API at the dev worker." \
      "A conscious operator override is ALLOW_PROD=1." >&2
    exit 1
  fi
  case "$REPEATS" in '' | 0 | *[!0-9]*)
    echo "ERROR: REPEATS must be a positive integer (got '$REPEATS')" >&2; exit 1 ;;
  esac
  mkdir -p "$OUT"
  # Build and validate the point list BEFORE any side effect (daemon stop,
  # identity clobber), so bad axis input can never strand the host mid-sweep.
  local points="$OUT/points.txt" shuffled="$OUT/points-shuffled.txt"
  local -a slot_values record_values fill_values
  read -r -a slot_values <<< "$SLOTS"
  read -r -a record_values <<< "$RECORDS_SET"
  read -r -a fill_values <<< "$FILL_SET"
  local tok
  for tok in "${slot_values[@]}" "${record_values[@]}"; do
    case "$tok" in 0 | *[!0-9]*)
      echo "ERROR: SLOTS/RECORDS_SET tokens must be positive integers (got '$tok')" >&2; exit 1 ;;
    esac
  done
  for tok in "${fill_values[@]}"; do
    case "$tok" in v1 | v2) ;; *)
      echo "ERROR: FILL_SET tokens must be v1|v2 (got '$tok' — the client treats anything but v2 as v1)" >&2; exit 1 ;;
    esac
  done
  : > "$points"
  local repeat s records fill
  for ((repeat = 1; repeat <= REPEATS; repeat++)); do
    for s in "${slot_values[@]}"; do
      for records in "${record_values[@]}"; do
        for fill in "${fill_values[@]}"; do
          # Skip clamped cells instead of mislabeling them (see BATCH_RECORDS_FLOOR).
          if [ "$fill" = "v1" ] && [ "$records" -gt "$BATCH_RECORDS_FLOOR" ]; then
            [ "$repeat" = 1 ] && echo "NOTE: skipping v1 records=$records cell — the client clamps fill-v1 records to $BATCH_RECORDS_FLOOR" >&2
            continue
          fi
          printf '%s %s %s\n' "$s" "$records" "$fill" >> "$points"
        done
      done
    done
  done
  if ! [ -s "$points" ]; then echo "ERROR: no runnable points (empty axes after validation)" >&2; exit 1; fi
  BUILD=$("$RBOX" --version 2>/dev/null | head -1 | tr -d '\n' | tr ',' ';' || true)
  [ -n "$BUILD" ] || BUILD=unknown
  echo "slots,records,fill,bytes,blobs,wall_s,up_crit_ms,enc_ms,wall_mbps,upload_mbps,wire_mb,wire_mbps,upload_blobs_per_s,per_blob_up_ms,slot_work_s,d_full_records,d_full_bytes,d_fixed_timer,d_quiet,d_absolute,d_idle_tail,dispatch_raw,api,build" > "$CSV"
  assert_effective_remote # pre-existing credential: refuse before ANY side effect
  build_corpus
  init_workspace
  assert_effective_remote # re-check what init/login actually left behind
  if command -v shuf >/dev/null 2>&1; then shuf "$points" > "$shuffled"; else cp "$points" "$shuffled"; fi
  local idx=0
  while read -r s records fill; do
    idx=$((idx + 1))
    run_point "$s" "$records" "$fill" "$idx"
  done < "$shuffled"
  teardown
  emit_markdown
  echo; echo "DONE. Results: $CSV / $MD"
}

main "$@"
