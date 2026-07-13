# REVIEW-114 — adversarial review ledger for design 114 (blob packing)

Design class: STORAGE FORMAT + GC FENCE. Cap: 5 rounds (+1 confirmation if the
cap hits on a prescribed-fix residual) — deliberately higher than the usual 3.

Reviewer: codex (gpt-5.6-sol) via `codex exec`. Adjudicator: fable-5 (this
session), verifying every finding against the code before adoption.

Baseline: `docs/design/114-blob-packing.md` at b219e900 (initial draft).

## Seam items (design 109 — auth grants, parallel implementation)

- 109 touches `src/cli/remote/blob-batch/uploader.ts` dispatch and the batch-PUT
  server handler. Design 114's new `POST /v1/blob-pack/put` must assume the same
  auth shape as batch PUT: **bearer is ALWAYS sent** (founder constraint);
  grants are a server-side verification fast-path only. 114 must not encode any
  auth-grant assumption into the pack wire contract.
- The pack uploader shares the existing upload slot budget with the batch
  uploader; if 109 changes dispatch accounting in `uploader.ts`, the pack
  uploader's permit consumption must be reconciled at implementation time (both
  designs count a request as one slot).

## Rounds

### Round 1 — codex verdict: CHANGES-REQUIRED (1 BLOCKER, 14 MAJOR, 5 MINOR)

Adjudication (every finding checked against code before adoption):

