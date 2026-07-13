# SPEC-114-fixes-r1 — adjudicated fixes from adversarial review round 1

Context: SPEC-114-impl.md + docs/design/114-blob-packing.md + REVIEW-114.md.
Same global constraints as SPEC-114-impl.md. Do not commit.

Adjudication note: review findings 12's rig/upload-sweep extensions (PACK_SET
axis, matched read cells, SIGINT rig histories) are DEFERRED to the promotion
phase (writer ships default-OFF; they are promotion-gate instruments). Finding
2 is adopted SCOPED (below), not as full 96/102 rig parity.

## Part A — SERVER (apps/api + shared engine; do not touch src/cli)

A1 (BLOCKER, finding 1) — staged GC modes. `RBOX_BLOB_PACK_GC` becomes a
mode: unset/"0" = off; "shadow" = read-only (runPackGc computes and RETURNS
would-resurrect/would-mark/would-open/would-delete counts, performs ZERO D1
writes beyond lease acquire/release and ZERO R2 ops — lease still taken so
shadow observes a stable view); "mark" = resurrect + mark passes only (no
open, no execute); "1" or "execute" = full. `packGcEnabled(env)` becomes
`packGcMode(env): "off"|"shadow"|"mark"|"execute"`. The uploading-orphan
sweeper (destructive) runs only in "execute" mode ("1"). Admin
`?phase=packs` honors the mode (409 pack_gc_disabled only when off). Update
env.ts doc comment + vitest binding stays "1". Tests: shadow performs no
writes (row-count snapshot before/after identical, R2 untouched) but reports
counts; mark mode marks but never opens/executes; property suite reruns key
fences in mark + execute modes (parameterize the relevant tests over mode
where cheap).

A2 (MAJOR, finding 6) — ready-verify checksum. In blobPackPut's ready-state
retry branch, verify the HEAD'd R2 object's stored checksum:
`object.checksums?.sha256` (ArrayBuffer) must hex-equal packSha; if the
platform returns no stored sha256 checksum, GET the object and hash it. 503
retry_later on mismatch, no receipts. Test: overwrite the pack object with
equal-length different bytes (direct bucket put WITHOUT sha option), same-id
retry → 503, no receipts.

A3 (MAJOR, finding 8) — issuedAt anchoring test pins the correct claim.
Rewrite the issuedAt test to capture `T_mark` as wall time bracketing the
mark INSERT's landing (tBefore = Date.now() just before executing the
INSERT; assert every previously-minted receipt payload `t` < tBefore, i.e.
issuedAt < T_mark — NOT `marked_at`, which the ledger rejected). Add one
interleaving test: wrap env.rbox_dev_db in a proxy that pauses the pack
fence-read statement (match on 'pack_gc_candidates WHERE pack_id') on a
barrier; start blobPackPut; while it is paused BEFORE the fence read
resolves, land a candidacy INSERT; release the barrier → the handler must
return 503 and mint nothing (fence read begun/completed after mark). And the
inverse order (fence read completes before the INSERT lands; response 200)
must still satisfy issuedAt < T_mark of the later mark.

A4 (MAJOR, finding 9) — same-id concurrent PUT test must observe operations.
Wrap the bucket in a recording proxy (put/delete/head with key log) passed
via a shim env; assert ZERO delete calls on the shared pack key across both
handlers, exactly the winner's bytes served afterwards, one ready inventory.

A5 (MAJOR, finding 14) — happy-path physical-write assertion: with the same
recording proxy, assert exactly ONE R2 put total, at packs/v1/<id>, and zero
puts to any blobKey.

A6 (MAJOR, finding 10, scoped) — one real repair-vs-sweeper interleaving:
using a barrier proxy on the R2 put (pause blobPackPut after inventory
insert, before R2 put), run sweepUploadingPacks past-grace (backdate
created_at/touched_at via direct UPDATE while paused), release; assert the
outcome is exactly one of the two legal terminals: (ready + inventoried +
object) or (swept tombstone + no receipts + heartbeat/ready CAS failed
closed) — and that a late object landing after tombstone is re-deleted by
the next sweep tick.

A7 (MAJOR, finding 11) — deterministic same-isolate resource cell: one
vitest test dispatching 6 concurrent direct blobPackPut invocations with
full-size (8 MiB) bodies overlapped with 4 concurrent 32-sha batch GETs of
mixed packed/canonical content in the same isolate; assert all complete
successfully (no throw/1102/OOM). Keep runtime sane (~seconds); reuse one
prebuilt body buffer per request (fresh Uint8Array copies where needed).

A8 (MAJOR, finding 7 server half) — metrics: pack PUT op gains phase timings
(parseMs, hashMs, r2Ms, fenceMs, receiptMs — numeric fields via the existing
emit/op patterns, mirroring emitRedeemPhases) and payload bytes; single GET
records packed-vs-canonical outcome (already distinct ops — ensure packed
reads emit their own op or outcome distinguishable from canonical, plus
requested bytes); batch GET emits one summary event per request: canonical
count, packed count, r2 range count, requestedBytes vs fetchedBytes
(covering). Privacy: numeric + enum only; extend the existing privacy tests
if they enumerate ops.

