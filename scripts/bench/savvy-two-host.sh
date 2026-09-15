#!/usr/bin/env bash
# §23 real-repo two-host benchmark: clone-fresh push of dfinitiv/savvy-core (host A),
# then pull on a fresh "host B" (same account, clean dir), verifying byte-identical
# passive sync + timing both. Runs the §23 binary against dev; compares to the legacy
# binary for a head-to-head. Requires the R2 S3 CopyObject creds to be set on the worker
# (else the get→put promote is a known regression — see docs/perf-improvements.md).
#
# Usage: scripts/bench/savvy-two-host.sh [N]   # N = file count (default 4294 = full repo)
set -euo pipefail

N="${1:-4294}"
REMOTE="${RBOX_API:-https://rbox-dev-api.brian-via.workers.dev}"
BOOT="${RBOX_DEV_BOOTSTRAP:?set RBOX_DEV_BOOTSTRAP (dev bootstrap secret, see dev-keys.local.secret)}"
S23_BIN="${S23_BIN:-/tmp/rbox-s23}"
SAVVY="${SAVVY_DIR:-$HOME/code/savvy-core}"
WORK=/tmp/rbox-savvy-bench
now() { python3 -c 'import time;print(time.time())'; }
elapsed() { python3 -c "print(f'{$2-$1:.1f}s')"; }

[ -x "$S23_BIN" ] || { echo "build the §23 binary first: bun build --compile src/cli/index.ts --outfile $S23_BIN"; exit 1; }
[ -d "$SAVVY" ] || { echo "clone savvy-core to $SAVVY first"; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"/{home,push,pullB}
export HOME="$WORK/home"

# corpus: first N real savvy-core files (excluding .git)
( cd "$SAVVY" && find . -type f ! -path './.git/*' | sort | head -"$N" > "$WORK/files.list" )
rsync -a --files-from="$WORK/files.list" "$SAVVY/" "$WORK/push/" 2>/dev/null
echo "[bench] corpus: $(find "$WORK/push" -type f | wc -l) files, $(du -sh "$WORK/push" | cut -f1)"

echo "[bench] enrolling fresh account…"
"$S23_BIN" login --bootstrap "$BOOT" --remote "$REMOTE" --no-interactive >/dev/null 2>&1
( cd "$WORK/push" && "$S23_BIN" init --new --no-interactive --remote "$REMOTE" >/dev/null 2>&1 )
WS=$(python3 -c "import json,glob;print(json.load(open(glob.glob('$WORK/push/.rbox/workspace.json')[0]))['workspaceId'])" 2>/dev/null || echo "?")

echo "[bench] HOST A — push $N files…"
A0=$(now); ( cd "$WORK/push" && "$S23_BIN" push >"$WORK/push.log" 2>&1 ); A1=$(now)
echo "[bench]   push wall: $(elapsed "$A0" "$A1")  ($(tail -1 "$WORK/push.log"))"

echo "[bench] HOST B — pull into a clean dir (passive sync)…"
( cd "$WORK/pullB" && "$S23_BIN" init --workspace "$WS" --no-interactive --remote "$REMOTE" >/dev/null 2>&1 )
B0=$(now); ( cd "$WORK/pullB" && "$S23_BIN" pull >"$WORK/pull.log" 2>&1 ); B1=$(now)
echo "[bench]   pull wall: $(elapsed "$B0" "$B1")  ($(tail -1 "$WORK/pull.log"))"

echo "[bench] verifying byte-identical…"
if diff -rq "$WORK/push" "$WORK/pullB" --exclude=.rbox >/dev/null 2>&1; then
  echo "[bench]   ✓ byte-identical passive sync ($(find "$WORK/pullB" -type f ! -path '*/.rbox/*' | wc -l) files)"
else
  echo "[bench]   ✗ DIFF DETECTED:"; diff -rq "$WORK/push" "$WORK/pullB" --exclude=.rbox | head
fi
echo "[bench] done. Query AE for blob.put dbCalls + commit storeMs to confirm the server-side split."
