# 102 — O(change) commit admission: server-side parent→child ref delta

Status: DRAFT v1, 2026-07-11 — pending adversarial review (REVIEW-102.md).

Companion to design 84 (§6.1 named this design explicitly): design 84's C1/C2/D
shrink the *client* manifest lane but "no phase of this design shrinks" the
*server's* O(workspace-refs) commit admission — that is this design's job. This
is the sufficient half of the pair: design 84 makes the bytes O(change); design
102 makes the server admission O(change). Together they make the ≤3–4s commit
POST reachable; design 84 alone leaves a projected ~9.3s Linux / ~9.2s Mac floor
(design 84 §6.1 decision arithmetic).

---

## 1. Motivation — measured

Zero-file pushes on the ~114k-blob workspace (2026-07-11, prod, design-97
`serverTimings` rendering live in the daemon logs):

| sample | client POST wall | srv total | accountingMs | sidecarMs | envelopeMs | commitMs (DO txn) | mirrorMs | responseMs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 7.9s | 6.8s | **5.8s** | 0.8s | ≈0 | ≈0 | 0.2s | ≈0 |
| 2 | 8.6s | 7.5s | **6.6s** | 0.6s | ≈0 | ≈0 | 0.2s | ≈0 |

**~85–88% of server commit time is D1 ref admission**
(`validateCommitRefs` + `commitAccounting`), directly confirming audit Finding 1
(`docs/audits/2026-07-10-sync-performance-audit.md`). At ~112k refs that path
issues ~1,245 `SELECT` statements across ~37 sequential `db.batch` groups
(`commit-accounting.ts:80–93`) — for a commit that changed **zero files**.

The pathology: admission cost scales with **workspace size**, not with the
**change**. A one-byte edit re-validates and re-accounts every one of ~112k
references. The client-side 41.2MB manifest upload (u≈3.1–3.4s) is design 84's
territory, explicitly **not** this design's.

The governing rule (audit §Final assessment): *a small change must perform work
proportional to the change.* This design makes commit admission obey it.

---

## 2. Current admission walkthrough (from code)

All of `commit()` runs **inside the `WorkspaceSync` Durable Object**
(`apps/api/src/workspace-sync.ts`), the authoritative per-(workspace, project)
sequencer. The receipts-protocol path (the only path a §24 sidecar client takes):

1. **Envelope parse** (`workspace-sync.ts:275–341`). Capped body read, JSON
   parse, shape/hash/seq/epoch field checks, `readRefMode` discriminates
   inline vs sidecar. `serverTimings.envelopeMs` ends here.

2. **Sidecar resolution** (`resolveSidecarBytes`, `sidecar.ts:72–112`, timed as
   `sidecarMs`). Entitlement gate (receipt or entitled+present) **before** the
   R2 GET; then `loadSidecarRefs` GETs the canonical sidecar object, checks
   `obj.size === refsetByteLength(count)` before buffering, hash-verifies
   `sidecarSha`, and `parseRefset` strictly decodes (magic, exact length,
   **sorted ascending by raw sha**, no dups, safe sizes — `refset.ts:82–104`).
   `totalBytes` is re-summed and matched to the signed descriptor. Returns the
   full child data-ref array (`refShas`), already in canonical sorted order.

3. **Build the accounting SHA set** (`workspace-sync.ts:392`):
   `shas = [encManifestSha, sidecarSha, ...sc.refShas]` — the two carriers plus
   **every** data ref (~112k).

