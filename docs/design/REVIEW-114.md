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
