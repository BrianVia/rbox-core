# §33 — Per-account reachability GC (shardable, cron-safe, leak-closing)

**Status:** DRAFT v4 — design only, no implementation. **Phase 1 (per-account entitlement
prune) is codex-confirmed sound and cron-safe** — it closes the design 30 §3 / 07b §d
entitlement leak, corrects `used_bytes`, and shards. Its barrier is the **candidate-aware
validate** (a per-account `blob_ref_candidates` marker), which resolved round-1 (the
`granted_at`-guard alone is insufficient — the dedup path never bumps `granted_at`,
`commit-accounting.ts:78-93`) and round-3 (clear the marker + stamp `granted_at` on **both**
branches of `grantEntitlementWithQuota`, `billing.ts:39-59`). **Phase 2 (canonical R2 + `blobs`
reclaim) is explicitly NOT put on cron**: round-3 found the 12h bearer-receipt window
(`receipts.ts:10`, `blobPut` mints with zero D1, `blobs.ts:106-119`) and round-4 found the
**irreducible** R2-delete TOCTOU — R2 has no atomic/conditional delete, so an age-check-then-
delete can race a re-PUT. That is the same constraint that keeps canonical GC manual today
(`worker.ts:70-73`). v4 fixes the receipt-window off-by-δ and scopes Phase 2 R2-delete as
manual/quiescent (or behind a delete barrier — founder choice, §6). Supersedes the GLOBAL
mark/sweep of design 06 §4-SAFE for the *reclaim* path; keeps 06's grace+recheck safety model,
per account.

**Implements (forward):** roadmap GC scaling; closes the design 30 §3 / design 07b §d
per-account-reachability entitlement leak. **Composes with** §32 (D1 account-sharding,
in parallel) — see §7.

---

## Problem

Today GC is one **global** pass and it has three coupled defects.

1. **It doesn't scale or shard.** `computeReachable` (`apps/api/src/versions.ts:12-26`)
   builds ONE reachable set across **all** workspaces: it `SELECT … FROM workspaces`
   with no account filter (`versions.ts:14`), then fans out one DO `…/roots` fetch per
   workspace (`versions.ts:16-19`), failing the *entire* sweep if any single DO is
   unreadable (`versions.ts:18`). `gcMark` then lists **every** object under
   `blobs/sha256/` and `manifests/sha256/` in R2 (`versions.ts:37-50`) and diffs against
   that one global set. Cost grows with total tenant count; one slow/broken DO aborts GC
   for everyone; there is no unit of work smaller than "the whole platform."

2. **It's manual-only — never on cron.** `scheduled()` runs `retentionPrune` but
   explicitly leaves `gcMark`/`gcPurge` OFF the cron (`apps/api/src/worker.ts:67-85`):
   "the destructive canonical GC … is OFF the cron — it races a concurrent direct PUT (R2
   has no conditional delete). Canonical dedup-GC is deferred to a separate quiescent
   sweep (run manually via /v1/admin/gc while no push is active)" (`worker.ts:70-73`). So
   the reclaim that actually frees bytes only ever runs when a human asserts quiescence.

3. **It reclaims by content-address only, so it can't drop a per-account-unreachable
   entitlement.** `gcPurge` deletes a `blobs`/R2 object **only when the GLOBAL reachable
   set excludes it** (`versions.ts:62-83`); when it does, it drops *all* `blob_refs` for
   that sha and `releaseUsage`-es each owner (`versions.ts:70-80`). But a blob that is
   **globally reachable** (some account still references it) yet **per-account
   unreachable** for account A — A's last commit that named it has aged out of retention,
   or A's commit was abandoned over-cap (design 30 §3) or 409'd after accounting
   (`workspace-sync.ts` head-409 path; design 30 §3) — keeps A's `blob_refs` row and A's
   `used_bytes` charge **forever**. Design 07b §d names this explicitly: "per-account-
   reachability pruning of entitlements is a noted follow-up." It is a real, accumulating
   billing leak: over-cap partial charges (design 30 §3) and head-409 orphans are charged
   to accounts that can never reference the blob again.

We want GC to (a) run **per account** so it shards and scales, (b) **close the
entitlement leak** and correct `used_bytes`, and (c) be **safe to run on cron**.

## Root cause

GC conflates two reclamation targets that have **different granularity** and **different
safety**:

- **Entitlement reclaim** = a `blob_refs(account_id, sha256)` row + its `used_bytes`
  charge. This is **per-account** state. Dropping it is pure D1 — no R2 op.
- **Canonical reclaim** = the R2 object + its `blobs(sha256)` catalog row. This is
  **global** content-addressed state. Dropping it touches R2, which has **no conditional
  delete**, so it races a concurrent direct-write PUT (`worker.ts:71`).