**BLOCKER (d) — "rollback forbidden" is prose, not a mechanism.** ADOPTED with
modification. Verified: a pre-114 Worker cannot read `blob_locations` or verify
v2 receipts, so packed data is unavailable below that build. Fix folded:
named **rollback floor** (rollout step 1's release), reader-first one-release
soak before prod acceptance, a dev **rollback drill** as a promotion gate, and
an honest residual statement. REJECTED the "technically prevent selection of
older builds" sub-ask: Workers Builds tracks `main`; no such mechanism exists,
and the practical control is the floor + every 114 behavior above the floor
being flag-disableable.

**MAJOR (a) — 13 h grace uses the wrong epoch (same-id retry re-mints 12 h
receipts).** ADOPTED. Verified against `receipts.ts` (TTL anchored at mint
time) and the draft's idempotent-retry wording. The grace-as-receipt-bound
argument was deleted; safety now rests on three named properties in §7.3:
mint fence on ANY `pack_gc_candidates` row (mark or intent), install trigger on
open intent, and `PACK_INTENT_QUIESCENCE ≥ RECEIPT_TTL_MS + CLOCK_SKEW_MS`
(24 h ≥ 12 h + 60 s), compile/test-asserted. §3's fence read and same-id-retry
rules widened from "active intent" to "any candidate row".

**MAJOR (a) — terminal cleanup depended on an unstated receipt-expiry
invariant.** ADOPTED — same fix as above; the derivation
`delete ≥ mark + 24h > last-mint + TTL + skew` is now explicit (§7.3 property
3) and a clock-injected property gate (5b) exercises it.

**MAJOR (a) — deletion proof omitted two zero-location histories (v1
relocation; never-published orphan).** ADOPTED. Proof rewritten as a
case-complete split: (i) logically retired, (ii) relocated by authenticated
redemption, (iii) never published with receipts expired.

**MAJOR (a) — `rbox_pack_delete_fence` not recognized by
`isDeleteFenceAbort`.** ADOPTED with an improvement. Verified
`commit-accounting.ts:15-17` matches the substring `rbox_delete_fence`, which
does NOT occur in `rbox_pack_delete_fence`. Fix: the trigger raises
`rbox_delete_fence_pack` (contains the legacy substring), so the deployed
classifier — including rollback binaries — already converts the abort to the
422 `needsUpload` recovery. Mixed v1/v2 super-batch test added.

**MAJOR (c) — receipts skipped for already-entitled shas never install the
promised placement change.** ADOPTED as a spec correction, REJECTED the
proposed fix (processing placement changes for entitled shas — a new mutation
path with its own races). Verified `workspace-sync.ts:889` skips `have` shas.
§4 now specifies skip-if-entitled as the semantics and proves it safe: an
entitled+present blob always retains a valid active placement (active location
blocks pack intent; canonical deletion requires zero refs); the skipped
receipt's pack orphans safely. Property asserted in unit gates.

**MAJOR (c) — displaced-pack candidacy had no atomic transition rule.**
ADOPTED. §5 trigger 3: AFTER DELETE (and AFTER UPDATE of pack_id) on
`blob_locations` inserts the unopened candidate from `OLD.pack_id` when the
last location goes; §7.2 step 3 now defers to it. A resurrect arm cleans
unopened candidates for packs that regained locations.

**MAJOR (c) — locations not constrained to real immutable members.** ADOPTED,
and strengthened the receipt design with it: v2 receipts now carry only
`{packId}` (+ logical size); redemption derives offset/length from
`pack_members` joined on `packs.state='ready'`, and §5 trigger 2 guards
install consistency. Side benefit: v2 entry growth bounded (<~90 B over v1),
resolving the receipt-size MINOR structurally.

**MAJOR (b) — equal-length index corruption serves wrong bytes with 200.**
ADOPTED. The client would detect (it hashes every ciphertext), but the server
now hashes each packed extent before serving (single + batch), turning silent
wrong-bytes into a paged index-corruption signal; ≤256 KiB hash cost is
negligible.

**MAJOR (b) — batch coalescing had no bounded fetch-memory model.** ADOPTED.
Verified `streamBatch` pre-buffers results concurrently. §6 now has two
budgets: the existing 8 MiB response cap plus an 8 MiB fetch-byte budget
counting covering ranges at full size; over-budget falls to exact per-extent
ranges.

**MAJOR (d) — reusing `disableUploadForProcess` would kill the batch lane.**
ADOPTED. Verified `gate.ts`/`uploader.ts:88`. §3: distinct pack-only latch;
skew table and §8 updated.

**MAJOR (d) — `pack_disabled` must not be 503.** ADOPTED. Decided:
`404 {error:"pack_disabled"}` (capability/latch class); 503 stays reserved for
the post-write fence. Verified the uploader's 503 handling is defer-retry.

**MAJOR (d/e) — no shared upload-slot primitive.** ADOPTED. Verified `active`
is private to `BlobBatchUploader`. §3 names a shared permit arbiter (beside
`gate.ts` process state) + a mixed-lane concurrency test.

**MAJOR (d) — GC kill switch has no in-flight stop boundary.** ADOPTED as
honest documentation; REJECTED the "durable mode recheck before dispatch"
sub-ask — env vars are fixed per invocation on Workers, so a recheck reads the
same value; exposure is already bounded by the page caps/deadline/lease. §7.3
states the boundary plainly.

**MAJOR (e) — read/join gates not falsifiable from 5 cold publishes.**
ADOPTED. New gate 4b: dedicated matched read cells (≥200 single / ≥50 batch
GETs per arm, interleaved, nearest-rank p95, missing telemetry = fail), ≥5
matched joins.

**MAJOR (f) — co-membership side channel unstated.** ADOPTED. Invariant 2
rewritten: cryptographic confidentiality unchanged; the metadata delta (fewer
per-blob keys for listing-only observers; durable co-membership/order/length
directory + range-read correlation for content readers) is stated and
accepted.

**MINOR (e) — 48-knee vs 24 PUT slots.** ADOPTED with correction of the
correction: #245 swept upload slots (48 = +9% noise; defaults kept 24/48 per
STATUS), so 24 is the right divisor; the evidence text now says so and names
`DEFAULT_BATCH_PUT_SLOTS`.

**MINOR (e) — multipart evidence ≠ buffered pack-PUT evidence.** ADOPTED.
Phase-0 dev curve of verified single PUTs at 1/4/7.5 MiB under the 24-slot
scheduler, before implementation proceeds past format work.

**MINOR (c) — receipt-v2 size unbounded.** ADOPTED (structurally resolved by
the pack_members-derived receipt; worst-case entry size pinned by test).

