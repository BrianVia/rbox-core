# Review 142 — storage truth and tiers, round 1

**Reviewed:** 2026-07-16  
**Design:** `docs/design/142-storage-truth-and-tiers.md`  
**Verdict:** **CHANGES-REQUIRED**

The binding product decision is coherent: the customer-visible quota should describe
the current materializable state, and retained history should not consume that quota.
The proposed mechanism is not implementation-ready. It starts from a false retention
premise, omits the already-reviewed design 89, does not define a transactionally sound
live-byte protocol across D1 and the per-workspace Durable Object, and treats logical
packed blobs as independently tierable R2 objects when they are not.

## Factual answers requested by the review

### What the existing reconciler does

`worker.scheduled()` runs `retentionPrune()` and then `runPhase1()` on each of the
22 ordinary hourly ticks; 08:23 UTC and 09:23 UTC are reserved for canonical mark and
purge (`apps/api/src/worker.ts:108-165`, `apps/api/wrangler.jsonc:47-51,144`).
For each account, `runPhase1()`:

1. Builds the retained reachable set from authoritative WorkspaceSync DO roots,
   failing closed for that account (`apps/api/src/gc-phase1.ts:42-56,287-312`).
2. Marks unreachable `blob_refs` older than `GRACE_1`, bounded to 2,000 rows per
   cursor page (`apps/api/src/gc-phase1.ts:7-13,58-95`).
3. On a later pass, purges markers that have themselves aged past `GRACE_1`, atomically
   subtracting `blobs.size_bytes` and deleting the entitlement; a now-global orphan is
   condemned for canonical GC (`apps/api/src/gc-phase1.ts:98-216`).
4. Replaces `accounts.used_bytes` with
   `SUM(blobs.size_bytes)` over the account's surviving `blob_refs` in one SQL update
   (`apps/api/src/gc-phase1.ts:257-278,287-305`).

`GRACE_1` is 24 hours to protect long first publishes (`apps/api/src/worker.ts:58-66`).
Because it applies once before mark and again to marker age before purge, a fresh
abandoned entitlement normally needs roughly 48 hours plus cron/cursor delay to be
released, not one 24-hour interval (`apps/api/src/gc-phase1.ts:75-78,139-160`).

This reconciler computes **entitlement-ledger truth**, not R2 truth or active-head
truth. It does not list R2, inspect `blobs.present`, measure packs, or distinguish
head from retained history. It is also coupled unnecessarily to the reachability
pass: any roots/mark/purge failure skips the final arithmetic reconcile for that
account (`apps/api/src/gc-phase1.ts:294-312`). Existing roots enumeration fails
closed at 16 dropped-index pages, four sequence-root pages, or 750,000 unique roots
(`apps/api/src/versions.ts:21-30,51-53,76-120`), so the founder account's roots/index
health and `phase1_account_failed` logs are incident evidence, not an assumption.

### What the suspected `used_bytes` leak is

There are two different failure classes:

- **Stranded but internally consistent entitlements.** `commitAccounting()` commits
  sequential super-batches. If a later batch hits the cap, earlier batches remain
  charged and granted (`apps/api/src/commit-accounting.ts:175-180,244-260`). Accounting
  also completes before the authoritative head CAS, so a subsequent head 409 can
  leave those entitlements off every retained root (`apps/api/src/workspace-sync.ts:507-510,
  649-683`). The Phase-1 source comments identify exactly these over-cap partials and
  head-409 orphans as the known leak (`apps/api/src/gc-phase1.ts:25-39`). Until Phase 1
  purges the `blob_refs`, `used_bytes == SUM(blob_refs JOIN blobs)` can be perfectly true;
  this is not a phantom counter row.
- **Pure arithmetic drift.** A crash or historical bug can make the cached counter
  differ from that join. `reconcileUsage()` corrects this directly
  (`apps/api/src/gc-phase1.ts:257-278`; regression coverage at
  `apps/api/test/gc-phase1.test.ts:474-483`).

Therefore the founder's 250 GiB cannot factually be called an “unknown phantom” from
the code alone. It may be retained unique history inside Pro's 365-day window, a
Phase-1 backlog/fail-closed account, stranded entitlements awaiting the two grace
windows, arithmetic drift because reconciliation is skipped, or a mixture. Phase 0
must measure these separately.

## Required anchor audit

| Requested anchor | Verified current behavior |
|---|---|
| `billing.ts` charge/decrement | `grantEntitlementWithQuota()` is the legacy single/multipart grant path and charges a new entitlement in an atomic batch (`apps/api/src/billing.ts:56-108`). The dominant receipts commit path charges in `commit-accounting.ts`, not here. `releaseUsage()` is only the helper definition at `billing.ts:111-113`; current Phase-1 decrement is inline and conditional at `gc-phase1.ts:153-160`. |
| `commit-accounting.ts` `overCap` | Paid accounts are gated by the `accounts_cap_guard` trigger. A trigger abort rolls back only the current super-batch and returns `overCap`; earlier super-batches remain (`apps/api/src/commit-accounting.ts:166-180,193-210,244-260`; trigger at `apps/api/migrations/0014_upload_receipts.sql:58-65`). |
| `worker.ts` reconciler + `GRACE_1` | `GRACE_1 = 24h` protects first publish (`apps/api/src/worker.ts:58-66`). Ordinary hourly ticks run retention then Phase 1/reconcile (`worker.ts:143-165`). Canonical mark/purge occupy 08/09 UTC (`worker.ts:108-141`). |
| `plans.ts` retention note | The “not yet ENFORCED” comment is present and false (`apps/api/src/plans.ts:10-12`). Current values are none 0 / Solo 30 / Pro 365 / Team 90 days (`plans.ts:24-28`). Design 66 already recorded the correction (`docs/design/66-retention-enforcement.md:7-40`). |
| `gc-phase1.ts` | Per-account retained-root mark/purge removes unreachable entitlements, corrects usage, and condemns global orphans; it does not delete R2 (`apps/api/src/gc-phase1.ts:25-40,42-56,98-216,257-315`). |
| `pack-gc.ts` | Physical pack GC deletes only ready packs with no remaining `blob_locations`; prod is currently `shadow`, so it reports rather than deletes (`apps/api/src/pack-gc.ts:181-213,270-374,392-411`; `apps/api/wrangler.jsonc:181-185`). |
| Versions/blobs schema | `blobs` is global SHA/size inventory and `blob_refs` is per-account entitlement (`apps/api/migrations/0001_init.sql:6-10`, `0006_tenancy.sql:26-33`). There is no relational versions-to-blobs table. `manifests` is legacy (`0001_init.sql:12-20`); E2EE's `commits` table is a best-effort mirror (`0011_e2ee.sql:53-65`, `workspace-sync.ts:708-717`), while authoritative versions are DO `seq:*` values (`workspace-sync.ts:1060-1073`). |
| Pack schema | One logical SHA may be a range of one immutable pack object via `blob_locations`; neither pack inventory nor locations records account or storage class (`apps/api/migrations/0025_blob_packing.sql:4-31`). |
| Design 06 | Its candidate/fail-closed invariants remain useful, but its plaintext-manifest topology is explicitly legacy (`docs/design/06-versions-gc.md:9-24,34-58`). Its plan values and cron/table status are stale (`06-versions-gc.md:3,27`) relative to `retention.ts:60-69` and current `plans.ts`. |