The global sweep only models the second target (content-address reachability), so it
**cannot even express** the first (a ref unreachable for A while the blob is reachable for
B). And because it always couples the two — every reclaim is an R2 delete — it inherits
the R2-race that forces it off cron, even for work (entitlement pruning) that never needs
R2 at all.

### The fact that makes per-account safe: `encSha` is account-unique

Convergent blob crypto derives the key **and** nonce from a **per-(workspace, keyEpoch)**
KEK:

```
(blobKey, blobNonce) = HKDF-SHA256(ikm=KEK_{keyEpoch}, salt="rbox/blob/v1", info=plaintextSha)
```
(`docs/design/12-full-e2ee.md:122`; "The KEK is **per-(workspace, keyEpoch)**",
`12-full-e2ee.md:126`). The workspace KEK is a **random 256-bit** secret
(`12-full-e2ee.md:395`), wrapped under the account MK, never on the server. Therefore:

- Two **different accounts** encrypting identical plaintext derive different ciphertext
  (different random KEK) → **different `encSha`**. Collision is a 256-bit accident.
- Even two **different workspaces of the same account** use different KEKs → different
  `encSha`. Dedup only collapses identical plaintext **within one (workspace, keyEpoch)**
  (`12-full-e2ee.md:126-127`).

**Consequence (the load-bearing claim, verified):** a given `encSha` is referenced by the
`blob_refs` of **at most one account** (modulo 256-bit collision). There is **no
cross-account blob sharing**. So once *that one account's* last `blob_refs` row for the
sha is gone, the R2 object is globally unreferenced and safe to delete — **no other
account can be deduping against it.** The design still does not *rely* on the crypto
argument for the destructive step: it gates R2 deletion on an explicit global
`COUNT(*) FROM blob_refs WHERE sha256=? = 0` (§3.3), which is correct even if the
uniqueness assumption were ever violated. The crypto fact is what makes that count
**reliably 0** right after A's last ref drops, so reclaim is prompt, not what authorizes
it.

## Design

GC becomes a **per-account** operation with two phases of **different** safety class.

### 3.1 Per-account reachable set

Input: one `accountId`. The account's workspaces are already a cheap shard-local lookup —
`workspaces.account_id` exists (`migrations/0006_tenancy.sql:48`) with index
`idx_workspaces_account_created` (`migrations/0015_device_management.sql:14`):

```
SELECT workspace_id, project_id FROM workspaces WHERE account_id = :acct
```