**MINOR (c) — sha-uniqueness misstatement.** ADOPTED. Verified
`blobs.sha256` is a global PK (0001) and `blob_refs` is (account_id, sha256)
(0006); §5 reworded.

**MINOR (c) — migration number/indexes.** ADOPTED. 0025 named (re-check after
rebase); `packs(created_at)` + `pack_gc_candidates(marked_at/deleting_at)`
indexes added.

Revision committed as DRAFT v2.

### Round 2 — codex verdict: CHANGES-REQUIRED (6 MAJOR, 2 MINOR)

Codex re-attacked the round-1 machinery; all findings adjudicated:

**MAJOR — mint fence does not serialize receipt issuance (wall-clock).**
ADOPTED, with the fix being the existing house pattern rather than a new
authorization transaction: `mintFenceCheckedReceipts` already captures
`checkTime` BEFORE the fence read and anchors receipt `issuedAt` to it
(`blobs.ts:57`), so `issuedAt < marked_at` holds in signed-timestamp terms
under D1 serialization of read-vs-mark, regardless of when the HMAC completes.
§7.3 property 1 restated in those terms; the expiry proof now runs on signed
timestamps only.

**MAJOR — property 1 / gate 5b contradicted the §5 resurrect arm.** ADOPTED.
Verified the contradiction (resurrect deletes the candidate → same-id retry
may legitimately mint again). Properties restated **per candidacy epoch**: the
epoch that reaches delete exists continuously from its `marked_at` to the
delete, so every valid receipt has `issuedAt < marked_at` of that epoch;
quiescence restarts from the re-opened intent's `deleting_at` (the executor's
`deleting_at < now - quiescence` predicate does this automatically). Gate 5b
now exercises resurrect→retry-mint→last-location-delete→fresh-mark→delete.

**MAJOR — uploading sweeper had no race protocol; §8 "no server state" was
false.** ADOPTED. §3 now specifies: a `touched_at` heartbeat set by a
conditional single-row UPDATE before every R2 write (changes=1 or fail
closed), a conditional single-row `uploading→ready` transition, sweeper
eligibility only when `created_at` AND `touched_at` are past the orphan grace,
and inventory-first-then-object deletion ordering so a losing repair fails
closed instead of leaving an uninventoried object. Failure matrix rows
corrected/added; `packs.touched_at` added to the schema.

**MAJOR — §7.2 destructive location DELETE must embed the guards.** ADOPTED.
Verified `cleanupCandidate` embeds zero-ref/open-intent/lease predicates per
destructive statement; §7.2 step 1 now requires the same embedding.

**MAJOR — auth contract unstated on the new route (design-109 seam).**
ADOPTED. §3 wire block now shows the bearer header and states the
batch-PUT-identical contract: `protoAuth` always sent, `accountId` from
`authenticate()`, grants never an upload credential; API test asserting
grant-only rejection.

**MAJOR — per-request budgets do not bound per-isolate memory.** ADOPTED
moderated: this exposure class is identical to the existing 8 MiB batch lane
(24 concurrent buffered bodies today); rather than redesigning to streaming,
the resource gate gains a targeted concurrent PUT+GET stress cell and states
the per-isolate model explicitly.

**MINOR — rollback drill underspecified.** ADOPTED: `wrangler versions
list/deploy <version-id>` procedure, restore + re-verify, and the soak defined
as ≥7 days AND ≥1 subsequent production deploy with the reader present.

**MINOR — candidate indexes must be composite partials.** ADOPTED:
`(marked_at, pack_id) WHERE deleting_at IS NULL` and `(deleting_at, pack_id)
WHERE deleting_at IS NOT NULL`, mirroring migration 0024.

Revision committed as DRAFT v3.

### Round 3 — codex verdict: CHANGES-REQUIRED (1 BLOCKER, 4 MAJOR, 1 MINOR)