## Numbered findings

### 1. BLOCKER — The incident's first causal premise is false against this tree

Design 142 says version history is never pruned and design 06 was never implemented
(`docs/design/142-storage-truth-and-tiers.md:9-12,36-38`). In fact,
`retentionPrune()` computes the plan cutoff from E2EE `commits` and calls each DO's
authoritative `/prune` (`apps/api/src/retention.ts:27-35,40-88`); the DO deletes
`seq:* <= floor` while capping at `head - 1` (`apps/api/src/workspace-sync.ts:1006-1024`);
and the worker schedules retention before Phase 1 (`apps/api/src/worker.ts:143-165`).
`docs/design/66-retention-enforcement.md:7-40` already says the `plans.ts` comment is
stale.

The incident question is instead: which deployed revision handled the account, what
are its current `pruneFloor`, head, roots-index state, and plan, did
`scheduled_retention_failed` or `phase1_account_failed` fire, how much history is
younger than Pro's 365 days, and how far through the bounded Phase-1 cursors is the
account? “All 9,885 versions are still charged” needs production evidence before it
can remain in the problem statement.

### 2. BLOCKER — Design 142 silently regresses the already-reviewed design 89

Design 89 already records the same founder decision and the critical fixes found by
its first adversarial review. It preserves `used_bytes` as the total/stuffing ledger,
adds an idempotent per-stream live ledger, server-prices refs, and calls out the
pre-head-CAS drift problem (`docs/design/89-history-free-quota.md:59-93,194-224`). It
also closes free-history abuse with a K=4 total bound and outstanding-receipt
accounting (`89-history-free-quota.md:95-124,200-205`). The founder decisions and
implementation sequence were later confirmed in `docs/STATUS.md:535-556`.

Design 142 makes preservation of the total ledger optional and reopens fair use as
an unanswered question (`142-storage-truth-and-tiers.md:51-55,95-96`). It must
explicitly supersede design 89 and adopt or reject each normative resolution with a
new rationale. Reintroducing previously closed criticals is not an acceptable seed.

### 3. BLOCKER — Phase 0 cannot produce the promised per-account “true R2 bytes”

The current durable model can compute account **logical entitlement bytes** and, via
authoritative DO roots, logical head versus retained-history bytes. It cannot assign
every physical orphan to an account. Receipt PUT writes canonical R2 while deliberately
creating no `blobs`, `blob_refs`, or `used_bytes` state until commit
(`apps/api/src/blobs.ts:230-237`). Batch PUT does the same for all records
(`apps/api/src/blob-batch.ts:246-279`). Pack inventory has no `account_id`
(`apps/api/migrations/0025_blob_packing.sql:4-31`). Existing canonical GC therefore
finds orphans by global R2 listing (`apps/api/src/versions.ts:206-240`), not account
ownership.

Phase 0 must define separate outputs:

- per-account logical active, retained-history-only, stale-entitlement, and total
  entitlement bytes;
- global unattributed canonical orphan bytes;
- physical canonical bytes by observed storage class; and
- physical pack bytes classified active-only, history-only, mixed, or orphan, with a
  stated pack-overhead/allocation rule.

Without that split, its totals will not reconcile either to `used_bytes` or the R2 bill.

### 4. BLOCKER — A 165k-ref head diff is feasible; transactional active quota is not specified

The code already streaming-merges sorted parent and child refsets up to 250,000 refs
(`apps/api/src/commit-delta.ts:4-5,40-94`), and production enables delta admission
(`apps/api/wrangler.jsonc:184`). Thus 165k is within the current computational envelope.

The missing mechanism is atomicity. D1 accounting runs before publication
(`apps/api/src/workspace-sync.ts:507-510,613-616`), the authoritative head advances
later in a separate DO `transactionSync` (`workspace-sync.ts:649-683`), and the D1
commit mirror is post-CAS best effort (`workspace-sync.ts:708-717`). Large D1
accounting itself spans several independently committed batches
(`apps/api/src/commit-accounting.ts:175-180`). Finally, `blob_refs` records only
account entitlement, not `(workspace, project, head)` membership
(`apps/api/migrations/0006_tenancy.sql:26-33`).

The revision must define:

- whether active usage is the sum of per-stream head totals or an account-wide unique
  SHA union;
- the per-stream/head-membership schema and account-wide last-head-reference rule;
- an idempotency key containing stream, sequence, and commit hash, including two
  competing commits for the same next sequence;
- reservation/finalization/compensation across a pre-CAS success followed by 409,
  epoch rejection, crash, or D1 mirror failure; and
- the account-row conditional guard across concurrent workspace DOs.

A bare `active_bytes += delta` before the DO CAS will recreate the known leak on the
new quota axis. A periodic corrector is necessary but does not make false 402s between
the failed attempt and correction acceptable.

### 5. BLOCKER — Logical blob tiering is not physically implementable for mixed packs

A packed logical SHA is only an offset/length inside one R2 pack object
(`apps/api/src/blob-pack.ts:54-74,122-129`), and a pack is uploaded as one object
(`blob-pack.ts:354-356`). Storage class applies to that whole object. A pack containing
one head-live member and one history-only member cannot move only the latter to IA.

Current canonical GC merely removes the dead member's `blob_locations` row; physical
pack GC waits until no locations remain (`apps/api/src/versions.ts:373-423`,
`apps/api/src/pack-gc.ts:181-213,305-366`). The design must choose and cost one of:

- leave every mixed pack Standard;
- prospectively segregate packs by temperature, accepting that all new content starts
  active and later changes temperature; or
- crash-safely rewrite history members into new IA canonical objects/packs, atomically
  swap locations under existing logical/pack delete fences, and retire old packs.

It must also specify how an IA history member that re-enters a head is promoted or
served while promotion is pending.

### 6. HIGH — The reconciler must be a named input, not an “extend or replace” unknown

The exact behavior is given above and is already tested. The read-only Phase-0
arithmetic comparison `used_bytes` versus `SUM(blob_refs JOIN blobs)` should not depend
on successful DO roots enumeration. Conversely, stale-entitlement classification does
need authoritative roots and must remain fail-closed. Split those jobs so a roots-index
problem on a 175k-file account cannot suppress even counter-only diagnosis
(`apps/api/src/gc-phase1.ts:257-312`; bounds at `apps/api/src/versions.ts:21-30,76-120`).

### 7. HIGH — The suspected leak is stale entitlement state first, counter drift second

Design 142's “some unknown fraction may be phantom” collapses distinct conditions
(`docs/design/142-storage-truth-and-tiers.md:13-16`). The code names over-cap partials
and accounting-before-head-409 orphans (`apps/api/src/gc-phase1.ts:25-39`), both of
which retain real `blob_refs`. The counter reconciler correctly continues to count those
until Phase 1 proves them absent from retained roots and deletes the entitlements.

The incident report must show at least:

`used_bytes`, entitlement-join bytes, retained-root bytes, head-only bytes, marked
entitlement bytes by grace state, Phase-1 cursor/last success, canonical candidate
bytes, packed retired-member bytes, and physical R2 bytes. Only the first difference
is arithmetic drift; the other differences have different repair paths.

### 8. BLOCKER — Moving the only hard cap to active bytes creates unbounded free ingestion

The adversarial case is easier than 1 TB/day of committed churn. Stateless receipts
last 12 hours (`apps/api/src/receipts.ts:1-10`). Single receipt PUT writes R2 before
accounting (`apps/api/src/blobs.ts:230-241`), and batch PUT has no quota reservation or
precheck before parallel direct writes (`apps/api/src/blob-batch.ts:132-168,246-279`).
Repeated unique uploads that are never committed therefore do not increase active
usage. This was design 89's prior critical R1 (`docs/design/89-history-free-quota.md:115-124,
200-205`).

`used_bytes` must survive as an abuse ledger, with a race-safe stuffing bound covering
referenced bytes plus unconsumed/unexpired receipt and staging bytes on single, batch,
pack, and multipart ingress. Current founder decisions say K=4 and thin honest history
before returning a churn-bound 402 (`docs/STATUS.md:545-552`). If design 142 wants a
different rule, it needs an explicit founder decision and quantified replacement.

### 9. HIGH — Phase 2 cannot ship as written before Phase 3

The premise is outdated: retention, per-account entitlement GC, and canonical GC are
already scheduled, with canonical purge enabled in both environments
(`apps/api/src/worker.ts:108-165`, `apps/api/wrangler.jsonc:100,144,184`). IA tiering,
not retention itself, is the future phase. However, a global switch from total cap to
active cap before a verified live backfill would either treat default-zero accounts as
having unlimited headroom or later impose a migration-caused refusal, violating design
142's own constraint (`142-storage-truth-and-tiers.md:79-80`).

Safe sequencing is additive schema/readers, dual-write, authoritative per-account
backfill plus readiness marker, reconciliation/soak, preservation of the K×cap total
guard, and then a per-account active-enforcement switch. IA may follow the quota flip
only after retention/canonical/pack health is a measured rollout gate and the total
stuffing bound remains active.

### 10. HIGH — R2 transition mechanics and cost math are missing

Cloudflare storage classes are object-level. Existing objects change class using
same-key S3 `CopyObject`; age/prefix lifecycle rules cannot inspect DO/D1 reachability
and cannot lifecycle-promote IA back to Standard. The Worker bucket binding exposes
`storageClass` on PUT/object metadata but no `CopyObject` method. Design 142 must choose
an S3-authenticated copy job, a deliberate GET+PUT rewrite, or a different key/bucket
layout, then specify idempotency, checksum/metadata preservation, re-head races, and
desired-versus-observed class reconciliation. See the official
[storage-class](https://developers.cloudflare.com/r2/buckets/storage-classes/),
[lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), and
[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
documentation.

Current [R2 pricing](https://developers.cloudflare.com/r2/pricing/) is $0.015/GB-month
Standard versus $0.01 IA: only $0.005/GB-month saved. IA also has no free tier, a
30-day minimum, $9/million Class A operations, $0.90/million Class B operations, and
$0.01/GB retrieval; reading or copying from IA incurs retrieval. One IA-to-Standard
promotion's retrieval charge equals two months of storage savings before operations.
At the review's adversarial 1 TB/day, 30-day Solo retention is about 30,000 GB or
$300/month in IA, and 365-day Pro steady state is about 365,000 GB or $3,650/month,
before operations/restores, against $8/$20 plans (`apps/api/src/plans.ts:26-28,56-60`).
Retention bounds time, not churn rate.

The already-recorded founder decision is to tier history older than 30 days, never
objects due for prune inside the IA minimum (`docs/STATUS.md:545-549`). Design 142's
immediate “non-head means IA” rule conflicts with that and must be reconciled. Cost
acceptance needs fleet logical/physical bytes, object counts, remaining retention,
restore/re-head frequency, transition operations, pack rewrite amplification, and
bill-unit rounding.

### 11. HIGH — Design 06's invariants map; its schema/topology does not

There is no D1 `versions -> blobs` graph. `manifests` is legacy, `commits` is a
best-effort browsing mirror, and authoritative retained history is DO `seq:*` plus
the roots index/sidecars (`apps/api/migrations/0001_init.sql:12-20`,
`0011_e2ee.sql:53-65`; `apps/api/src/workspace-sync.ts:750-834,934-1003,1060-1073`).
Prune deletes DO pointers, not D1 commit mirror rows (`workspace-sync.ts:1020-1024`),
and the versions API calls the D1 mirror merely eventually consistent
(`apps/api/src/versions.ts:577-587`).

Keep design 06's authoritative-DO, fail-closed, candidate-fence, and “never delete a
retained root” invariants (`docs/design/06-versions-gc.md:34-58`). Replace its topology
with today's chain: retention floor → per-account entitlement mark/purge/reconcile →
fenced canonical logical/physical purge → pack physical purge. Phase 0 must use a
pinned DO snapshot that preserves head versus retained-union classification; a D1
join or the current `reachableFromWorkspaces()` union alone cannot supply that split.

### 12. HIGH — The charging/decrement/`overCap` anchors are materially incomplete

Design 142 cites `billing.ts:59-113` as if it owns current accounting. That function is
the legacy grant path (`apps/api/src/billing.ts:56-108`). Receipt commits charge by
server catalog sizes only for SHAs lacking account entitlement
(`apps/api/src/commit-accounting.ts:193-210`). Paid `overCap` is the cap-guard trigger,
not a standalone comparison, and a late super-batch failure preserves prior batches
(`commit-accounting.ts:175-180,244-260`; migration trigger at
`apps/api/migrations/0014_upload_receipts.sql:58-65`). Current decrement and release
are coupled to conditional entitlement deletion (`apps/api/src/gc-phase1.ts:142-180`).

The revised implementer map must enumerate the receipt commit path, legacy single and
multipart grants, advisory single/pack prechecks, batch PUT's missing reservation,
the trigger, Phase-1 conditional release, arithmetic reconcile, and usage/402 readers.
Merely changing the column named in `overCap` will not preserve atomicity or idempotency.

### 13. HIGH — Logical quota reclamation and physical packed reclamation have different rollout states

Canonical mark/purge runs daily, but production pack GC remains `shadow`
(`apps/api/src/worker.ts:108-141`, `apps/api/wrangler.jsonc:181-185`). Shadow mode only
reports would-change counts (`apps/api/src/pack-gc.ts:392-411`). Phase 1 can therefore
remove `blob_refs` and lower the headline/total logical counters while retired logical
members continue to occupy a physically pinned pack. Phase 3 and acceptance must name
an execute-mode pack-GC rollout/drill and report logical versus physical success
separately; “deleted blob” does not imply “R2 bytes disappeared.”

### 14. MEDIUM — “Active state” does not define metadata, git, or dedup semantics

Current accounting includes the encrypted manifest, manifest-chain SHAs, sidecar
carrier, and data refs (`apps/api/src/workspace-sync.ts:458-462,566-568,613-624`).
The phrase “what materializing every workspace today” suggests excluding manifest and
sidecar overhead, while git artifacts are part of the materialized developer state.
The revision must state whether it counts:

- ciphertext bytes or plaintext/materialized sizes;
- current encrypted manifest, chain, and sidecar carrier objects;
- current git bundle/index/op-state artifacts; and
- a repeated SHA once per stream materialization or once per account.

All enforced sizes must come from server `blobs.size_bytes`, never client-authored
sidecar totals. The DO roots response already separates manifest/carrier from data,
so this is computable once the product semantics are fixed
(`apps/api/src/workspace-sync.ts:971-1003`).

## Required revision before round 2

Round 2 should not start until design 142:

1. Corrects the incident diagnosis and records the production measurements needed to
   distinguish retention, roots/Phase-1 backlog, stale entitlements, arithmetic drift,
   canonical orphans, and packed physical residue.
2. Explicitly supersedes design 89 while carrying forward or deliberately replacing
   its server-pricing, idempotent ledger, K=4, receipt-stuffing, and rollout decisions.
3. Specifies the live-accounting saga across pre-CAS D1 work and authoritative DO
   publication, including conflicts/crashes and concurrent streams.
4. Defines an authoritative DO snapshot/classifier and honest logical-versus-physical
   Phase-0 report.
5. Designs mixed-pack relocation or accepts and prices mixed packs remaining Standard.
6. Chooses the CopyObject/job/reconciliation mechanism and adds a fleet cost model with
   the IA minimum, retrieval, operation, restore, re-head, and rewrite costs.
7. Makes the total stuffing bound and safe per-account quota-flip sequence normative.
8. Defines exact active-byte inclusion/dedup semantics and adds acceptance tests for
   first head, 165k incremental head, same-sequence conflict, multi-stream concurrency,
   crash at every D1/DO boundary, receipt stuffing, retained restore, IA re-head, mixed
   pack, and zero-visible-refusal migration.

**Final verdict: CHANGES-REQUIRED.**

# Review 142 — storage truth and tiers, round 2

**Reviewed:** 2026-07-17  
**Design:** `docs/design/142-storage-truth-and-tiers.md` v2  
**Verdict:** **CHANGES-REQUIRED**

The rescope is correct: Phase 0 should measure before v3 chooses accounting and
tiering architecture. The proposed report is not yet implementation-safe. Its six
items are not six disjoint buckets, the current evidence cannot establish the
promised per-account Phase-1 health result, the named roots helper fails at the same
caps the report must diagnose, and the existing `GET /roots` path is not read-only.

## 1. BLOCKER — Only items 1–3 can be a disjoint entitlement partition

Items 4–6 are not storage buckets. Arithmetic drift is a signed scalar, Phase-1
health is status/evidence, and physical inventory measures objects/packs containing
the same logical SHAs. They overlap items 1–3 and cannot each have a blob-ref row
count (`docs/design/142-storage-truth-and-tiers.md:56-85`).

Define the logical partition explicitly. For account entitlement SHAs `E`, current
head-root SHAs `H`, and all currently authoritative retained-root SHAs `R`, where
`H ⊆ R`:

- active = `E ∩ H`;
- retained-history-only = `(E ∩ R) \ H`; and
- stranded = `E \ R`.

`blob_refs` makes `E` unique by `(account_id, sha256)`
(`apps/api/migrations/0006_tenancy.sql:26-33`). The report must separately expose
`R \ E` as a missing-entitlement integrity anomaly. It must also `LEFT JOIN blobs`
and report `missing_blob_catalog_count`: there is no foreign key from `blob_refs` to
`blobs`, so an inner join can partition the rows while silently losing unknown bytes.
Bucket 4 may still show the exact signed value used by today's inner-join reconciler,
but it is a reconciliation check over the partition, not a fourth class
(`apps/api/src/gc-phase1.ts:257-278`).

The history definition must mean **all non-head roots currently retained by the
authoritative DO**, not “within the plan's retention window.” `/roots` exposes the
current floor and roots, but no authoritative commit time
(`apps/api/src/workspace-sync.ts:934-1003`); retention derives its cutoff from the
best-effort D1 `commits` mirror (`apps/api/src/retention.ts:60-70`). Otherwise an
expired-but-not-yet-pruned root falls into none of the three classes. Report
retention lag as a diagnostic, with the D1-mirror caveat, rather than changing `R`.

Finally, subdivide stranded refs by the two actual clocks, not by an approximate
“within 48h” promise: (a) `grant_age < GRACE_1`, (b) old and unmarked, (c) marked and
`marker_age < GRACE_1`, and (d) marked and purge-eligible. Mark time does not begin
until the cursor reaches the row, so 2,000 rows per hourly page can add arbitrary
cursor delay (`apps/api/src/gc-phase1.ts:58-95,112-140,213-215`;
`apps/api/migrations/0017_blob_ref_candidates.sql:16-20`).

## 2. BLOCKER — Bucket 5 cannot prove account-specific completion from current evidence

`runPhase1()` catches each account failure and calls
`logErr("phase1_account_failed", e)`, but the privacy-safe logger records only event
and error class, not account or cause. Cron discards the aggregate response
(`apps/api/src/gc-phase1.ts:287-315`; `apps/api/src/util.ts:57-59`;
`apps/api/src/worker.ts:159-167`). The mark/purge cursors are bare SHA strings with no
last-success timestamp; an empty cursor means either completed a cycle or never ran.
There is therefore no historical evidence from which a read-only report can say
that mark, purge, and reconcile “actually COMPLETES” for this account.

Keep Phase 0 read-only and narrow this output to facts it can prove now:

- current roots preflight outcome and structured reason;
- exact observed dropped-page, sequence-root-page, and account-unique-root counts,
  with cap, delta, percentage, and `wouldFailPhase1` for each;
- the four stranded backlog states above, current candidate counts/cursors, and
  arithmetic drift; and
- `historicalCompletion: unknown` unless a separately designed durable,
  account-attributed success/failure signal already exists.

Do not claim that a successful roots preflight proves the later write phases ran.
Adding durable per-account run state would itself be production mutation and is
outside this Phase-0 contract.

## 3. BLOCKER — Reusing `reachableFromWorkspaces()` cannot diagnose cap breach or founder scale

The current helper holds the whole account union in a JavaScript `Set`, throws at
750,000 unique roots, and refuses dropped page 17 or sequence-root page 5
(`apps/api/src/versions.ts:49-54,58-125`). It also fully loads gap sidecars. Thus an
account over any fail-closed cap receives neither totals nor headroom: the report
would fail in exactly the same place as Phase 1.

“Chunked/resumable” and “implementer's choice” are insufficient. Production has no
custom `limits` block (`apps/api/wrangler.jsonc:1-185`), while the current Workers
limits are 128 MB per isolate and 30 seconds default CPU; D1 execution and result
serialization share those Worker limits. The design cannot authorize an all-in-one
cockpit Worker that materializes `H`, `R`, and `E` together. See Cloudflare's current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

Require the Phase-0 runner to be a local/wrangler orchestrator whose resumable state
and temporary data stay on local disk. Server surfaces return bounded read-only
pages only. The runner must pin each workspace snapshot, page past the Phase-1 caller
caps, external-sort/dedupe SHAs on disk, and keyset-page `blob_refs`, `blobs`,
`blob_ref_candidates`, pack inventory, and locations. It must never call
`perAccountReachable()`. Acceptance needs fixtures beyond each cap (>16 dropped
pages, >4 sequence-root pages, >750k account-unique roots) where the report completes
and reports the exact excess, plus the 175k-head/deep-history founder run. This is
what prevents the diagnostic from tripping the caps it diagnoses.

## 4. BLOCKER — The cited DO read path can mutate production

`perAccountReachable()` calls `GET /roots`, and that route first runs
`ensureBootstrap()` (`apps/api/src/versions.ts:58-85`;
`apps/api/src/workspace-sync.ts:140-143`). On a cold/legacy object bootstrap creates
SQL tables, can migrate the head or update the watermark, initializes index state
and cursors, can seed genesis, and can arm an alarm
(`apps/api/src/workspace-sync.ts:175-257`). That violates the binding “NO prod
mutation of any kind” requirement.

Add a dedicated inspection endpoint handled before bootstrap. It may read existing
KV/SQLite state and return `uninitialized`/`uninspectable`, but must not create a
table, write KV/SQL, set an alarm, rebuild an index, call `/prune`, or write D1/R2.
Tests must snapshot DO storage and alarm state before and after every success/error/
retry path and prove byte-for-byte equality; D1/R2 test doubles must reject every
write. Continuation state belongs to the local runner, not `gc_state` or a report
table.

## 5. BLOCKER — Physical bytes and canonical orphans are not per-account bucket 6

`packs`, `pack_members`, and `blob_locations` contain no `account_id`; a pack may
contain members from multiple logical classes, and assigning its full size to every
touching account double-counts (`apps/api/migrations/0025_blob_packing.sql:4-31`).
Canonical objects written before accounting have no account attribution at all.
They are discovered by global R2 listing, not from `blob_locations`
(`apps/api/src/versions.ts:206-240`). Pack-GC shadow reports only bounded-page counts
for orphan **packs**, not canonical-orphan bytes or a complete inventory
(`apps/api/src/pack-gc.ts:68-150,392-410`).

Move item 6 outside the per-account partition and specify two honest outputs:

- per-account logical placement: catalog bytes for entitled SHAs currently canonical
  versus pack-located, without calling either number exclusive physical ownership;
- a global physical supplement: canonical object bytes and ready-pack bytes, with
  packs classified active-only/history-only/mixed/orphan (or an explicit allocation
  rule that reconciles exactly once to total physical bytes), plus globally
  unattributed canonical-orphan residue from a read-only R2 listing.

If Phase 0 will not scan global R2, remove canonical-orphan bytes from acceptance;
pack inventory and `blob_locations` cannot synthesize them.

## Required revision before round 3

1. Make items 1–3 the exact logical partition and items 4–6 diagnostics/reconciliation.
2. Define authoritative-retained and stranded substate predicates, including anomaly
   handling for missing entitlement/catalog rows.
3. Replace historical-completion claims with the current facts a read-only probe can
   establish, and define exact cap measurements.
4. Mandate the disk-backed local runner and bounded, pinned, keyset-paged read surfaces;
   remove the all-in-one cockpit option.
5. Add the pre-bootstrap, provably non-mutating DO inspection path and mutation-rejecting
   tests.
6. Separate per-account logical placement from globally reconciled physical inventory
   and canonical orphans.

**Final verdict: CHANGES-REQUIRED.**

---

# Review 142 — storage truth and tiers, round 3

**Reviewed:** 2026-07-17  
**Design:** `docs/design/142-storage-truth-and-tiers.md` v3  
**Verdict:** **CHANGES-REQUIRED**

The rescope remains sound, and two Round-2 blockers are closed: the report now labels
items 4–6 as overlapping diagnostics, and it replaces the unprovable historical
Phase-1 claim with a current-run probe plus account-attributed outcome logging going
forward. The strictly read-only roots requirement is also closed at the design level:
the implementation must bypass the mutating bootstrap path and the acceptance test
must prove zero DO writes. Three build-changing gaps remain in the partition, snapshot
protocol, and global physical supplement.

## Round-2 blocker closure audit

| Round-2 blocker | Round-3 status | Build consequence |
|---|---|---|
| Partition / diagnostics split | **OPEN** | The section split is fixed, but the predicates still do not partition current authoritative state and omit integrity anomalies. |
| Current-run Phase-1 probe + outcome-logging rider | **CLOSED** | The report claims only this classification run's result and cap proximity; future per-account/pass logs make later historical diagnosis possible. |
| Disk-backed local runner with bounded read-only pages | **OPEN** | Local spooling and bounded pages are mandated, but no pinned cross-page snapshot or keyset/resume contract is defined. |
| Strictly read-only roots path + zero-DO-writes test | **CLOSED** | The design rejects existing bootstrapping `GET /roots`, requires a read-only variant/storage read, and makes zero DO writes an acceptance condition. |
| Global-only physical residue | **OPEN** | Attribution is corrected to global, but the named pack-GC shadow source cannot measure canonical-orphan bytes and the totals cannot reconcile as specified. |

## 1. BLOCKER — Section A still is not the promised exact partition

“Retained history” is again limited to roots “within the plan's retention window,”
while “stranded” means reachable from no retained root
(`docs/design/142-storage-truth-and-tiers.md:62-68`). Those predicates leave a ref
reachable from an authoritative DO root that is retention-expired but not yet pruned
in neither class. The Phase-0 classifier has no authoritative commit timestamp in the
DO roots response anyway; the plan cutoff comes from the best-effort D1 `commits`
mirror. Define `R` as every root currently retained by the pinned authoritative DO
snapshot, classify history as `(E ∩ R) \ H`, and report window/prune lag separately.

The four stranded states requested in Round 2 are also collapsed back into “within
48h” versus “survived multiple passes.” That is not equivalent to the two clocks:
cursor delay before marking is unbounded by the two grace intervals. The report needs
the implementable states `(grant age < GRACE_1)`, old/unmarked, marked/not-yet-purgeable,
and marked/purgeable, using `granted_at` and `marked_at`.

Finally, “every `blob_refs` row ... bytes + counts” is impossible without naming the
missing-catalog case: `blob_refs` has no foreign key to `blobs`. Preserve every row in
the count partition with a `missing_blob_catalog_count`/unknown-byte anomaly, and
report `R \ E` missing-entitlement roots as a diagnostic. Otherwise an inner join can
silently drop corrupt rows while the report claims completeness.

## 2. BLOCKER — Bounded pages are not a coherent measurement without snapshot pins

The local/disk-backed execution model closes the Worker-memory and Phase-1 caller-cap
problem, but “pages authoritative data via bounded READ-ONLY requests” does not say
that a workspace's head, floor, and roots-index generation are pinned across every
page. Concurrent commit, prune, or index fold can otherwise make the external merge
mix generations, violating both the exact-partition proof and current cap counts.

Require the inspection protocol to return snapshot identity on page one, reject stale
pins on later pages, keyset-page all streams beyond the Phase-1 caller caps, and restart
only the affected workspace snapshot on conflict. Acceptance still needs fixtures
past each cap (>16 dropped-index pages, >4 sequence-root pages, and >750k unique
account roots) that finish and report the exact excess. Local disk alone does not prove
that the new server surface can page past the limits it is intended to diagnose.

## 3. BLOCKER — The global physical supplement still asks pack-GC for data it lacks

The attribution correction is right, but pack-GC shadow reports cannot provide
“canonical-orphan residue”: they inspect bounded pages of pack inventory and report
orphan packs, while pre-accounting canonical objects are discoverable only by a global
read-only R2 listing. Nor can “total R2 pack bytes” plus logical totals yield a global
logical-versus-physical delta that includes canonical objects.

Choose one executable contract. Either Phase 0 performs a resumable read-only global
R2 inventory and reports canonical object bytes/orphans plus ready-pack bytes, with
packs classified exactly once as active-only, history-only, mixed, or orphan; or it
removes canonical-orphan bytes and any claimed full physical reconciliation from
output and acceptance. Merely relabeling the residue global does not make it
measurable.

## Required revision before round 4

1. Use authoritative currently-retained roots for `R`; add the four clock-based
   stranded substates and the missing-catalog/missing-entitlement anomalies.
2. Define pinned, keyset-paged inspection snapshots and cap-exceeding acceptance
   fixtures.
3. Add the global R2 inventory and exact pack classification needed for physical
   reconciliation, or narrow the promised output to what pack inventory can prove.

**Final verdict: CHANGES-REQUIRED.**

---

# Review 142 — storage truth and tiers, round 4

**Reviewed:** 2026-07-17  
**Design:** `docs/design/142-storage-truth-and-tiers.md` v4  
**Verdict:** **CHANGES-REQUIRED**

V4 names the three Round-3 residuals, but none is closed as an executable contract.
The classifier still uses the rejected retention-window predicate and approximate
grace labels, the roots protocol has no bounded pinned paging, and the physical
identity does not observe pack objects in R2. These are build-changing gaps.

## Round-3 residual closure audit

| Round-3 residual | Round-4 status | Build consequence |
|---|---|---|
| Exact one-pass classifier predicates with in-partition anomalies | **OPEN** | Authoritative expired-but-unpruned roots are misclassified; stranded and anomaly precedence are not deterministic. |
| Pinned-roots + keyset-paged snapshot with drift disclosure | **OPEN** | Only `blob_refs` is keyset-paged; roots have no snapshot generation, stale-pin response, or cap-exceeding paging contract. |
| Reconciling global physical inventory with fleet-scale assumption | **OPEN** | The fleet-scale assumption is explicit, but pack-side physical objects are inferred from D1 rather than observed in R2. |

## 1. BLOCKER — The promised exact classifier still has the Round-3 holes

`RetainedSet` is still limited to non-head roots “within the plan retention window,”
and bucket 2 repeats that limit (`docs/design/142-storage-truth-and-tiers.md:64-67,
77-81`). The authoritative DO can retain an expired root until pruning catches up;
its entitlement would therefore be labeled `stranded` even though it remains reachable.
`R` must be every root currently retained by the pinned authoritative DO snapshot.
Window/prune lag belongs in diagnostics.

The stranded subdivision is also still the approximate “within 48h” versus “survived
multiple passes” split. It must state the four implementable predicates requested in
Round 3: `grant_age < GRACE_1`, old and unmarked, marked with
`marker_age < GRACE_1`, and marked/purge-eligible. Cursor delay makes the two prose
outcomes non-equivalent to those states.

Finally, the function first assigns `active-head | retained-history | stranded`, then
replaces some rows with `anomaly-missing-catalog | anomaly-inconsistent` without
defining precedence or an exact predicate for “inconsistent”
(`142-storage-truth-and-tiers.md:60-71`). A row may satisfy both a reachability class
and multiple integrity conditions. Define either one ordered, mutually exclusive label
function or a base partition plus explicitly orthogonal anomaly flags. Restore the
required `R − E` missing-entitlement-root diagnostic as well; it is absent from v4.

## 2. BLOCKER — The snapshot is one-shot roots plus paged refs, not pinned paged roots

V4 says roots are “SMALL” and reads each workspace's whole retained-root list once,
while the execution model requires bounded requests
(`docs/design/142-storage-truth-and-tiers.md:108-123`). It defines strict keyset
pagination only for `blob_refs`. There is no page-one roots snapshot identity,
generation token on later pages, stale-pin rejection, or affected-workspace restart.
Consequently the new read surface is not specified to page beyond the very 16-page,
4-page, and 750k-root caps this report must diagnose.

Define bounded keyset paging for every authoritative roots stream, with a snapshot
identity returned on page one and required thereafter, plus deterministic conflict and
restart behavior. Replace the unstated “stated threshold” with a concrete head-drift
threshold and report/re-scan outcome. Acceptance must include fixtures beyond all
three existing caps and verify the exact measured excess; the founder run alone does
not prove this protocol (`142-storage-truth-and-tiers.md:130-133`).

## 3. BLOCKER — The physical total does not inventory pack objects in R2

The report R2-lists only the canonical prefix, takes ready-pack bytes from D1 pack
inventory, and then asserts `canonical + packs = total physical`
(`docs/design/142-storage-truth-and-tiers.md:94-106`). That has no independently
observed pack-side physical total. A pack object is PUT while its inventory row is
still `uploading`, before the later `ready` transition
(`apps/api/src/blob-pack.ts:348-368`; state schema at
`apps/api/migrations/0025_blob_packing.sql:4-12`). A failure after PUT can therefore
leave real R2 bytes outside the proposed identity; swept/tombstoned and uninventoried
pack objects are likewise not proven absent by summing ready rows.

Boundedly and resumably list both canonical and pack R2 prefixes. Reconcile observed
pack keys and bytes against all inventory states, classify ready packs exactly once,
and report uploading, swept-but-present, missing-ready-object, and uninventoried-object
anomalies separately. Canonical-orphan bytes likewise require a key-level join between
the observed canonical listing, `blobs`, and `blob_locations`; subtracting an unqualified
catalog sum can hide missing expected objects. State a measurable skew/retry tolerance
rather than treating “within snapshot skew” as the reconciliation test. The explicit
handful-of-accounts assumption is adequate for this current-fleet Phase-0 run; it does
not cure the missing pack observation.

## Required revision before round 5

1. Make `R` the complete pinned authoritative retained-root set; specify all four
   stranded clock predicates and deterministic anomaly handling, including `R − E`.
2. Define snapshot-identified, bounded keyset paging for every roots stream, stale-pin
   behavior, a concrete drift rule, and cap-exceeding acceptance fixtures.
3. R2-list the pack prefix and reconcile observed pack objects against every inventory
   state with explicit anomaly and skew rules.

**Final verdict: CHANGES-REQUIRED.**

---

# Review 142 — storage truth and tiers, round 5

**Reviewed:** 2026-07-17  
**Design:** `docs/design/142-storage-truth-and-tiers.md` v5  
**Verdict:** **CHANGES-REQUIRED**

V5 adopts the shape of all three Round-4 contracts, but it does not close them.
The detailed bucket descriptions still contradict the classifier, the proposed
snapshot token does not identify every mutation of the retained-root streams, and
the physical supplement still omits the key/state reconciliation and explicit
anomalies required to make its totals reproducible. These are build-changing gaps.

## Round-4 residual closure audit

| Round-4 residual | Round-5 status | Build consequence |
|---|---|---|
| Unwindowed `RetainedSet`, four exact stranded predicates, orthogonal flags, and `R − E` | **OPEN** | The leading classifier and `R − E` are restored, but the numbered buckets reinstate the rejected window and approximate 48-hour classifiers; the supposedly exact size inconsistency predicate does not name the compared fields. |
| Generation-pinned, keyset-paged roots with re-pin policy and cap fixtures | **OPEN** | Roots are paged and retries are named, but a head-sequence-only token cannot detect prune-floor or roots-index changes, and the drift/fixture acceptance rules remain unspecified. |
| Direct pack-prefix observation with observed-versus-inventory deltas | **OPEN** | Both prefixes are observed, but aggregate deltas do not classify inventory/object anomalies or establish canonical orphan bytes by key. |

## 1. BLOCKER — The exact classifier is contradicted by its output buckets

The leading definition correctly makes `RetainedSet` every root retained by the
pinned DO and gives stranded refs four clock-based substates
(`docs/design/142-storage-truth-and-tiers.md:60-80`). But bucket 2 again restricts
history to the plan retention window, and bucket 3 again asks for approximate
“within 48h” versus “survived multiple passes” outcomes
(`142-storage-truth-and-tiers.md:83-90`). Those are the predicates rejected in
Rounds 3 and 4. An implementation cannot satisfy both descriptions, and the report's
partition proof depends on which one wins.

Make buckets 2 and 3 refer verbatim to the base classifier: all authoritative
currently retained roots for history, and `fresh | aged-unmarked | marked-young |
purge-eligible` for stranded refs. Also replace “a catalog size that disagrees
between tables” with named column comparisons. The available fields have different
semantics (`blobs.size_bytes`, `pack_members.length`, `blob_locations.length`, and
`packs.size_bytes`), so the current phrase is not an exact predicate and cannot have
one deterministic fixture.

## 2. BLOCKER — The snapshot generation does not pin the retained-root state

V5 defines the generation as “the DO's sequence at pin time”
(`docs/design/142-storage-truth-and-tiers.md:121-128`). Head sequence alone is not a
snapshot identity for these streams. Retention can advance `pruneFloor` and delete
`seq:*` pointers without advancing head, while index folding/rebuild changes
`dropped_index`, `seq_roots`, and `index_generation` independently
(`apps/api/src/workspace-sync.ts:734-803,832-834,937-1002,1006-1024`). Pages can
therefore blend pre- and post-prune/index state while every response carries the same
head sequence.

Pin and validate at least the full roots identity already used by `/roots` — head,
prune floor, and index generation — or introduce one monotonic generation bumped by
every retained-root mutation. Preserve the stated affected-snapshot restart policy,
but give the retry bound and head-drift threshold concrete values. The cap-exceeding
fixtures must assert the exact measured excess for each cap, not merely that the scan
returns successfully (`142-storage-truth-and-tiers.md:128-138`).

## 3. BLOCKER — Observing pack objects does not yet produce the promised reconciliation

Listing both R2 prefixes closes the observation half of Round 4, but v5 compares pack
objects and inventory only as unspecified per-prefix deltas and classifies only ready
packs (`docs/design/142-storage-truth-and-tiers.md:103-119`). It still does not
key-reconcile every pack inventory state or report the required uploading-but-present,
swept-but-present, missing-ready-object, and uninventoried-object cases. Those states
are materially possible because the object PUT precedes the `uploading → ready` D1
transition (`apps/api/src/blob-pack.ts:348-368`). “Within listing skew” also supplies
no retry window or numerical acceptance tolerance.

`canonical-orphan bytes = observed canonical minus catalog-known` repeats the
non-keyed subtraction rejected in Round 4. Catalog rows may be pack-located, and
catalog-expected canonical keys may themselves be missing; aggregate subtraction can
hide both conditions. Require a key-level join between each observed prefix and its
expected keys/states, report the named anomalies separately, define the listing
retry/skew tolerance, and compute canonical orphan bytes only from observed canonical
keys with no catalog expectation.

## Required revision before round 6

1. Remove the windowed/approximate bucket restatements and name every field in the
   inconsistent-size predicate.
2. Pin all retained-root mutation dimensions, and specify numerical retry, drift, and
   exact cap-fixture assertions.
3. Define per-key, per-state R2/inventory reconciliation for both prefixes, the named
   physical anomalies, and a measurable listing-skew rule.

**Final verdict: CHANGES-REQUIRED.**

---

# Review 142 — storage truth and tiers, round 6

**Reviewed:** 2026-07-17  
**Design:** `docs/design/142-storage-truth-and-tiers.md` v6  
**Verdict:** **CHANGES-REQUIRED**

V6 closes the narrow cap-fixture assertion, but it does not close Round 5. The
physical join still collapses inventory lifecycle states into generic join outcomes,
the skew bound does not cover pack-state changes, and the earlier classifier and
snapshot blockers remain in the design verbatim. These affect implementation and
acceptance behavior; they are not editorial residue.

## Round-5 closure audit

| Round-5 requirement | Round-6 status | Evidence / consequence |
|---|---|---|
| Remove contradictory bucket restatements and name exact size fields | **OPEN** | The unwindowed retained set and four exact stranded states are still contradicted by the numbered buckets, and `inconsistent` still says only “a catalog size that disagrees between tables.” |
| Pin every retained-root mutation dimension; give numerical retry/drift rules; assert constructed cap values | **PARTIAL** | Constructed-value equality is now explicit, but the token remains head sequence only and retry/drift limits remain unspecified. |
| Per-key, per-inventory-state reconciliation for both prefixes, named physical anomalies, measurable skew | **PARTIAL** | V6 adds per-key generic join outcomes and timestamps, but omits pack lifecycle states and does not bound their changes during the listing. |

## 1. BLOCKER — The entitlement partition is still self-contradictory

The base classifier correctly defines `RetainedSet` over every currently retained
root and explicitly forbids window filtering
(`docs/design/142-storage-truth-and-tiers.md:63-70`), then bucket 2 restricts the
same class to the plan retention window (`142-storage-truth-and-tiers.md:86-87`).
Likewise, the exact four stranded substates at lines 70-73 are restated as approximate
“within 48h” versus “survived multiple passes” outcomes at lines 88-90. An
implementation still cannot prove the promised exactly-once partition from both
definitions.

The `inconsistent` flag also still says “a catalog size that disagrees between
tables” (`142-storage-truth-and-tiers.md:74-78`) instead of naming the compared
columns and valid relationships. Round 5 explicitly required those fields because
`blobs.size_bytes`, member/location lengths, and whole-pack bytes do not share one
interchangeable meaning.

## 2. BLOCKER — Exact cap fixtures do not repair the snapshot identity

The new acceptance text is good and closes the narrow fixture issue: it requires
completion, page/cap values equal to constructed values, and classification of every
constructed row (`142-storage-truth-and-tiers.md:134-139`). But the page token is
still only “the DO's sequence at pin time” at lines 127-133. Pruning can change
`pruneFloor` without changing head, while index folding/rebuild changes
`index_generation` independently (`apps/api/src/workspace-sync.ts:734-803,937-960,
1006-1024`). Pages can therefore blend retained-root states while presenting the
same proposed generation.

“Bounded retries” and “a stated threshold” also remain placeholders at design lines
133 and 146. Pin and validate head, prune floor, and index generation (or one
generation advanced by every retained-root mutation), and give the retry count and
head-drift threshold concrete values.

## 3. BLOCKER — Generic join states are not per-inventory-state reconciliation

The new `matched | size-mismatch | r2-only | inventory-only` join is useful, but it
does not preserve the expected pack lifecycle state or report the required
`uploading-but-present`, `swept-but-present`, and `missing-ready-object` cases
(`142-storage-truth-and-tiers.md:112-120`). Those cases are not theoretical: the
object PUT precedes the `uploading -> ready` transition
(`apps/api/src/blob-pack.ts:348-368`). For the canonical prefix, the design also does
not define how expected canonical keys exclude catalog rows whose physical location
is a pack. Consequently “per-state for both prefixes” is not yet an executable join.

The timestamp rule at lines 121-125 measures one source of listing skew, but
“catalog-known bytes granted during the listing window” does not bound pack inventory
state transitions or removals. It also supplies no numerical retry policy. Pin or
time-bound each expected-key/state source, report lifecycle anomalies separately,
and define when the runner retries versus accepts a bounded delta.

## Required revision before round 7

1. Make buckets 2 and 3 refer to the exact base classifier and name each valid size
   comparison.
2. Use a complete retained-root snapshot identity and specify numerical retry and
   head-drift policies; retain the new exact cap fixtures.
3. Define expected keys by prefix and inventory lifecycle state, preserve that state
   in the per-key join, name each anomaly, and make the skew bound cover every
   mutable expected-state source.

**Final verdict: CHANGES-REQUIRED.**

---

# Review 142 — Phase-0 implementation scrutiny fix round

**Reviewed:** 2026-07-17  
**Implementation:** Phase-0 fix round (working tree)  
**Verdict:** **IMPLEMENTATION ALIGNED; FULL-SUITE VALIDATION ENVIRONMENT-BLOCKED**

This appendix tracks the eight implementation-scrutiny findings without changing
the aligned Phase-0 design. Two final adversarial-review findings (head/fleet
unavailability escaping as an exception and mixed-age history false expiry) were
fixed and re-reviewed; the reviewer reported alignment with no remaining code gap.

## Eight-finding closure audit

| Priority | Status | Closure evidence |
|---|---|---|
| 1. **BUILD THE LIVE HALF:** an operator-gated worker route forwarding to the DO `/roots-inspect` (gate with the same platform-secret admin mechanism the existing admin routes use — cite which); the real `StorageTruthSource` adapter (collapse the DO's three cursors into the opaque `nextCursor`, expand sidecar descriptors via R2 reads, surface `droppedRows`/`seqRootRows` per page, and surface root timestamps so `windowExpired` is computable — extend the inspect response if needed, keeping it read-only); one end-to-end test driving `measureStorageTruth` against the real `rootsInspect` handler with fake ctx (this is the honest zero-DO-writes-across-a-full-run test). | **CLOSED** | `adminRoutes` gates the fixed route with `isPlatform`, the same constant-time `x-rbox-platform` / `RBOX_PLATFORM_SECRET` mechanism used by `delta-soak`, `multipart-inventory`, and pack-tombstone routes. `adminRootsInspect` allowlists parameters, forwards to the pre-bootstrap read-only DO handler, and enriches sequences from D1. `BindingStorageTruthSource` uses explicitly remote D1/R2 bindings, a versioned three-cursor token, strict sidecar reads, page counts, and timestamps. `storage-truth-live.test.ts` covers the real adapter → route → handler path and asserts zero D1/R2/KV/SQL/transaction/alarm writes. |
| 2. Add the runner tests to CI (`test:all` or an included glob). | **CLOSED** | `test:storage-truth` is part of `test:all` and an explicit `checks-api` CI step. |
| 3. Re-read `currentHead` per workspace **after** the entitlement loop; evaluate `headAdvance`/`rescanOffered` there. | **CLOSED** | `measureStorageTruth` reaches the terminal entitlement cursor first, then reads every current head and computes the per-workspace advance and global offer. A fixture asserts the order. |
| 4. Stream inventory + R2 pages into the spool SQLite with persisted cursors; per-key join in SQL; resumable at any page. | **CLOSED** | Every logical and physical page commits rows plus its opaque next cursor atomically. Both inventory/R2 prefixes reconcile through SQL joins; the interruption fixture resumes at the saved continuation cursor. Spool schema v2 rejects incompatible checkpoints. |
| 5. Structured `status:uninspectable` report instead of throw; close db in `finally`. | **CLOSED** | Root pages, post-entitlement head reads, and typed fleet workspace failures return workspace/reason reports. Transport and physical-stream errors still throw for retry with committed cursors. The spool DB closes in the outer `finally`; fixtures cover initial, head-reread, and fleet unavailability. |
| 6. `windowExpired` computed from `retentionDays` + root timestamps (or drop field — prefer compute). | **CLOSED** | Route timestamps come from `commits.created_at`; SQL compares the latest retained historical time strictly below `startedAt - retentionDays*day`, excludes head SHAs, and has exact-cutoff, old+head, and mixed old/recent fixtures. |
| 7. Stale-once-then-recover fixture asserting `retries === 1` + final buckets. | **CLOSED** | Fixture abandons a partial continuation, re-pins, asserts `retries === 1`, and asserts every final bucket total. |
| 8. Log `errClass` in `rootsInspect` SQL catch. | **CLOSED** | `roots_inspect_sql_failed` uses `logErr`, whose structured field is `errorClass: errClass(e)`; the test rejects raw error text. |

## Acceptance evidence

| Gate | Status | Evidence |
|---|---|---|
| `bun run typecheck` | **PASS** | Exit 0 on 2026-07-17. |
| `bun run test:api` | **ENVIRONMENT-BLOCKED** | The exact command reaches the Workers pool, then this managed sandbox rejects Wrangler's user-config log write (`EROFS`) and its required `127.0.0.1` listener (`EPERM`). The changed route/DO suites pass separately in the node pool: 24/24. |
| `bun run test:storage-truth` | **PASS** | 18 tests, 109 assertions, 0 failures across runner, live adapter, and e2e. |
| Runner tests execute through the CI aggregate/script | **PASS** | Named package script is in `test:all` and `.github/workflows/ci.yml` `checks-api`. |
| End-to-end zero-write measurement test | **PASS** | Direct run: 1 test, 24 assertions, 0 failures. |
| `bun run test:all` | **ENVIRONMENT-BLOCKED** | The root stage ran 2,221 tests but six failed: five local-listener tests rejected by this sandbox and one unrelated existing sync assertion; the command therefore cannot reach the later API stage here. Runner coverage was executed independently and is wired into the command. |

**Final verdict: IMPLEMENTATION ALIGNED. Exact full-suite acceptance must be rerun in a socket-capable environment.**