A9 (finding 2, SCOPED) — strengthen pack-gc property histories:
  - execute-cursor/process-kill resume: kill (return) mid-execute after the
    R2 delete but before the terminal batch (simulate by running executePage
    against a proxy that fails the terminal batch once), re-run runPackGc →
    converges: tombstone lands exactly once, no double-count, fence never
    retired early.
  - packed Phase-1 stale-snapshot history: a packed, head-reachable member
    marked by a stale Phase-1 snapshot (insert blob_ref_candidates directly)
    must not be retirable while blob_refs exist — gcPurge leaves the
    location; then check+GET still serve it.
  - logical-intent vs redemption race: open a logical intent (gc_candidates
    deleting_at) for a packed sha, then redeem a v2 receipt for it → the
    accounting super-batch 422s needsUpload (rbox_delete_fence via the blobs
    triggers) or leaves a live location — never partial publication (assert
    location+refs+quota consistent).
  - randomized history loop: extend the existing gates-1/6 smoke to N≥8
    iterations with a seeded RNG mixing {pack publish, redeem, logical
    retire, re-add, v1 displacement, pack GC tick in mark/execute mode,
    sweeper tick}, asserting after every step: every entitled+present sha
    resolves byte-identical via check+GET, and no pack object deleted while
    a location points at it. Log the seed on failure.

## Part B — CLIENT (src/cli/remote/blob-batch + docs; do not touch apps/api)

B1 (MAJOR, finding 3) — arbiter is the sole post-release redispatch path.
Remove the lanes' synchronous self-re-pump after release (uploader.ts
dispatch-finally's direct dispatchFull/armFillV2Timer; pack-uploader.ts
dispatch-finally's this.pump()) — each lane's redispatch logic moves into
its registered arbiter pump (keep idle_tail semantics: the pump callback
can compute it). Arbiter.release() invokes pumps round-robin starting from
a rotating index (already does) — keep one-permit-at-a-time fairness by
having each pump acquire at most... (lanes legitimately take multiple
permits when queue depth allows; fairness requirement is only no
STARVATION: rotate the starting pump per release — verify the rotation
actually alternates). Add dual-backlog fairness tests in both directions:
limit 1, sustained backlogs in both lanes, assert both lanes make progress
(interleaved completions), for (batch-first, pack-first) initial owners.
Preserve ALL existing uploader tests green.

B2 (MAJOR, finding 4) — process-latch propagation across instances: gate.ts
keeps a registry of latch subscribers (`onPackUploadDisabled(cb)`, reset in
resetBatchBlobStateForTests); disablePackUploadForProcess() notifies all.
BlobPackUploader subscribes on construction: on latch → transferAllUnsettled
(idempotent). Also guard pump()/onTimer()/dispatch() entry with
packUploadDisabled() → transferAllUnsettled. Test: two BlobPackUploader
instances; 404 on one; the other issues no further pack PUTs and its pending
members settle via its fallback.

B3 (MAJOR, finding 5) — exception-safe settlement: in pack-uploader
resolveGroup (and any onBytes call sites), wrap `waiter.onBytes?.(...)` in
try/catch (swallow — progress callbacks are best-effort); ensure
group.complete() runs in a finally so temp cleanup and close() can never
hang on a throwing callback. Test: throwing onBytes → all waiters settle,
temp file deleted, close() resolves, permit released.

B4 (MINOR, finding 13) — CODEMAP config.ts line: add pack policy/knob
ownership (PackConfig, RBOX_PACK_* readers, pack fill constants).

B5 (finding 7 client half) — pack lane telemetry into the existing
upload-lane-timing module (house pattern): counters for packs built/sent,
members per pack, payload+overhead bytes, build/upload wall ms, and fallback
reason enum ("disabled_latch" | "retry_later" | "http_error" | "parse_error"
| "not_activated" | "transport"); expose via the module's existing summary
path. Numeric/enum only. Unit-assert counters after a stubbed publish.

B6 (from finding 12, client-scoped) — two targeted tests: (a) acceptance
rolls off mid-publish: first pack PUT returns 200, second returns 404
pack_disabled → in-flight settles, remaining members requeue and settle via
batch lane, publish completes, latch set once; (b) close() during
buildPack (before fetch) → waiters rejected, temp file removed, no fetch
issued.

Acceptance (both parts): npm run typecheck green; Part A also keeps
`cd apps/api && npx vitest run` green natively (write tests even if your
sandbox can't run miniflare); Part B keeps `bun test ./src/` green
(tolerated flakes: same-SHA heal, shellStateOf, ctime, benchmark). Report
what changed per finding number.