**BLOCKER — D1 ordering does not order JS timestamps.** ADOPTED. Verified: GC
passes bind an invocation-start `nowMs` (`versions.ts::gcPurge`), so
`marked_at`/`deleting_at` lag their statements' landing; database serialization
of the fence read vs the mark INSERT yields only `issuedAt < T_mark` (wall
insert time), not `issuedAt < marked_at`. Property 1 restated against
`T_mark`; property 3 rebuilt as a wall-clock chain with an explicit
`GC_CLOCK_STALENESS_BUDGET` (S = 1 h, ≥4x the executor's 15-min deadline,
compile-asserted): `quiescence ≥ TTL + skew + S`, margin ≈ 11 h at deployed
constants. Gate 5b injects stale invocation clocks.

**MAJOR — sweeper eligibility not embedded in destructive statements.**
ADOPTED verbatim: one db.batch, `pack_members` then `packs`, both correlated
to `state='uploading' ∧ created_at,touched_at past grace`; R2 delete only on
`changes=1`.

**MAJOR — heartbeat relies on a nonexistent HTTP-duration bound (late R2 PUT
recreates an uninventoried object).** ADOPTED with two mechanisms: (a) a
handler that fails its ready transition/fence best-effort deletes its own
just-written object; (b) the sweeper's terminal action is a `state='swept'`
tombstone (not row deletion) — all later paths require non-swept state, and
the sweeper re-HEADs tombstoned ids, re-deleting reappeared objects, removing
the tombstone only after confirmed absence past a further grace.

**MAJOR — ready-state crash retry cannot satisfy the uploading→ready CAS.**
ADOPTED: distinct idempotent ready/same-checksum branch (verify inventory +
object, fence read, mint fresh receipts, no transition).

**MAJOR — remote concurrency does not establish same-isolate memory safety.**
ADOPTED: two-layer gate — deterministic same-isolate workers-vitest
concurrency harness with full 8 MiB bodies, plus the remote stress cell.

**MINOR — wrangler drill not pinned to apps/api.** ADOPTED: `cd apps/api`,
dev worker, `versions deploy <id>@100%`, record/restore exact active version.

Revision committed as DRAFT v4.

### Round 4 — codex verdict: CHANGES-REQUIRED (2 BLOCKER, 3 MAJOR, 1 MINOR)

Both BLOCKERs were against round-3 machinery and are genuine; both got
*simpler* fixes than proposed:

**BLOCKER — the 15-min deadline does not bound the open pass's clock age.**
ADOPTED, with a stronger mechanism than a bigger budget: the pack intent-open
pass stamps `deleting_at` from a **live clock read taken after observing the
candidate row** (deliberately unlike `versions.ts::openIntents`' invocation
`nowMs`), giving `deleting_at > T_mark` directly. The staleness budget is
demoted to a non-proof-bearing open-skip guard; quiescence ≥ TTL + skew again
suffices (margin ≈ 12 h). Gate 5b gains an over-deadline-await history.
Codex's note that `nowMs_exec ≤ T_delete` is the safe direction was verified
and kept.

**BLOCKER — failed-path self-delete can destroy a concurrently published
pack.** ADOPTED via codex's first option: the self-delete (a round-3 addition)
is removed entirely; a losing handler performs no R2 cleanup — orphan bytes
belong exclusively to the sweeper/pack GC, whose tombstone re-sweep already
covers reappearance. Release-blocking same-id concurrent-PUT test added.

**MAJOR — finite tombstone grace contradicts the unbounded-late-PUT premise.**
ADOPTED (durable tombstones): `swept` rows are permanent, growth bounded by
own-client crash residue, metered in §9, manual admin purge as escape hatch.

**MAJOR — §7.3 executor could bypass the tombstone path for uploading packs.**
ADOPTED: pack candidacy/intent/execute now scoped to `state='ready'` only;
the §3 sweeper is the sole owner of `uploading` remnants; and the executor's
terminal action is uniformly the durable `swept` transition (members +
candidate deleted, tombstone retained).

**MAJOR — sweeper destructive SQL specified two incompatible ways.** ADOPTED:
one shape — correlated `pack_members` DELETE + guarded
`UPDATE packs SET state='swept'` in one db.batch; R2 delete keyed on
`changes=1` of that UPDATE.