4. **`validateCommitRefs`** (`commit-accounting.ts:61–109`, timed as
   `accountingMs`). For every SHA, an entitled-AND-present `SELECT` batched
   ≤90/statement, ≤34 statements/`db.batch`. The have-set `SELECT` folds in two
   `NOT EXISTS` barriers (`commit-accounting.ts:83–86`):
   - **`blob_ref_candidates`** (this account's Phase-1 prune marker), and
   - **`gc_candidates` with `deleting_at IS NOT NULL`** (an active deletion
     intent).
   A ref matching either barrier reads as **not-satisfied** and falls through to
   `newRefs` (needs a receipt), which forces `commitAccounting` to **re-grant**
   it and clear the barrier — the side effect this design must reproduce exactly.

5. **`commitAccounting`** (`commit-accounting.ts:122–210`). For `newRefs` only:
   catalog `present=1`, charge `used_bytes` via `NOT EXISTS blob_refs`, grant
   (`ON CONFLICT … granted_at`), un-condemn `gc_candidates` (`deleting_at IS
   NULL`), clear `blob_ref_candidates` — one chunked atomic `db.batch` per ≤3,000
   refs, each under the `accounts_cap_guard` trigger. The `blob_refs`/`blobs`
   inserts are also fenced by the migration-0024 `rbox_delete_fence` triggers: an
   insert/present-update on a sha under an active `gc_candidates` intent
   `RAISE(ABORT,'rbox_delete_fence')`, aborting the super-batch → 422 needsUpload.

6. **Final atomic parent/epoch CAS** (`workspace-sync.ts:443–471`). A
   synchronous `transactionSync` with no `await` inside: re-read `head`, assert
   `parent === head.sequence` (else 409 conflict, with equivocation detection),
   assert `commitEpoch === currentEpoch` (else 409 epoch_stale), assert
   `commitSeq === watermark + 1`, then advance `head`/`headWatermark`, persist
   the full `SignedCommit` verbatim at `seq:<next>`, mark the roots index
   `lagging`. Timed as `commitMs` (≈0 — the work is all in steps 4–5).

Steps 4–5 are the ~6s pole. Steps 2 (parse) and 6 (CAS) are cheap. **The parent
commit is never read**: admission re-derives satisfiability for the entire child
set from scratch, ignoring that the parent — the current authoritative head — was
already fully validated and accounted when *it* published.

### 2.1 What the DO already has

The DO stores every commit body verbatim at `seq:<n>` and exposes
`refSetAt(seq)` (`workspace-sync.ts:597–609`), which parses the refset (inline or
via `loadSidecarShaSet`) for any retained sequence. The roots-index folder
(`foldSequence`, `:535–595`) *already* computes a parent→child ref delta lazily
in the alarm via `diffChunk` (`:986–994`) over two sorted sets. **This design
does synchronously, at admission time, the same parent→child diff the folder
does asynchronously** — from the same immutable `seq:<n>` bodies through the same
`refset.ts` codec, so the two can never disagree about what the delta is.

Crucially, **the parent of an admitted commit is, by construction, the current
head** (`parent === cb.parentSeq`, and the final CAS asserts `parent ===
head.sequence`). `seq:<parent>` is therefore always present (the head is never
pruned) and immutable (a `seq:<n>` key is written once, when sequence n
publishes). The parent refset is available with zero R2 dependence beyond the
parent sidecar object it already references.

---

## 3. Design

### 3.1 Shape

Replace step 3–4's "build the full child SHA set and validate all of it" with a
server-computed delta:

```
parentRefs  ← parseRefset( parent sidecar or inline )   // sorted, with sizes
childRefs   ← sc.refShas (already sorted, with sizes)    // from resolveSidecarBytes
delta       ← mergeDiff(parentRefs, childRefs)           // O(N) two-pointer, no Sets
fenceSet    ← activeFenceShasForCommit(accountId)        // small; often empty
admitSet    ← [encManifestSha, sidecarSha]               // carriers, always
            ∪ delta.added                                 // child-only refs
            ∪ { c ∈ delta.carried : c ∈ fenceSet }        // carried-needing-regrant
validate+account(admitSet)                                // today's functions, tiny input
// removed refs: nothing at commit time (unchanged — Phase-1 reclaims on unreachability)
```

`validate+account` is the **existing** `validateCommitRefs` + `commitAccounting`,
called with a set proportional to the change instead of the workspace. Their
internal semantics — batched candidacy-aware `SELECT`, `NOT EXISTS` charge,
`ON CONFLICT` grant, cap guard, fence triggers, receipt verify — are **untouched**.

For a zero-file commit the refset is byte-identical to the parent's, so
`sidecarSha` is **carried** (same bytes → same sha, already entitled+present) and
`delta.added` is empty; `encManifestSha` is new (a fresh manifest snapshot each
commit) → one added carrier. `admitSet` ≈ 2 refs → a handful of D1 statements.
That is the ≤200ms target.

### 3.2 Delta computation — bounded, streaming

`mergeDiff` is a two-pointer merge over two **sorted** `Ref[]` arrays
(`parseRefset` guarantees ascending-by-raw-sha, deduped — `refset.ts:96`):

```
i=j=0
while i<P and j<C:
  if P[i].sha == C[j].sha:  carried++;      i++; j++   // (optionally probe fenceSet)
  elif P[i].sha <  C[j].sha: removed++;      i++          // parent-only
  else:                      added.push(C[j]); j++        // child-only (carries size)
drain P → removed;  drain C → added
```

- **No 112k-entry `Set`s.** Peak added memory is the parent `Ref[]` (~112k ×
  ~48B ≈ 5.4MB) plus the child array `resolveSidecarBytes` already holds. Worst
  case at the `MAX_REFS_PER_COMMIT` (250k) cap: two arrays ≈ 24MB, well under the
  128MB isolate budget. The child count is already capped before the R2 GET
  (`workspace-sync.ts:376–380`); the parent count is capped identically at parse.
- **`added` carries R2-measured `size`** (from the strictly-validated child
  refset) so quota is priced by the server, never by the client.
- **Only `added` and `carried∩fence` cross into D1.** `removed` and
  `carried∖fence` cost zero D1 statements. Admission D1 work is
  O(added + fenceSet), not O(workspace).

### 3.3 The fence set — carried-ref regrant, defined precisely

**The subtlest requirement.** Today's full `validateCommitRefs` provides
carried-ref fence-regrant as a side effect: it re-checks *every* child ref
against the two `NOT EXISTS` barriers, so a **carried** ref under an active
barrier is pulled into `newRefs` and regranted (clearing the marker) or fenced
(422). If the delta path validated only `added` refs it would **skip carried
refs entirely** — and a carried ref that a concurrent GC has marked or condemned
would slip past, publishing a head that references a blob Phase-1 is about to
drop or Phase-2 is about to delete. **That is data loss / a dangling ref.** It
must not happen.

The barrier predicates are exactly two, and both populations are **small tables
independent of workspace size**:

- `blob_ref_candidates WHERE account_id = ?` — this account's Phase-1 prune
  markers (`gc-phase1.ts:47–78`; PK `(account_id, sha256)` → prefix scan).
- `gc_candidates WHERE deleting_at IS NOT NULL` — active deletion intents
  (`versions.ts:openIntents`; indexed by `idx_gc_candidates_execute` on
  `(deleting_at, sha256)`). encShas are account-unique
  (`gc-phase1.ts:151–153`), so a global active intent on a carried ref of this
  account belongs to this account.

`activeFenceShasForCommit(accountId)` loads both into one `Set<string>` (capped
at `FENCE_SET_MAX`, below), then `mergeDiff` tests each **carried** ref for
membership; matches join `admitSet`. This reproduces today's newRefs set on
carried refs **exactly** — the same two predicates over the same two
populations, intersected with the same carried refs. `added` refs, which always
go through `validateCommitRefs`, get identical fence treatment to today (the
folded `NOT EXISTS` still runs on them). The carriers (`encManifestSha`,
`sidecarSha`) always go through `validateCommitRefs` too, so they are
fence-checked identically to today.

**Why a healthy commit's fence set is ~empty** (the inductive backbone): a ref
is `blob_ref_candidate`-marked or `gc_candidate`-intented only when it is
**unreachable from the DO's authoritative roots** (`gc-phase1.ts:47–63`,
`versions.ts:reachableFromWorkspaces` reads the live gap `seq:synced+1..head`, so
the reachable set always includes the current head's refs and GC **never** marks
a ref reachable from head). A carried ref is in the parent = the current head =
reachable, so a correctly-behaving GC never marks it. Inductively: every
published commit already clears the markers/fences on its own `added` and
`carried∩fence` refs (a commit that couldn't clear a fence gets a 422 and never
publishes), so when the parent is head all its refs are present and unmarked; a
child's carried refs ⊆ the parent's refs are therefore clean at parent-publish
time. The only way a carried ref is fenced at admission is a **concurrent** GC
marking in the narrow window since the parent published — precisely the case the
live fence-set probe catches. **Invariant preserved: `carried ⟹ (present ∧
unmarked) ∨ (in fenceSet)`.** The fallback (§3.5) closes the residual: any
carried ref that is somehow neither present nor fenced is caught by
fail-closed full validation.