For each workspace, ask its DO for **authoritative retained roots** exactly as today —
`GET …/roots` (`workspace-sync.ts:388-419`), which returns, per retained sequence in
`(pruneFloor, head]`, the `encManifestSha` and every referenced `encSha` (inline refs, or
the sidecar's `sidecarSha` + the sidecar-loaded `encSha`s) parsed straight from the stored
commit body (`workspace-sync.ts:404-416`). **Fail closed per account:** any
`roots_incomplete` 409 (a retained gap, an unreadable sidecar — `workspace-sync.ts:399,
403, 414`) aborts **this account's** GC only, leaving every other account collectible.
This is the §32 sharding win: the blast radius of one broken DO is one account, not the
platform.

`reachable(acct)` = union over the account's workspaces of `{encManifestSha} ∪ {encShas}`.
This is identical to today's `computeReachable` body (`versions.ts:20-23`) restricted to
one account's workspaces.

### 3.2 Phase 1 — entitlement prune (pure D1, leak-closing)

This is the leak-closing, scaling phase. It touches **no R2**. It is a two-pass
mark → grace → purge over the account's `blob_refs`, with a **per-account prune-candidate
marker** that the commit path consults — the entitlement-level analog of 06 §4-SAFE's
`gc_candidates`.

**Mark.**
```
for ref in (SELECT sha256, granted_at FROM blob_refs WHERE account_id = :acct):
    if ref.sha256 in reachable(acct):            continue   # still needed → never mark
    if now - ref.granted_at < GRACE_MS:          continue   # cheap skip of obviously-fresh refs
    INSERT OR IGNORE INTO blob_ref_candidates(account_id, sha256, marked_at) VALUES (...)
```

**Purge** (after grace), **recomputing `reachable(acct)` from authoritative DO roots**:
```
for cand in (SELECT * FROM blob_ref_candidates WHERE account_id = :acct):
    if cand.sha256 in reachable(acct):           # re-referenced since mark
        DELETE FROM blob_ref_candidates WHERE account_id=:acct AND sha256=cand.sha256   # un-mark
        continue
    if now - cand.marked_at < GRACE_MS:          continue   # not past grace yet
    changes = DELETE FROM blob_refs WHERE account_id=:acct AND sha256=cand.sha256
    if changes == 1:
        size = SELECT size_bytes FROM blobs WHERE sha256 = cand.sha256
        releaseUsage(acct, size)                 # billing.ts:62-64, floors at 0
        if (SELECT COUNT(*) FROM blob_refs WHERE sha256 = cand.sha256) == 0:
            condemn cand.sha256 into gc_candidates   # hand to Phase 2 (§3.3)
    DELETE FROM blob_ref_candidates WHERE account_id=:acct AND sha256=cand.sha256
```

**Why a marker, not `granted_at`, is the barrier (codex round-1 MAJOR — the original
`granted_at`-guard was wrong).** It is tempting to guard the delete with
`… AND granted_at < cutoff`, reasoning that any commit re-referencing the blob bumps
`granted_at` via `commitAccounting`'s
`ON CONFLICT(account_id, sha256) DO UPDATE SET granted_at = excluded.granted_at`
(`commit-accounting.ts:142-143`). **That is false for the dedup path:**
`validateCommitRefs` puts an already-entitled+present ref in the *have-set* and **excludes
it from `newRefs`** (`commit-accounting.ts:78-93`), so `commitAccounting` never runs the
`ON CONFLICT UPDATE` for it — a commit that **dedups** against an existing ref does **not**
touch `granted_at`. So a ref that fell out of retention (marked by GC) and is then reused
by a new commit whose head has not yet advanced is invisible to *both* the roots snapshot
and `granted_at` → a `granted_at`-only guard would wrongly drop it, and if it was the last
ref, Phase 2 would delete an R2 object a just-published head needs. **Data loss.**
(`grantEntitlementWithQuota`, `billing.ts:41`, makes it worse: it inserts `blob_refs` with
**no** `granted_at` → SQLite default `0`, so those refs always satisfy `granted_at < cutoff`
— zero in-flight protection.)

The sound barrier is **candidate-aware validation**, exactly as 06 §4-SAFE does for blobs:
the commit preflight must treat a referenced sha that is a **prune-candidate for this
account** as **not satisfied**, forcing the commit to re-establish it (re-grant via
`commitAccounting`, which also clears the marker — see below). A candidate can therefore
**never** be referenced by a published commit without first being un-marked. The legacy
commit path already does this for `gc_candidates` — `missingBlobs` (the DO commit preflight,
`workspace-sync.ts:489-492`) treats a `gc_candidates` member as missing — so the change is:
(1) have `missingBlobs` / `validateCommitRefs` / `blobsCheck` *also* consult the per-account
`blob_ref_candidates` (treat a marked ref as not-have for *that* account), and (2) clear the
marker on **every (re-)grant path** — add `DELETE FROM blob_ref_candidates WHERE account_id=?
AND sha256 IN (…)` next to the existing un-condemn at `commit-accounting.ts:148`, **and** in
`grantEntitlementWithQuota` (`billing.ts:39-59`) on **both** branches — the new-insert
*and* the already-entitled early return (`billing.ts:42-44`), which the legacy `blobPut`
re-upload hits (`blobs.ts:134`). Missing the already-entitled branch (codex round-3 MAJOR)
would leave a marked-but-still-entitled ref stuck "missing" on legacy re-upload, or let
purge later drop a ref the client just re-established. This is the **same**
candidate-aware-validate change §3.3 needs for the receipts path, so Phase 1 and Phase 2
share one prerequisite (§3.3, R1). `granted_at`/`marked_at` **grace** is retained only as a
cheap *secondary* skip (don't bother marking an obviously-fresh ref) and as defense-in-depth
for the freshly-granted-but-not-yet-in-roots window (account-then-publish: a `newRefs` grant
lands before the DO head advances — `commit-accounting.ts:6-9`); it is **not** the
correctness argument.

**The purge invariant (states the two windows precisely).** Purge drops a candidate ref
**only if** at purge time it is simultaneously (i) still in `blob_ref_candidates`, (ii)
**absent from freshly-recomputed authoritative DO roots**, and (iii) `marked_at` older than
grace. This covers both races:
- *A commit that validated BEFORE the mark and publishes a deduped ref after it* (the marker
  is never cleared by a dedup — `commit-accounting.ts:78-93`): once its head advances the ref
  re-enters roots, so (ii) fails at the recheck → not dropped. The grace window (iii) is what
  guarantees the recheck happens *after* the commit publishes — grace is sized to exceed the
  longest commit, exactly the 06 §4-SAFE "older than a grace age" invariant. (A commit still
  in-flight longer than grace is the only theoretical hole, identical to 06's, and the same
  grace sizing closes it.)
- *A commit that validates AFTER the mark* hits the candidate-aware preflight → re-grant →
  marker cleared (i) fails → not dropped. This is the window the marker, not grace, closes.

**`used_bytes` correctness.** `releaseUsage` runs **only on `changes == 1`** — the row was
actually present and actually dropped by *this* run. Two concurrent GC passes for one
account cannot double-release (the second `DELETE` sees 0 changes). A commit that
re-references the ref during the window un-marks it (candidate-aware validate → re-grant →
marker cleared) so purge's roots-recheck sees it reachable and skips it — no release. The
delete + `releaseUsage` should be one `db.batch()` so a crash can't drop the row without
decrementing (R3). This converges `used_bytes` toward the design 07b §c reconciler invariant
`SUM(blob_refs ⋈ blobs)`, and **fixes** the leak where over-cap (design 30 §3) and head-409
orphans left `blob_refs` + charge stranded.

**Hygiene fix (codex round-1 MAJOR).** Stamp `granted_at = nowMs` in
`grantEntitlementWithQuota` (`billing.ts:41`) — on the new-insert path **and** refresh it on
the already-entitled return (`billing.ts:42-44`) — so every grant path carries a real
timestamp (keeps the grace *optimization* honest and the §23.5 revoke-lease semantics
consistent). Correctness does not depend on it — the marker does.

### 3.3 Phase 2 — canonical reclaim (R2 + `blobs` row)

When Phase 1 drops account A's **last** ref for a sha (the `COUNT(*) … = 0` check above),
the blob is now **globally** unreferenced. Phase 1 only **condemns** it into
`gc_candidates(sha256, kind='blob', marked_at)` (the existing table,
`migrations/0005_gc.sql:15-19`) — it does **not** delete from R2.

A purge step then deletes the R2 object + `blobs` row using the **existing 06 §4-SAFE
mechanics** (`gcPurge`, `versions.ts:56-85`): for each candidate past grace, **re-confirm
it is still globally unreferenced** (`COUNT(*) FROM blob_refs WHERE sha256=? = 0`, the
authoritative recheck) **and still condemned — both re-read inside the delete transaction,
never from the stale mark-pass list**, then `R2.delete` + `DELETE FROM blobs` +
`DELETE FROM gc_candidates`. Because the entitlement (`blob_refs`) and the charge
(`used_bytes`) were already settled in Phase 1, Phase 2 does **no** `releaseUsage` — it is
purely "the bytes are now nobody's."

**The receipt-TTL bearer window — the BLOCKER the candidate-aware check does NOT close
(codex round-3).** A receipts-path `blobPut` writes the canonical R2 object and **mints a
12h bearer receipt** (`RECEIPT_TTL_MS = 12h`, `receipts.ts:10`) doing **zero D1** — no
`blobs`, no `blob_refs`, **no `gc_candidates`** touch (`blobs.ts:106-119`). So a client can
hold a still-valid receipt for a sha that currently has `COUNT(blob_refs)=0`, commit *later*,
and `validateCommitRefs` will accept the receipt (`commit-accounting.ts:87`) and publish a
head — **with no consultation of `gc_candidates` at all** for receipt-satisfied refs. The
candidate-aware-validate fix below does not help once Phase 2 has **deleted the
`gc_candidates` row** (`versions.ts:81`): the sha is no longer condemned, the stale receipt
validates, the head dangles. This is precisely the race that keeps canonical GC manual today
(`worker.ts:70-73`). **Close it by gating Phase 2 R2 deletion on the R2 object's own
`uploaded` age** — delete only when `now - object.uploaded ≥ RECEIPT_TTL_MS + δ` (the exact
mechanism `gcMark` already uses to protect brand-new uploads, `versions.ts:44`), i.e.
**Phase 2 grace ≥ `RECEIPT_TTL_MS` + δ** (the δ margin is justified below). Any object old
enough to delete predates every still-valid receipt; any held receipt the client actually
redeems forces a fresh `blobPut` that **resets `object.uploaded`** (and re-creates the ref →
`COUNT>0` → re-confirm skips). The object's R2 timestamp, not D1 candidate state, is the
soundly-anchored signal because the receipt and the object are minted by the same PUT.

**Cron-safety of Phase 2 — narrowable, but NOT fully closable with R2's primitives (codex
round-4 BLOCKER).** Two checks shrink the window, but an irreducible TOCTOU remains:
1. **Candidate-aware validate** (closes dedup-against-a-condemned-blob *while it is still
   condemned*). Make `validateCommitRefs` and the receipts branch of `blobsCheck` treat a sha
   in `gc_candidates` as **not satisfied** (incl. for receipt-satisfied refs) → the client
   re-stages it → the re-stage's `blobPut`/`multipartComplete` deletes the `gc_candidates`
   row (`blobs.ts:133, 296`) → resurrected before any new commit references it. (The *legacy*
   path already does this: `missingBlobs`, `workspace-sync.ts:489-492`; non-receipts
   `blobsCheck`, `blobs.ts:71-86`; `commitAccounting` un-condemn, `commit-accounting.ts:148`.
   The §23 *receipts* path does not — `commit-accounting.ts:64-76`, `blobs.ts:47-69`.)
2. **R2-object-age gate ≥ `RECEIPT_TTL_MS` + δ**, read from `object.uploaded` via a `head()`
   at purge (not the D1 candidate timestamp — the receipts re-PUT path does **not** un-condemn,
   `blobs.ts:106-119`, so only the object's own timestamp is soundly anchored). The **δ
   margin** is required because the receipt is minted *after* `R2.put` returns
   (`blobs.ts:108→113`) and expires at `mintTime + RECEIPT_TTL_MS` (`receipts.ts:101,109,149`)
   — so `object.uploaded + RECEIPT_TTL_MS` is a hair *before* receipt expiry; δ covers the
   PUT→mint delay + clock skew (codex round-4 BLOCKER-2).

**The irreducible gap (codex round-4 BLOCKER-1).** Even with both checks, the age-read and the
`R2.delete` are **not atomic**, and **R2 has no conditional/atomic delete** (Cloudflare R2
documents conditions for `get`/`put`, not `delete`). So: purge reads an old object → a client
re-PUTs the same sha (all upload paths write R2 *before* D1 — `blobs.ts:105` receipts,
`blobs.ts:127` legacy, `blobs.ts:290` multipart) → purge deletes the *fresh* object → dangling
head. This is the **exact** reason canonical GC is manual today (`worker.ts:70-73`). The two
checks make it astronomically unlikely in the single-writer-per-account E2EE reality the
codebase already leans on (`blobs.ts:103-104`), but they do **not** make it sound. **Therefore
Phase 2 R2-delete does NOT go on cron as-is.** Options (founder, §6):
- **(a) Recommended:** ship **Phase 1 on cron** (the leak/scale/shard win — fully sound) and
  keep **Phase 2 R2-delete as the existing manual/quiescent sweep** (`/v1/admin/gc?phase=purge`
  run when no push is active). Zero new risk; no regression vs today.
- **(b)** Make Phase 2 cron-safe with a **delete barrier**: a per-account **quiescence gate**
  (GC asks the account's DO "no in-flight commit?" — it already fetches roots from that DO) or
  a short D1 **delete-lease** the upload path takes/*checks* so a re-PUT and a delete can't
  interleave. Heavier; deferred unless cron R2-reclaim latency matters.

**Shared prerequisite with Phase 1.** The candidate-aware-validate change (prerequisite 1) is
the **same** one §3.2 needs (its `blob_ref_candidates` consultation) — extend the commit
preflight (`validateCommitRefs` / receipts `blobsCheck`, and confirm `missingBlobs`) to treat
*both* the global `gc_candidates` (Phase 2 / canonical) **and** the per-account
`blob_ref_candidates` (Phase 1 / entitlement) as not-satisfied. **Phase 1 purge is fully
cron-safe with only prerequisite 1** (it does no R2 delete → no receipt-TTL window and no
R2-delete TOCTOU; a stale receipt that re-creates a `blob_ref` is exactly the reachability we
want, not data loss — the marker barrier + roots-recheck handle it). **Phase 2 R2-delete is
NOT cron-safe even with checks 1+2** (the irreducible R2-no-atomic-delete TOCTOU above) →
manual/quiescent or behind a delete barrier (§3.3 option b). Phase 1 **mark** is
non-destructive → cron now regardless.

### 3.4 Cron orchestration

`scheduled()` (`worker.ts:67-85`) keeps its order **retention → mark → purge**, now
**per account**:

```
retentionPrune(env)                       # unchanged: sets DO prune floors (retention.ts:34)
for each account (optionally: one shard's accounts — §7):
    reachable = perAccountReachable(acct)         # §3.1, fail-closed per account
    phase1Mark(acct, reachable, GRACE_MS)         # §3.2 — D1 only
# … grace elapses across runs …
for each account:
    phase1Purge(acct, GRACE_1)                     # §3.2 — D1 only; cron-safe w/ prereq 1; condemns last-ref blobs
# phase2Purge(env, GRACE_2)                        # §3.3 — R2 delete: NOT on cron (R2 no atomic delete);
#                                                  #   manual/quiescent OR behind a delete barrier (§3.3b)
# phase1Mark is non-destructive → cron now even before prereq 1 lands.
```

Retention must precede mark so a just-pruned version's now-unreachable refs are visible to
Phase 1 (same ordering rationale as `retention.ts:26-33`). Per-account failure is logged
and retried next run (idempotent: mark is `INSERT OR IGNORE`, purge is conditional-delete);
one account's `roots_incomplete` never starves the rest.

**Cadence + retention (plan-aware).** Retention windows come from `plans.ts:18-22` via the
`resolveAccountPlan` seam (`retention.ts:21-24, 53-54`): free `retentionDays: 0` (head
only), solo `30`, pro `90`, team `90`. Proposed cron: hourly `retentionPrune` +
**Phase 1** (cheap, D1-only, leak-draining; `GRACE_1` ≥ longest in-flight commit + skew,
today's manual default 1h — `worker.ts:157`). **Phase 2 R2-delete is NOT on cron** (§3.3,
R1b) — run it manual/quiescent with **`GRACE_2` ≥ `RECEIPT_TTL_MS` + δ = 12h + margin**
(§3.3, enforced via the R2-object-age gate). Note the two graces differ: Phase 1's is sized to
a commit; Phase 2's to the receipt TTL. Exact cadence/SLA is a founder call (§6).

### Schema

Reuses `blob_refs(account_id, sha256, granted_at)` (`0006_tenancy.sql:29-33`,
`0014_upload_receipts.sql:22`) and `gc_candidates` (`0005_gc.sql:15-19`). Adds **one**
table, the per-account entitlement-candidate marker — the entitlement-level analog of
`gc_candidates`, which the commit preflight must consult (§3.2):

```sql
CREATE TABLE IF NOT EXISTS blob_ref_candidates (
  account_id TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  marked_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, sha256)
);
```

A `prune_marked_at` *column* on `blob_refs` was considered (lighter) but rejected: clearing
it on reuse depends on the dedup path touching the row, which it does **not**
(`commit-accounting.ts:78-93` — the exact bug behind R1/§3.2). A separate table is also
cleaner for §32 sharding (it shards with the account). The marker is cleared on (re-)grant
by adding `DELETE FROM blob_ref_candidates WHERE account_id=? AND sha256 IN (…)` beside the
existing un-condemn at `commit-accounting.ts:148`.

## Residual risk (state plainly for review)

- **R1 — two prerequisites for cron-safe purge (do not conflate).** (1) **Candidate-aware
  validate:** the commit preflight must treat a referenced sha condemned in `gc_candidates`
  (Phase 2) *or* this account's `blob_ref_candidates` (Phase 1) as not-satisfied — incl. for
  receipt-satisfied refs. Today the *legacy* path does this for `gc_candidates`
  (`missingBlobs`, `workspace-sync.ts:489-492`); the §23 *receipts* path does **not**
  (`commit-accounting.ts:64-76`, `blobs.ts:47-69`); no path yet consults `blob_ref_candidates`.
  (2) **R2-object-age gate ≥ `RECEIPT_TTL_MS` + δ** for Phase 2 only — a 12h bearer receipt
  (`receipts.ts:10`, minted by `blobPut` with zero D1, `blobs.ts:106-119`) is decoupled from
  `gc_candidates` and validates even after purge deletes the candidate row (codex round-3
  BLOCKER); the object's `uploaded` timestamp is the soundly-anchored signal, with δ covering
  the PUT→mint delay + skew (codex round-4). **Phase 1 needs only (1)** (no R2 delete → no
  receipt window, no R2-delete TOCTOU); `granted_at` grace is NOT a substitute for (1) — the
  dedup path never bumps it (`commit-accounting.ts:78-93`). Phase 1 **mark** is non-destructive
  and cron-safe today; Phase 1 **purge** is cron-safe with (1).
- **R1b — Phase 2 R2-delete has an IRREDUCIBLE TOCTOU (codex round-4 BLOCKER).** Even with
  (1)+(2), the age-read and `R2.delete` are not atomic and **R2 has no conditional delete**, so
  a re-PUT between them can lose a fresh object. Checks (1)+(2) narrow the window to ~nothing in
  the single-writer-per-account E2EE reality (`blobs.ts:103-104`) but do not make it sound.
  **Conclusion:** Phase 2 R2-delete stays manual/quiescent (status quo, `worker.ts:70-73`) or
  goes behind a per-account quiescence/delete-lease barrier (§3.3 option b) — a founder call.
  This design does **not** regress today's safety and does **not** claim cron-safe R2 deletion.
- **R2 — `encSha` uniqueness is the safety floor for R2 deletion.** If the per-(workspace,
  keyEpoch) KEK assumption were ever violated (it is not, `12-full-e2ee.md:126`), two
  accounts could share an `encSha`. The explicit `COUNT(*) FROM blob_refs WHERE sha256=? =
  0` re-confirm (§3.3) makes deletion correct **regardless** — we never delete an R2 object
  any account still references. The crypto fact only guarantees the count reaches 0
  promptly.
- **R3 — `used_bytes` skew is self-healing, not instantaneous.** A crash between
  `DELETE blob_refs` and `releaseUsage` over-counts an account (charge for a ref it no
  longer holds) — fail-safe (never *under*-charges, never deletes data). Mitigate by making
  the delete + `releaseUsage` one `db.batch()` (transaction window). The 07b §c reconciler
  (`SUM(blob_refs ⋈ blobs)`) is the periodic corrector for any residual drift.
- **R4 — abandoned in-flight commit.** A commit that grants refs (`commit-accounting.ts`)
  then never advances head (over-cap 402 / 409) leaves refs that are genuinely unreachable.
  Phase 1 **intentionally** reclaims them once they leave roots and survive the
  mark→grace→purge with no re-reference — that is the design 30 §3 orphan we are here to
  collect. Safe because a *retry* of that commit hits the candidate-aware preflight → re-grant
  (clears the marker, re-stamps `granted_at`) and re-uploads if the blob was already reclaimed
  (idempotent — design 30 §3, `commit-accounting.ts:108-116`).
- **R5 — clock skew on `granted_at`/`marked_at`.** All timestamps are server epoch-ms
  written by the same Worker fleet; grace is sized to dominate skew. No client clock is
  trusted (contrast design 31's `notAfter` brick — this design never enforces a liveness
  bound on replay).

## Test plan

- **Unit (vitest, real workerd D1).** (a) Phase 1 drops a ref unreachable across the
  account's workspaces and `releaseUsage`-es exactly its `size_bytes` once; idempotent
  re-run releases 0. (b) **The dedup-reuse race (codex round-1 MAJOR — the core barrier
  assertion):** mark a ref, then run a commit that **dedups** against it (already
  entitled+present, so `validateCommitRefs` excludes it from `newRefs` and never bumps
  `granted_at` — `commit-accounting.ts:78-93`); assert the candidate-aware preflight reports
  it not-satisfied → it is re-granted → `blob_ref_candidates` row cleared → purge's
  roots-recheck sees it reachable and does **not** drop it. Then assert a `granted_at`-only
  guard would have wrongly dropped it (regression guard against reverting to the broken
  design). (c) **Legacy grant path (codex round-3 MAJOR):** a marked-but-still-entitled ref
  that the legacy `blobPut` re-uploads via `grantEntitlementWithQuota`'s already-entitled
  return (`billing.ts:42-44`) must have its `blob_ref_candidates` row cleared (and
  `granted_at` re-stamped); assert it is neither left stuck "missing" nor dropped by a later
  purge. (d) Last-ref → `gc_candidates`
  condemnation only when global `COUNT=0`; a sha still referenced by another account's
  `blob_refs` is **never** condemned (cross-account safety). (e) Multi-workspace account: a
  blob reachable from workspace B is not dropped while pruning workspace A's stale refs.
- **Phase 2 / cross-account.** Construct two accounts whose blobs are distinct `encSha`
  (real convergent encrypt under distinct KEKs); GC of account A never deletes an R2 object
  or `blobs` row that account B references; after A's last ref drops, the object is
  condemned then purged, and B's identical-plaintext blob (distinct `encSha`) is untouched.
- **Receipt-TTL window (codex round-3 BLOCKER).** Mint a receipts `blobPut` receipt for a sha
  with `COUNT(blob_refs)=0`; condemn the sha and run Phase 2 purge. Assert purge **does not**
  delete the R2 object while `now - object.uploaded < RECEIPT_TTL_MS + δ` (the object-age gate),
  so a later commit redeeming the still-valid receipt cannot publish a dangling head; assert that
  once the object ages past `RECEIPT_TTL_MS + δ` with no re-PUT, purge deletes it cleanly; and that
  a re-PUT mid-window resets `object.uploaded` → purge skips.
- **Phase 1 cron-safety (the part that DOES go on cron).** With prerequisite 1 in place: a
  receipts commit deduping against a condemned (entitlement-marked) ref is told to re-upload,
  the re-upload un-condemns + re-grants, and a concurrent Phase 1 purge does **not** drop it
  (roots-recheck sees it reachable). Assert the cardinal 06 invariant per account: **a reachable
  blob survives GC** — every retained commit's `encSha`s still `GET 200` after a full
  retention→Phase1-mark→Phase1-purge cycle.
- **Phase 2 R2-delete TOCTOU (codex round-4 BLOCKER — document, don't claim closed).** Assert
  the manual/quiescent constraint: a Phase 2 purge interleaved with a concurrent re-PUT of the
  same sha can lose the fresh object (R2 no atomic delete), so the test harness must run Phase 2
  only under asserted quiescence (or with the §3.3b barrier). This is a guardrail test, not a
  proof of cron-safety.
- **Leak regression (the §3 motivation).** Reproduce a design-30 over-cap partial commit
  and a head-409 orphan; assert the stranded `blob_refs` + `used_bytes` are reclaimed by
  Phase 1 after grace, and `/v1/account/usage` (`billing.ts:76-93`) drops to the
  reconciler value.
- **Live (dev).** Push a multi-workspace account, prune one workspace's history past
  retention, run the cron sequence; assert `used_bytes` falls by exactly the now-orphaned
  bytes and a pull of the retained head still succeeds byte-identical.

## §7 — Composition with §32 (D1 account-sharding)

§32 shards D1 by account. Per-account GC is **already** the right unit of work:

- **Phase 1 is shard-local by construction.** Every table it reads/writes —
  `workspaces WHERE account_id`, `blob_refs WHERE account_id`, `accounts.used_bytes` — is
  keyed by the shard key. GC for account A runs entirely on A's shard + A's workspace DOs.
  Shards GC **in parallel**, no cross-shard coordination.
- **The global `COUNT(*) FROM blob_refs WHERE sha256=?` stays shard-local** *because*
  `encSha` is account-unique (§ root cause): all refs for a given sha belong to one account
  → live on one shard. So even the Phase 2 "is it globally unreferenced?" check does not
  fan out across shards. This is a direct dividend of the crypto fact.
- **Open coupling:** the `blobs` catalog row + the R2 object are **global** content-address
  state. §32 must decide whether `blobs` shards with the owning account (clean, given
  uniqueness) or stays a global table. Phase 2's `blobs`/R2 delete must target whichever
  §32 picks. **This design does not depend on §32 landing first** — it runs today as a loop
  over all accounts on the single D1; when §32 lands, the same loop becomes a per-shard
  loop with zero logic change.

## Open questions for the founder

1. **Cadence / SLA.** Hourly **Phase 1 on cron** (entitlement prune — the `used_bytes`/billing
   reclaim); **Phase 2 R2-delete run manually/quiescent** (not cron — see Q2/R1b), e.g. daily
   during a quiet window. What's the acceptable lag between "ref becomes unreachable" and
   "billing reclaimed" (Phase 1, hours) vs "R2 bytes physically freed" (Phase 2, a day+)?
2. **Phase 2 R2-delete: manual/quiescent vs a delete barrier (the key decision).** R2 has no
   atomic delete, so cron R2-reclaim has an irreducible TOCTOU (R1b). Accept the status quo
   (Phase 1 on cron closes the leak; Phase 2 stays the manual `/v1/admin/gc?phase=purge`
   quiescent sweep), or invest in a per-account **quiescence gate** (GC asks the account's DO
   "no in-flight commit?") / **delete-lease** so Phase 2 can go on cron? Given single-user-per-
   account reality, is the narrowed window even worth the barrier?
3. **Per-plan retention confirmation.** Keep free `0` / solo `30` / pro `90` / team `90`
   (`plans.ts:18-22`)? GC aggressiveness on free (head-only) means free accounts reclaim
   almost everything every cycle — intended?
4. **Grace values.** `GRACE_1` (Phase 1) ≈ 1h (today's manual default, sized to the slowest
   commit + skew); `GRACE_2` (Phase 2) ≥ `RECEIPT_TTL_MS + δ` = 12h + margin (`receipts.ts:10`;
   δ covers the PUT→mint delay + skew). Confirm — and note that lowering `RECEIPT_TTL_MS` would
   let Phase 2 reclaim sooner (a coupling between receipt lifetime and R2-reclaim latency worth
   a deliberate decision).
5. **Reconciler cadence.** Run the 07b §c `SUM(blob_refs ⋈ blobs)` reconciler alongside GC
   to mop up R3 skew, or on a slower drift-correction schedule?

---

## Founder decisions (2026-06-30) — spec is now decision-complete

- **Phase 2 R2 deletion:** **manual/quiescent** (NO delete barrier). R2's lack of atomic delete makes cron R2-reclaim a TOCTOU; given single-writer-per-account, the barrier isn't worth it. Phase 1 (billing reclaim) is the value; physical R2 free stays a manual `/v1/admin/gc?phase=purge` sweep, as today.
- **Cadence:** Phase 1 on cron (start hourly); Phase 2 manual.
- **Retention:** keep `plans.ts` values (free 0 / solo 30 / pro 90 / team 90).
- **Grace:** `GRACE_1` ≈ 1h; `GRACE_2` ≥ `RECEIPT_TTL_MS + δ`.
- **Reconciler (07b §c):** run alongside Phase 1.
- **BUILD NOW:** **Phase 1** (per-account entitlement prune on cron + the candidate-aware commit barrier) — closes the live `used_bytes` leak. Phase 2 stays manual.