**MINOR — residual wall-clock "no mint while candidacy exists" phrasing.**
ADOPTED: §3 and gate 5b restated as "no fence read begun after candidacy may
authorize minting; every authorized receipt's issuedAt precedes T_mark", with
statement-granularity interleaving tests.

Revision committed as DRAFT v5.

### Round 5 (cap) — codex verdict: CHANGES-REQUIRED (1 BLOCKER, 2 MAJOR — all
narrow prescribed fixes against round-4 terminal machinery)

**BLOCKER — a stale open UPDATE can stamp a replacement candidacy epoch.**
ADOPTED. Verified: `pack_gc_candidates` is keyed by `pack_id`, so after
resurrect→displacement-re-mark, a pass that observed C1 could open C2 with a
clock older than C2's mark. Fix: a random `epoch` column per candidacy; every
opening/destructive statement binds the observed epoch (`changes = 0` on
replacement). Gate 5b gains the stale-statement-vs-replacement history.

**MAJOR — manual tombstone purge contradicts the containment premise.**
ADOPTED: tombstones are permanent deny records; the admin surface is
non-destructive only (audit + forced re-sweep), platform-secret-authed like
existing admin GC.

**MAJOR — terminal fence retirement was not one guarded atomic transaction.**
ADOPTED: terminal `db.batch` = correlated members DELETE + ready→swept UPDATE
+ epoch-bound candidate DELETE, each embedding zero-location and live-lease
guards; no crash point retires the fence without the tombstone.

Cap policy: 5 rounds reached on prescribed-fix residuals → the sanctioned +1
cheap confirmation round follows.

Revision committed as DRAFT v6.

### Confirmation round (5+1) — codex verdict: **ALIGNED**

Scoped strictly to the three round-5 fixes (candidacy epoch binding, permanent
tombstone deny records, atomic guarded terminal transition) plus gate 5b's
matching history. No findings.

## Outcome

**ALIGNED at v6** after 5 full adversarial rounds + 1 confirmation round.
Totals adjudicated: 4 BLOCKER, 21 MAJOR, 8 MINOR findings — all adopted
(several with simpler mechanisms than proposed) except three recorded
rejections with rationale: technical prevention of old-build selection
(infeasible under Workers Builds; rollback floor + reader-first soak is the
control), processing placement changes for already-entitled receipts
(skip-if-entitled proven safe instead), and mid-invocation env-var GC recheck
(env is fixed per invocation; boundary documented, exposure bounded by
executor caps).

## Field validation — FM, v1.5.3, 2026-07-13 — DO NOT PROMOTE (writer stays off)

Mechanics field-perfect: 91/91 packs accepted, 20,408→45 physical R2 PUTs
(−99.78%), zero fallbacks/4xx/5xx/fence anomalies, overhead 1.18% (~48B/member).
Throughput thesis DEAD on current binaries: pack median 109.6s vs control 94.3s
(same-day A/B) — ~16% WORSE. Root causes, per the fp decomposition:
(1) the premise expired — after enforce admission + fill-v2 + the restored
crypto pool, upload ops were already off the critical path (~38s slot work in a
~95s wall; producer+tail bound);
(2) pack receipts DOUBLE the redemption tail (33.4/35.8s vs 18.3/14.6s for the
same 5 redeem requests; rentB 421 vs 372) — pack-receipt redemption costs ~2x
canonical server-side and flows straight into commit `p`;
(3) packer starvation: encrypt producer (~1MB/s ct) + 1s absolute timer flush
→ ~1.86MB packs, 453 members vs the ≥700 gate.
DECISIONS: writer remains RBOX_BLOB_PACK opt-in (not promoted); server accept +
pack-GC shadow STAY ON (91 real packs now soaking the shadow GC — free field
data); no cap/slot changes. NEW TOP LEVERS named by the data: the redeem/commit
tail in BOTH arms (design 111's ≤5s drain gate fails at this corpus — and
redeemOverlap=0 in all four runs despite default-on upload draining: FIELD GAP,
investigate why the drain didn't engage on this path), and pack-receipt
redemption server cost if packing is ever revived. Also: sweep.sh fp grep is
stale (`fp ready.*` vs `fp filesSynced...`) — one-line fix owed.