### 3.4 Never trust a client additions list

The delta is derived **server-side** from (a) the authoritative, immutable
`seq:<parent>` body and (b) the strictly-validated child sidecar (hash-,
encoding-, size-, `totalBytes`-checked). The client supplies neither the parent
refset (read from DO storage) nor an additions list. A client cannot:

- make a ref "carried" that is not in the parent (the parent bytes are the
  server's, immutable);
- hide an added ref (any child ref absent from the parent **is** added and **is**
  charged);
- forge or replay a refset (the child sidecar's `sidecarSha` is hash-verified
  against its bytes and the signed descriptor; a replayed old sidecar simply
  yields its own honest delta against the parent).

Under-charging via delta manipulation is therefore impossible: the added set is a
pure function of two server-authoritative inputs.

### 3.5 Fallback — fail CLOSED to full validation

The delta path is an **optimization layered over** today's full validation, which
remains present and is the correctness backstop. Fall back to the full
`validateCommitRefs` over the entire child set (chunked exactly as today) on
**any** of:

1. **First commit / genesis** (`parent === 0`): `refSetAt(0)` is the empty set;
   the whole child is "added" — run full validation (identical result, no delta
   benefit).
2. **Parent refset unavailable**: `seq:<parent>` missing, or its body/sidecar
   fails to parse/verify (missing R2 object, hash/encoding/size mismatch).
3. **Epoch rotation**: the parent commit's `accountEpoch` ≠ the child's
   `commitEpoch`. Across a rotation nearly every ref is re-encrypted (new
   encShas) → an all-added delta with no benefit; the full path is the proven
   behavior and this keeps responses identical.
4. **Fence set too large**: `activeFenceShasForCommit` exceeds `FENCE_SET_MAX`
   (a mass GC sweep) — cheaper and safer to full-validate than to hold a huge
   fence set.
5. **Refset too large to diff**: parent or child count exceeds `FOLD_MAX_REFS`
   (250k, the roots-index fold cap) — bounds Worker CPU/heap.
6. **Any delta-integrity doubt**: parent/child not both strictly sorted (a codec
   invariant violation), or any internal assertion in `mergeDiff` trips.

Fallback is **never fail-open**: an unreadable parent produces *more* validation,
not less. When enforced, fallback is silent-correct (identical response);
counters record its frequency so an unexpectedly high fallback rate is visible.

### 3.6 Bounded 422 recovery

The delta path returns the **same** 422 `unsatisfiedBlobsBody(needsUpload)` the
full path returns, because it calls the same `validateCommitRefs`/
`commitAccounting` and surfaces the same `needsUpload`/fence-abort/over-cap
results — just over `admitSet`. A carried ref that turns out fenced yields its
sha in `needsUpload` → the client re-PUTs the bytes (the fresh PUT un-condemns
via the accounting path) and retries, exactly as today. The 422 recovery loop is
byte-identical; only the set of shas that can appear in it is (correctly) the
change plus any concurrently-fenced carried refs.

### 3.7 Placement and the CAS

The delta admission slots in exactly where steps 3–5 are today
(`workspace-sync.ts:392–420`), between `resolveSidecarBytes` and the final CAS.
The final atomic parent/epoch CAS (`:443–471`) is **unchanged, byte-for-byte**.
TOCTOU safety: the delta is computed against the immutable `seq:<parent>`; if a
concurrent commit advances the head during our (awaited) delta/accounting work,
the final CAS observes `parent !== head.sequence` and returns 409 — the
accounting we did is already durable and benign (refs entitled+present; a retry
charges 0), identical to today's account-then-publish semantics.

If design 103's early parent/epoch preflight ships, it runs **before** this
admission (a cheap head read short-circuits known-stale commits to 409/422 before
any delta work). On the clean path 103 changes nothing and the delta runs; on the
stale path the delta never runs. They compose without overlap (§9).

---

## 4. Correctness requirements (the audit's nine)

Each subsection states the invariant and why the delta path preserves it.

### 4.1 Server-priced quota

`added` refs carry `size` from the **strictly-validated child sidecar**
(R2-measured, `refset.ts` safe-integer bound), never a client number.
`commitAccounting` charges via `NOT EXISTS blob_refs`. **Equivalence proof:** for
any carried, already-entitled ref, today's `commitAccounting` charges exactly 0
(the `NOT EXISTS blob_refs` sub-select in the `used_bytes` UPDATE yields 0) and
re-grants a no-op (bumps `granted_at` only, which is *explicitly not* a
correctness barrier — `blob_ref_candidates` is; `gc-phase1.ts:8–10`,
`commit-accounting.ts:178–182`). Omitting carried non-fenced refs from accounting
therefore changes `used_bytes` by **0** and changes durable state only by *not*
bumping `granted_at` on unchanged refs. The resulting `used_bytes` is
byte-identical to today's.

### 4.2 Idempotent receipt redemption

Receipts are verified only for refs in `admitSet` that are not entitled+present
(inside `validateCommitRefs`), unchanged. Re-running an admitted commit charges 0
/ grants no-ops (NOT-EXISTS / ON CONFLICT), unchanged. The standalone
`redeemReceipts` path (`workspace-sync.ts:625–685`) is not touched. Fewer refs
are presented to receipt verification, never more; a receipt for a carried
non-fenced ref is simply never needed (that ref is already entitled).

### 4.3 Account entitlement

The have-set / grant machinery is unchanged. Carried non-fenced refs are already
entitled (the parent published them); skipping their re-grant does not revoke
entitlement (grants are not TTL'd; only Phase-1 purge drops a `blob_refs` row,
and it never drops a ref reachable from head — §3.3). Carried fenced refs and
added refs are (re-)granted through the unchanged path.

### 4.4 `blob_ref_candidates` regrant

A carried ref under this account's Phase-1 marker is in `fenceSet` → in
`admitSet` → `commitAccounting` clears its `blob_ref_candidates` row atomically
with the (re-)grant (`commit-accounting.ts:182`), identical to today. Added refs
that happen to be marked are handled by the same folded `NOT EXISTS` inside
`validateCommitRefs`. The marker barrier is thus never bypassed by the delta.

### 4.5 Active `gc_candidates` deletion fences (RAISE-ABORT)

A carried ref under an active intent is in `fenceSet` → in `admitSet` → its
`blob_refs`/`blobs` (re-)insert in `commitAccounting` hits the migration-0024
`rbox_delete_fence` trigger and `RAISE(ABORT,'rbox_delete_fence')`, aborting the
super-batch → `{ needsUpload }` → 422, exactly as today. The delta path can never
publish a head referencing a sha with an open delete intent, because every such
carried ref is forced through the fenced accounting batch.

### 4.6 Retained history roots

The complete child sidecar remains the retained root: `resolveSidecarBytes` still
GETs and strictly validates the **full** child sidecar (needed both to diff and
to keep the head's sidecar durable), and the final CAS still persists the full
`SignedCommit` body verbatim at `seq:<next>` **unchanged**. The delta path
removes O(N) *D1* work; it removes **no** stored state and shortens **no** retained
representation.

### 4.7 Design-96 root-index invariants (delta feeds the index)

The roots index (`dropped_index`, `seq_roots`) is maintained by the crash-safe,
cursored alarm folder (`foldSequence`) and is **not moved onto the commit hot
path** — doing so would risk divergence and add work to the pole we are
shrinking. The index stays correct because commit still stores the full child
body verbatim at `seq:<next>` (the folder's only input) unchanged. The admission
delta and the fold delta are computed from the *same* immutable `seq:<n>` bodies
through the *same* `refset.ts` codec and the *same* two-pointer semantics, so
they are **equal by construction** — the audit's "feed the same delta into the
root index" is satisfied as an equality-of-derivation, not a second writer.
(Optionally priming `foldPrevCache` with the just-computed child refset is a
pure-performance follow-on, out of scope — §8.)

### 4.8 Bounded 422 recovery — see §3.6

Parent-refset-missing/corrupt is a **fallback trigger** (§3.5 item 2), not a 422:
the commit still admits via full chunked validation and either succeeds or 422s
on genuinely-missing blobs. Fail-closed: an unreadable parent yields more
validation, never a skipped check.

### 4.9 Final atomic parent/epoch CAS — unchanged

`workspace-sync.ts:443–471` is byte-for-byte unchanged: same head re-read, same
`parent === head.sequence` / `commitEpoch === currentEpoch` / `commitSeq ===
watermark + 1` assertions, same equivocation detection, same head/watermark/seq
persistence, same `index_state → lagging`. The 409/422/epoch responses are
byte-identical.

---

## 5. Phase 0 — measurement (privacy-hard)

`serverTimings.accountingMs` already renders live. Add counters (SHA/count only —
**HARD RULE: no raw file names or paths in any metric or log; SHAs are opaque
hashes and are fine**):

- `commit.delta.added`, `commit.delta.removed`, `commit.delta.carried` — delta
  sizes.
- `commit.delta.carried_fenced` — carried refs pulled in for regrant.
- `commit.delta.admit_stmts` — D1 statements issued by admission (the falsifiable
  "proportional to delta" signal).
- `commit.delta.fallback{reason}` — fallback frequency by trigger (§3.5).
- `commit.delta.divergence` — shadow-mode disagreement count (§6).

These attach to the existing `op.done`/metric event; no new PII surface. The
existing `accountingMs` split lets Phase 0 confirm the D1 pole collapses before
any behavior flips.

---

## 6. Shadow mode

An intermediate flag state that computes the delta **without making it
authoritative**:

- Run today's **full** `validateCommitRefs` + `commitAccounting` as the real,
  charging authority (behavior 100% unchanged).
- **Separately** compute `admitSet` via the delta path as a **dry** derivation
  (no accounting executed — avoids double-charge).
- Compare the delta's would-charge/would-validate set against the full path's
  `newRefs`, and compare the would-be outcome (ok / 422-needsUpload / 402-overCap
  / fence-abort). Any symmetric-difference or outcome mismatch increments
  `commit.delta.divergence` and logs `{ head seq, added/removed/carried counts,
  divergent shas }` — SHAs only.

Shadow mode is safe by construction (the enforced result is the proven full
path). The **divergence gate**: `commit.delta.divergence` must read **zero** over
the soak window (§7) — across Workload A *and* real fleet traffic, including at
least one commit that exercises each of a clean change, a carried-fence regrant, a
quota-boundary charge, and a concurrent-GC window — before the flag flips to
enforce.

---

## 7. Falsifiable gates

On the fixed ~112k-ref Workload A (audit §Workload A):

1. **Clean one-file commit POST p50 ≤ 2s** (from ~8s — the headline audit gate).
2. **`accountingMs` is O(added refs), not O(workspace).** A near-zero-change
   commit's `accountingMs` ≤ 200ms.
3. **D1 statements per commit proportional to delta size.**
   `commit.delta.admit_stmts` scales with `added + carried_fenced + 2`, with **no
   full-ref statement growth** as the workspace grows.
4. **Zero divergence in shadow mode** over the soak (§6) — the flip precondition.
5. **Identical behavior under the candidate / fence / quota race suites.** Rerun
   the design-95/96 fence and race rigs, the quota/over-cap suite, and the
   E2EE-determinism suite: pass unchanged.
6. **409 / 422 / epoch responses byte-identical** between delta and full paths
   (asserted directly by the shadow-mode outcome comparison and a response-golden
   test).

Any gate failing falsifies the design as scoped; none is a promise.

---

## 8. Out of scope

- **Manifest snapshot compression / O(change) manifest deltas** — design 84
  (C1/C2/D). This design shrinks server admission; design 84 shrinks client
  bytes. Necessary-but-not-sufficient in both directions (audit Finding 4).
- **A refset-delta wire representation** (client sends only the change; server
  never parses two full sidecars) — the audit's "later refset delta
  representation." This v1 still parses both complete sidecars (O(N) Worker CPU),
  removing only the O(N) **D1** work, which is the measured ~6s pole. The
  wire-delta is a follow-on that removes the residual parse/R2 cost.
- **Client preflight + early stale/epoch rejection** — design 103 (sibling,
  drafted in parallel). 103's preflight runs *before* this admission; on the
  stale path the delta never runs, on the clean path 103 changes nothing. See §9.
- **Moving the roots-index fold onto the commit hot path** — the delta feeds the
  index by equality-of-derivation (§4.7); an explicit hot-path prime of
  `foldPrevCache` is a pure-perf follow-on.

---

## 9. Composition with design 103

Design 103 (early stale-parent / epoch rejection, audit Finding 2) adds a cheap
head/epoch preflight after envelope parse and before the expensive admission
work. Ordering when both ship:

```
parse envelope
  → [103] cheap preflight: read head; if parent≠head → 409, if epoch≠current → 409
  → resolveSidecarBytes (child)          ← [102] begins here
  → delta admission (this design)
  → final atomic CAS (unchanged authority for both)
```

103 is a fast-reject optimization; 102 is a fast-admit optimization. They touch
disjoint code and share the unchanged CAS as the single source of authority. On a
known-stale commit, 103 returns before 102 runs (102 does zero R2/D1 work). On a
clean commit, 103 is a no-op and 102 does the O(change) admission. Neither
weakens the other; the CAS remains the sole authority that can publish a head.

---

## 10. Rollout

Flag-gated by a worker env var `RBOX_COMMIT_DELTA_ADMISSION ∈ {off, shadow,
enforce}`, read per request. **No D1 migration** — pure code plus the env var, so
the auto-apply-migrations Workers-Builds hook (`docs/DEPLOYMENTS.md`) is not
engaged and the change is reversible by flipping the var.

1. **Dev worker first** (`rbox-dev-api`, per the DEPLOYMENTS dev-first rule):
   deploy with `off`, then `shadow`. Run Workload A + real dev-fleet traffic.
2. **Soak in shadow** until the divergence gate (§6/§7.4) reads **zero** over the
   window: a minimum commit count and wall-clock duration that exercises clean,
   carried-fence, quota-boundary, and concurrent-GC cases with 0 divergence.
3. **Flip dev to `enforce`**; confirm gates 1–3, 5, 6 on dev. Soak.
4. **Prod**: merge to `main` (auto-deploys the worker) with the var **defaulting
   `off`**; flip prod to `shadow` via the var, soak with the divergence gate on
   prod traffic, then `enforce`. Because the flag is an env var, rollback at any
   step is a var flip, not a redeploy. The full-validation path stays in the code
   as the permanent fallback (§3.5) even after `enforce`.

---

## 11. Open questions for the founder

1. **Fence-set cap.** `FENCE_SET_MAX` bounds the active-intent set we will hold;
   above it we full-validate. A value (e.g. 50k) trades a rare mass-GC commit's
   speed for a hard memory bound. Acceptable, or prefer a paginated fence probe?
2. **Soak thresholds.** What commit-count × duration (and which fleet hosts)
   constitutes a sufficient zero-divergence window before each `shadow→enforce`
   flip on dev and on prod?
3. **Enforce-time fallback telemetry.** Should a nonzero
   `commit.delta.fallback{reason≠first_commit}` rate in `enforce` page/alert (it
   means parent-refset reads or epoch detection are misbehaving), or only
   dashboard?
