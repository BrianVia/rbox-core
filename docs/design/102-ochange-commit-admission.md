# 102 — O(change) commit admission: server-side parent→child ref delta

Status: DRAFT v3, 2026-07-11 — rounds 1–2 folded (REVIEW-102.md). Under adversarial
review.

Companion to design 84 (§6.1 named this design explicitly): design 84's C1/C2/D
shrink the *client* manifest lane but "no phase of this design shrinks" the
*server's* O(workspace-refs) commit admission — that is this design's job. This
is the sufficient half of the pair: design 84 makes the bytes O(change); design
102 makes the server D1 admission O(change). Together they make the ≤3–4s commit
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

The pathology: **D1** admission cost scales with **workspace size**, not with the
**change**. This design removes the O(workspace) **D1** work. It does **not** (in
v1) remove the O(workspace) sidecar **parse/fetch** CPU — that residual is the
wire-delta follow-on's target (§8), and §7's total-admission gate measures it
honestly. The client-side 41.2MB manifest upload (u≈3.1–3.4s) is design 84's
territory, explicitly **not** this design's.

The governing rule (audit §Final assessment): *a small change must perform work
proportional to the change.* This design makes commit **D1** admission obey it.

---

## 2. Current admission walkthrough (from code)

All of `commit()` runs **inside the `WorkspaceSync` Durable Object**
(`apps/api/src/workspace-sync.ts`), the authoritative per-(workspace, project)
sequencer. The receipts-protocol sidecar path:

1. **Envelope parse** (`workspace-sync.ts:275–341`). Capped body read, JSON parse,
   shape/hash/seq/epoch field checks, `readRefMode` discriminates inline vs
   sidecar. `serverTimings.envelopeMs` ends here.
2. **Sidecar resolution** (`resolveSidecarBytes`, `sidecar.ts:72–112`, timed
   `sidecarMs`). Entitlement gate (receipt or entitled+present) **before** the R2
   GET; then `loadSidecarRefs` GETs the canonical sidecar object, checks
   `obj.size === refsetByteLength(count)` before buffering, hash-verifies
   `sidecarSha`, `parseRefset` strictly decodes (magic, exact length, **sorted
   ascending by raw sha**, no dups, safe sizes — `refset.ts:82–104`), and
   re-sums+matches `totalBytes` to the signed descriptor. Returns the full child
   data-ref array, canonically sorted.
3. **Build the accounting SHA set** (`workspace-sync.ts:392`):
   `shas = [encManifestSha, sidecarSha, ...sc.refShas]` — two carriers plus
   **every** data ref (~112k).
4. **`validateCommitRefs`** (`commit-accounting.ts:61–109`, timed `accountingMs`).
   Per SHA, an entitled-AND-present `SELECT` batched ≤90/statement, ≤34/`db.batch`.
   The have-set `SELECT` folds two `NOT EXISTS` barriers
   (`commit-accounting.ts:83–86`): **`blob_ref_candidates`** (this account's
   Phase-1 prune marker) and **`gc_candidates` with `deleting_at IS NOT NULL`** (an
   active deletion intent). A ref hitting either barrier reads **not-satisfied**,
   falls to `newRefs`, needs a valid receipt, and its chargeable **size comes from
   `verifyReceipt`** (`:104–106`) — never from the sidecar. `commitAccounting`
   then re-grants it and clears the barrier.
5. **`commitAccounting`** (`commit-accounting.ts:122–210`). For `newRefs` only:
   catalog `present=1`, charge `used_bytes` via `NOT EXISTS blob_refs`, grant
   (`ON CONFLICT … granted_at`), un-condemn `gc_candidates` (`deleting_at IS
   NULL`), clear `blob_ref_candidates` — chunked atomic `db.batch` per ≤3,000 refs,
   under the `accounts_cap_guard` trigger. The `blob_refs`/`blobs` inserts are
   fenced by the migration-0024 `rbox_delete_fence` triggers: an insert/present=1
   on a sha under an active `gc_candidates` intent `RAISE(ABORT)` → the caught
   super-batch's shas become `needsUpload` → 422.
6. **Final atomic parent/epoch CAS** (`workspace-sync.ts:443–471`). Synchronous
   `transactionSync`, no `await` inside: re-read `head`, assert `parent ===
   head.sequence` (else 409 conflict + equivocation detection), `commitEpoch ===
   currentEpoch` (else 409 epoch_stale), `commitSeq === watermark + 1`, then
   advance `head`/`headWatermark`, persist the full `SignedCommit` verbatim at
   `seq:<next>`, mark the roots index `lagging`. Timed `commitMs` (≈0).

Steps 4–5 are the ~6s pole. **The parent commit is never read**: admission
re-derives satisfiability for the entire child set from scratch, ignoring that the
parent — the current authoritative head — was already fully validated and
accounted when *it* published.

### 2.1 What the DO already has

The DO stores every commit body verbatim at `seq:<n>` and exposes `refSetAt(seq)`
(`workspace-sync.ts:597–609`). The roots-index folder (`foldSequence`, `:535–595`)
already computes a parent→child ref delta lazily in the alarm via `diffChunk`
(`:986–994`). Crucially, **the parent of an admitted commit is, by construction,
the current head** (`parent === cb.parentSeq`, and the final CAS re-asserts
`parent === head.sequence`). `seq:<parent>` is therefore always present (the head
is never pruned; prune only drops `seq ≤ floor < head`) and **immutable** (a
`seq:<n>` key is written once, at publish). The parent refset is available with
one R2 GET of the parent's sidecar object.

---

## 3. Design

### 3.1 Shape

Replace steps 3–4's "build the full child SHA set and validate all of it" with a
server-computed delta. `admitSet` is a **SHA list** fed to the **unchanged**
`validateCommitRefs`/`commitAccounting` — no sizes flow through the diff:

```
parentBytes ← R2 GET + strict parse of parent sidecar (or inline refs)   // sorted 40B records
childBytes  ← sc.refShas bytes (already fetched+parsed by resolveSidecarBytes)
added[]     ← mergeAddedShas(parentBytes, childBytes)   // child-only SHAs, streaming over buffers
fence∩carr  ← fenceProbe(accountId) intersect carried   // MUST be empty (invariant §3.3); else fallback
admitSet    ← [encManifestSha, sidecarSha, ...added]     // SHA list, no sizes
validateCommitRefs(admitSet, receipts) → newRefs         // sizes from verifyReceipt, UNCHANGED
commitAccounting(newRefs)                                // UNCHANGED
// removed/carried refs: zero D1 work (unchanged — Phase-1 reclaims on unreachability)
```

`validateCommitRefs`/`commitAccounting` are byte-for-byte the existing functions.
The **only** change is that `admitSet` is proportional to the change instead of
the workspace. §4.1 proves the resulting `newRefs` is **identical** to today's.

For a zero-file commit: `sidecarSha` is byte-identical to the parent's (same
refset → same bytes → same sha), so it is already entitled+present → lands in
`have` → charged 0; `encManifestSha` is new → one added carrier; `added` is empty.
`admitSet` = 2 SHAs → a handful of D1 statements → the ≤200ms accounting target.

### 3.2 Delta computation — streaming over byte buffers (loader refactor + honest heap)

The diff runs as a **two-pointer merge over the two sidecar byte buffers**, never
materializing `Ref[]` arrays or `Set`s for the diff itself. A sidecar is `18 +
40·count` bytes; record `k` is at offset `18 + 40k`, its 32 raw sha bytes at
`[18+40k, 18+40k+32)`, records **strictly ascending by raw sha** (`parseRefset`
invariant, `refset.ts:96`). We compare 32-byte slices directly:

```
i=j=0
while i<P.count and j<C.count:
  cmp = compare32(parentBytes, 18+40i, childBytes, 18+40j)
  if cmp == 0: carried++; (probe fence); i++; j++
  elif cmp < 0: removed++; i++                       // parent-only
  else: added.push(hex(childBytes, 18+40j)); j++     // child-only
drain P → removed++;  drain C → added.push(...)
```

**Loader refactor (round 2 item 3).** Current `resolveSidecarBytes`
(`sidecar.ts:72–112`) returns `refShas: string[]` and does **not** retain the raw
buffer; current admission then builds another array + `Set`
(`workspace-sync.ts:381–405`). The delta path must NOT allocate those. Concretely:

- Add `loadSidecarRaw(env, sidecarSha, count)` that performs the same strict gate
  (size-before-buffer, hash-verify, magic/length/sorted/dup checks) and returns the
  **verified raw `Uint8Array`**, computing `totalBytes` by **streaming the size
  fields off the buffer** (no `Ref[]` materialization). `resolveSidecarBytes` keeps
  its entitlement gate and calls `loadSidecarRaw`.
- **Delta path:** hold the verified child raw buffer (from `loadSidecarRaw`), GET +
  `loadSidecarRaw` the parent buffer, `mergeAddedShas` over the two buffers →
  `added` SHA list. It never builds the full child `refShas` array or a `Set`.
- **Fallback path (§3.5):** materializes the full child `refShas` from the same
  buffer exactly as today (the O(N) allocation is acceptable there — it is the
  proven path). Retain the child buffer only until whichever path consumes it.

**Honest simultaneous-allocation model (round 2 item 3; do not claim "removed").**
Peak heap during a delta admission is the sum of what is live at once:

- parent raw buffer `18 + 40·count` — ≤10MB at the 250k cap;
- child raw buffer — ≤10MB;
- the `added` SHA list — for an O(change) commit ~0; worst case a fully-disjoint
  250k change materializes up to 250k 64-hex strings (~18–34MB with V8 string
  overhead), the **same** worst case today's full path already carries;
- the in-flight request state (commit JSON, receipts map, D1 statement arrays);
- **if** a design-96 alarm fold is active in the **same isolate**, its two
  `Set<string>` from `refSetAt` (`workspace-sync.ts:597–608`) — but the
  module-level `isolateFoldActive` mutex bounds this to **one** fold, and
  `foldSequence` re-arms rather than overlapping a second.

This is bounded but not trivially small; §7 **gate 4** measures the true peak at
250k disjoint with a concurrent fold, max receipts, fallback, and shadow on, and
lowers `MAX_REFS_PER_COMMIT`/`FOLD_MAX_REFS` via the pre-authorized paired-cap
contingency if the budget is exceeded. The win versus today is that the **common
O(change) case** allocates two ~small buffers and a near-empty `added` list instead
of a 112k `have` `Set` plus ~1,245 D1 statement objects — but the worst case is
budgeted, not hand-waved.

- **Sizes never touch the diff.** `mergeAddedShas` reads only the 32 sha bytes;
  chargeable sizes for `added` come exclusively from `verifyReceipt` inside
  `validateCommitRefs` (§4.1).
- **D1 work is O(added), not O(workspace).** `removed`/`carried` cost zero D1
  statements.

### 3.3 Carried-ref safety — the D1 invariant, not a snapshot

**Round 1's central finding.** A carried ref (in both parent and child) is **not**
sent to `validateCommitRefs`/`commitAccounting`, so it does not pass through the
candidacy-fold or the `rbox_delete_fence` trigger. If a carried ref could fall
under an active deletion intent between admission and publication, its blob could
be physically deleted while the new head references it — data loss. The safety
argument must therefore be a **D1-serialized invariant**, not a
read-then-hope snapshot. It is:

> **Carried-ref invariant (live accounts).** For an account that is **not** in an
> in-progress hard-deletion, a ref carried by an admitted commit holds a live
> `blob_refs(account_id, sha)` row for this account continuously across admission
> and publication, and therefore (a) **no active deletion intent can exist or be
> created against it**, and (b) **it can never be Phase-1-purged**.

**Deletion scope (round 2 item 1).** Account hard-deletion drops `blob_refs`
unconditionally (`account-delete.ts:228–254`, step 2) before the DO purge (step 4,
`:301–316`), so the invariant does **not** cover a deleting account. That path is a
deliberate erase of the whole workspace (the head and its DO are purged too), so
carried-ref durability is explicitly not a goal there. To keep the delta path
provably equivalent to full validation even under a commit⇄deletion race, **an
account with an in-progress deletion is a fallback trigger** (§3.5A): the delta path
is simply disabled for it, so it behaves byte-for-byte like today. Gate R includes
an account-deletion transition.

Proof, from the GC code (live account):

- **(a) Intent creation is D1-blocked by the live ref.** The only site that sets
  `deleting_at` (opens an intent) is `openIntents`
  (`versions.ts:431`): `UPDATE gc_candidates SET deleting_at=? WHERE sha256=? AND
  deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE sha256=?)`. The
  `NOT EXISTS blob_refs` guard means an intent **cannot** be opened against any sha
  that has *any* `blob_refs` row. A carried ref has this account's row (granted
  when the parent — or an earlier commit — admitted it, and never dropped, by (b)).
  So the `rbox_delete_fence` trigger's precondition (an active intent) **never
  arises** for a carried ref. This is the D1-level serialization: the persistence
  of the carried ref's `blob_refs` row *is* the barrier. No fence snapshot is
  relied upon.
- **(b) Phase-1 never drops a carried ref's row.** `phase1Purge` drops a
  `blob_refs` row only for a candidate that is **still unreachable** at a
  freshly-recomputed reachability (`gc-phase1.ts:104–149`); a reachable candidate
  is **resurrected** (unmarked), not dropped (`:114–118`), and the delete is
  marker-guarded in the same D1 batch (`:135–147`) so a concurrent
  `commitAccounting` marker-clear no-ops it. Reachability
  (`reachableFromWorkspaces`) reads the DO `/roots` **including the live gap
  `seq:synced+1..head`** and **fails closed** (throws, aborting the account's GC)
  on any unreadable page. A carried ref is in the parent = the current head ⟹ in
  `ROOTS(head)` ⟹ reachable ⟹ resurrected, never dropped.
- **On "never marked" (round 2 item 1, made precise).** For the per-account
  `phase1Mark`/`blob_ref_candidates` marker: `runPhase1` computes reachability then
  marks **in the same pass** (`gc-phase1.ts:203–222`), and only marks a ref whose
  `granted_at` is older than grace (`:61`). A ref that is carried but was *not* in
  that pass's reachable snapshot must have entered head-reachability **after** the
  snapshot — i.e. it was (re-)granted after the snapshot, so it is grace-fresh at
  mark time and skipped; a ref already reachable at the snapshot is reachable-skipped.
  Either way a carried ref is **never `blob_ref_candidate`-marked** ⟹ `fence ∩
  carried = ∅` for that table. The **global** `gcMark` (`versions.ts:205–221`) keys
  on object age, not `granted_at`, and can transiently leave a **`deleting_at IS
  NULL`** `gc_candidates` row on a carried ref — but that row is **not an active
  intent** (the fence probe reads only `deleting_at IS NOT NULL`), **cannot become
  one** (the (a) `NOT EXISTS blob_refs` guard), and is **resurrected** by
  `openIntents` on the next reachable recompute (`versions.ts:426–427`). It is
  harmless: no fence, no delete, no false page.
- **Induction closes the "was it clean at parent-publish?" gap.** When a ref first
  enters the workspace it is an *added* ref of some commit, admitted through the
  full validate/account path (or this design's `added` path — identical, §4.1),
  which clears any marker and is fenced. Thereafter, while it stays reachable, (a)
  and (b) keep it clean. A ref that is dropped by an intermediate commit and later
  re-added is *added* again (not carried) relative to that re-adding commit's
  parent, so it re-runs full validation. Hence every carried ref of every admitted
  commit satisfies the invariant.

**The fence probe is a fail-closed bug-detector, not the barrier.**
`fenceProbe(accountId)` still reads the two small fence tables
(`blob_ref_candidates WHERE account_id=?`; `gc_candidates WHERE deleting_at IS NOT
NULL`, capped at `FENCE_SET_MAX`) and intersects with the carried stream. By the
invariant this intersection is **provably empty**. So we assert it: a **nonempty**
`fence ∩ carried` means the invariant was violated (a GC bug, or an unmodeled
state) → the commit **falls back to full validation** (which handles it correctly
via the candidacy-fold + fence trigger) **and emits a high-severity alert**. This
converts round 1's "TOCTOU dependence" into a monitor that fails safe: the barrier
is the `blob_refs` invariant; the probe only catches its violation. The
deterministic race rig (§7 gate R) exercises fence-snapshot → intent-create →
publish → physical-delete interleavings and asserts no carried root is ever
deleted and no such interleaving even reaches intent-creation.

### 3.4 Trust model — authoritative parent, fully-validated additions

Round 1 correctly noted that hash-verifying the child sidecar proves *bytes match
`sidecarSha`*, not that the bytes are "server-authored." Restated precisely:

- The **parent** refset is server-authoritative (immutable DO `seq:<parent>`).
- The **child** refset is client-chosen. A client may author any canonical sorted
  refset, or replay an old sidecar. That is fine, because:
  - every **added** ref (child ∖ parent) is independently admitted by the unchanged
    `validateCommitRefs` — receipt-verified or already entitled+present — so the
    client gains nothing by listing a ref it cannot prove;
  - every **carried** ref is safe by the §3.3 invariant regardless of the child
    bytes;
  - **removed** refs (parent ∖ child) grant no authority (they are simply not in
    the new head).
- No **additions list** is ever taken from the client; `added` is derived
  server-side by diffing the authoritative parent against the strictly-validated
  child. Under-charging by delta manipulation is impossible: any ref the client
  puts in the child that is not in the parent **is** added and **is** charged.

Adversarial tests (§7): replay of a prior sidecar; omission of a ref present in the
signed body's descriptor (blocked by `resolveSidecarBytes` count/`totalBytes`
gate); substitution of one ref for another (each substitute is `added` → charged);
duplicate carriers or data refs (rejected by `parseRefset` dedup and the carrier
de-dup); a sidecar descriptor reused across two commits or across an epoch
boundary (epoch fallback, §3.5).

### 3.5 Fallback — fail CLOSED, and distinguish corruption from a miss

The delta path is an **optimization layered over** today's full validation, which
stays present as the correctness backstop. Two fallback classes:

**(A) Benign optimization-fallback** — run full `validateCommitRefs` over the whole
child set (chunked, exactly as today), identical response, on:

1. **First commit / genesis** (`parent === 0`): the whole child is "added"; no
   delta benefit.
2. **Epoch rotation**: parent commit's `accountEpoch` ≠ child's `commitEpoch` —
   nearly all refs re-encrypt to new addresses (all-added), no benefit, and the
   full path is the proven behavior.
3. **Refset too large to diff**: parent or child `count > FOLD_MAX_REFS` (250k) —
   bounds Worker CPU/heap.
4. **Fence probe over cap**: `fenceProbe` would exceed `FENCE_SET_MAX` (a mass GC
   sweep) — full-validate rather than hold a large set.
5. **Account deletion in progress** (§3.3 deletion scope): the account has an
   in-progress hard-deletion (`account_deletions` status), where `blob_refs` are
   being torn down unconditionally. Disabling the delta path here makes admission
   byte-for-byte identical to today under a commit⇄deletion race — the carried-ref
   invariant does not hold for a deleting account, so we do not rely on it.

**(B) Authoritative-history corruption** — `seq:<parent>` missing, or its
body/sidecar fails to parse/verify (missing R2 object, hash/encoding/size/`total
Bytes` mismatch), or a **nonempty `fence ∩ carried`** (§3.3). This is **not** an
ordinary miss: an unreadable retained head means design-96 folding will 503 and GC
is already disabled for the workspace (both fail closed). Handling:

- **Do not fail open.** Fall back to full child validation so blob admission stays
  correct (the new commit either succeeds against present blobs or 422s on genuine
  misses).
- **Do not silently succeed as if healthy.** Emit a **distinct high-severity**
  metric (`commit.delta.parent_unreadable` / `commit.delta.fence_violation`) that
  **pages**, mirroring design 84 §3.6's "fail loud, then repair" posture. GC/prune
  remaining disabled on that workspace is the correct, already-fail-closed
  consequence; the alert drives repair, not a wedge.
- **Never fail open under any fallback:** an unreadable parent yields *more*
  validation, never a skipped check.

### 3.6 Placement and the CAS

The delta admission slots in exactly where steps 3–5 are today
(`workspace-sync.ts:392–420`), between `resolveSidecarBytes` and the final CAS,
which is **unchanged, byte-for-byte** (`:443–471`). TOCTOU: the delta is computed
against the immutable `seq:<parent>`; if a concurrent commit advances the head
during our awaited work, the CAS observes `parent !== head.sequence` → 409 — the
accounting already done is durable and benign (refs entitled+present; a retry
charges 0), identical to today's account-then-publish semantics.

If design 103's early parent/epoch preflight ships, it runs **before** this
admission (§9).

---

## 4. Correctness requirements (the audit's nine)

### 4.1 Server-priced quota — `newRefs` identity proof

**Sizes come from receipts, never the sidecar.** `admitSet` is a SHA list; the
unchanged `validateCommitRefs` sources each added ref's chargeable size from
`verifyReceipt` (`commit-accounting.ts:104–106`). The sidecar `size` field is
advisory (`sidecar.ts:106–109`, "never bill") and is never read by the diff.

**Identity of the accounting input.** Let `have_full` be the set
`validateCommitRefs` computes over the full child set: refs that are entitled AND
present=1 AND not `blob_ref_candidate`-marked AND not under an active intent.
Today's `newRefs_full` = (fullChildSet ∪ carriers) ∖ `have_full`. The delta path
runs `validateCommitRefs(admitSet)` where `admitSet` = carriers ∪ `added`, giving
`newRefs_delta` = admitSet ∖ `have`. Every child ref **omitted** from `admitSet` is
a **carried, non-fenced** ref, which by §3.3 is entitled + present + unmarked +
unintented ⟹ ∈ `have_full` ⟹ ∉ `newRefs_full`. Therefore **`newRefs_delta` ===
`newRefs_full`** — the same SHAs, and (because both iterate the canonically-sorted
child refs and prepend the same carriers) in the same order. `commitAccounting`
receives an identical list → identical `used_bytes`, identical charge. For any
carried non-fenced ref, today already charges 0 (`NOT EXISTS blob_refs` yields 0)
and only bumps `granted_at` (explicitly **not** a barrier — `gc-phase1.ts:8–10`);
omitting it changes durable state by nothing but that un-bumped timestamp.

### 4.2 Idempotent receipt redemption

Receipts are verified only for `admitSet` refs not in `have`, unchanged. Re-running
charges 0 / grants no-ops. The standalone `redeemReceipts` path
(`workspace-sync.ts:625–685`) is untouched. Fewer refs reach receipt verification,
never more; a carried non-fenced ref never needs a receipt (it is already
entitled).

### 4.3 Account entitlement

Unchanged grant machinery. Carried non-fenced refs are already entitled and, by
§3.3(b), keep their `blob_refs` row; skipping their re-grant revokes nothing.

### 4.4 `blob_ref_candidates` regrant

By §3.3, a carried ref is never marked (head-reachable ⟹ `phase1Mark` skips it),
so `fence ∩ carried = ∅`. **Added** refs that happen to be marked are handled by
the unchanged folded `NOT EXISTS` inside `validateCommitRefs` → forced into
`newRefs` → `commitAccounting` clears the marker (`commit-accounting.ts:182`),
identical to today. A nonempty `fence ∩ carried` is an invariant violation →
fallback + page (§3.5B). The marker barrier is never silently bypassed.

### 4.5 Active `gc_candidates` deletion fences (RAISE-ABORT)

By §3.3(a) an active intent cannot exist against a carried ref (the `NOT EXISTS
blob_refs` guard on intent-open). **Added** refs traverse `commitAccounting`'s
fenced `blob_refs`/`blobs` inserts unchanged → `RAISE(ABORT,'rbox_delete_fence')`
→ caught super-batch → 422, exactly as today. No published head can reference a sha
with an open delete intent.

### 4.6 Retained history roots

The complete child sidecar remains the retained root: `resolveSidecarBytes` still
GETs and strictly validates the **full** child sidecar (needed to diff and to keep
the head's sidecar durable), and the CAS still persists the full `SignedCommit`
verbatim at `seq:<next>` **unchanged**. The delta removes O(N) *D1* work; it
removes **no** stored state and shortens **no** retained representation.

### 4.7 Design-96 root-index invariants

**This design does not feed the index, and does not need to.** The index
(`dropped_index`, `seq_roots`) is maintained solely by the crash-safe cursored
alarm folder (`foldSequence`), whose only input — the full child body at
`seq:<next>` — this design stores **unchanged**. Every design-96 invariant (I1
fail-closed, I2 exact union, I3 hot-path-preserved) is therefore untouched. Round
1 rightly rejected "equality-of-derivation" as an operational guarantee: the folder
independently re-reads R2, re-parses, and cursors partial updates, so it can
diverge *operationally* even where the ideal deltas match. We therefore make no
correctness claim that this path feeds the index. Two concrete, non-load-bearing
additions:

- **Divergence monitor:** compare the admission delta's `added/removed/carried`
  counts against the folder's eventual `dropped_index` deltas for the same
  sequence; a mismatch increments `commit.delta.index_divergence` for
  investigation (it is not a gate on admission).
- **Follow-on (out of scope, §8):** priming `foldPrevCache` with the just-parsed
  child refset, or persisting a canonical delta digest the folder verifies, is a
  pure-performance optimization to be designed separately with its own proof.

### 4.8 Bounded 422 recovery

Parent-refset-missing/corrupt is a **fallback trigger** (§3.5B), not a 422: the
commit admits via full chunked validation and either succeeds or 422s on genuine
misses. `needsUpload` responses are identical (§4.10). Fail-closed: an unreadable
parent yields more validation, never a skipped check.

### 4.9 Final atomic parent/epoch CAS — unchanged

`workspace-sync.ts:443–471` is byte-for-byte unchanged. The 409/epoch_stale/
conflict responses are byte-identical.

### 4.10 Response equivalence — precisely scoped

Because `newRefs_delta === newRefs_full` as an ordered list (§4.1),
`commitAccounting` runs on identical input → identical super-batch membership →
identical `rbox_delete_fence` `needsUpload` and identical `accounts_cap_guard`
over-cap `{used,cap}`. Therefore:

- **409 conflict / epoch_stale** — byte-identical (unchanged CAS).
- **402 over-cap** — byte-identical `{used,cap,reason}` (identical charge, identical
  batching).
- **422 needsUpload** — the same set of SHAs; identical array under the natural
  construction (both prepend the same carriers to the sorted added refs), asserted
  by a response-golden test. Where a test requires exact array equality, the
  `admitSet` ordering is fixed to match the full path's `[encManifestSha,
  sidecarSha, ...sorted refShas]` filtered to non-`have`.

The **only** conceivable `newRefs` divergence is a *carried* ref that is
unexpectedly not-present-or-not-entitled — precluded by §3.3(b), **detected by the
`unsatisfied_full ∩ carried = ∅` shadow assertion (§6)**, and caught by fallback
(§3.5B). We claim scoped **semantic equivalence** (identical outcome class +
identical `{used,cap}` + set-equal `needsUpload`), and byte-identical 409/epoch/402,
rather than a blanket "byte-identical everything."

---

## 5. Phase 0 — measurement (privacy-hard)

`serverTimings.accountingMs` already renders live. Add counters (**HARD RULE: no
raw file names or paths in any metric or log; SHAs are opaque hashes and are
fine**), and split the residual O(N) work (round 1 item 13):

- Delta sizes: `commit.delta.added`, `.removed`, `.carried`, `.carried_fenced`.
- D1: `commit.delta.admit_stmts` (statements issued by admission — the
  "proportional to delta" signal).
- Per-phase timings: `parentFetchMs`, `parentParseMs`, `childParseMs` (folded into
  existing `sidecarMs` today), `diffMs`, `fenceQueryMs`, and the D1 `admitAccount
  Ms` — so the ≤200ms D1 gate is separable from the residual O(N) parse/fetch.
- `commit.delta.fallback{reason}` — by trigger (§3.5); a bounded, low-cardinality
  reason label.
- High-severity: `commit.delta.parent_unreadable`, `commit.delta.fence_violation`
  (page — §3.5B).
- `commit.delta.divergence` (shadow, §6) and `commit.delta.index_divergence`
  (§4.7) — **bounded payload** (item 9): counts + a stable digest (sha256 of the
  sorted divergent SHAs) + ≤`DIVERGENCE_SAMPLE` (e.g. 16) sample SHAs. The same
  bound caps any logged `needsUpload`.

---

## 6. Shadow mode — one immutable pre-state, read-only comparison

Round 1 item 8: the naive "admitSet vs newRefs" compare is ill-typed and mutating.
Corrected protocol, run entirely from **one immutable pre-state** (no accounting
executed during comparison):

1. Run an **instrumented read-only classify** over the **full** child set (the
   `validateCommitRefs` have-set SELECT + receipt loop, but without the early
   `needsUpload` return), capturing the complete classification: `have_full`,
   `unsatisfied_full`, and `newRefs_full` (receipt-valid new refs, with sizes).
   (Plain `validateCommitRefs` early-returns `needsUpload` and never yields
   `newRefs` when anything is unsatisfied — round 2 item 2 — so shadow needs this
   full-classify variant.)
2. Compute the delta path's read-only products from the **same** pre-state:
   `added`/`carried` (from the diff), `admitSet`, then the same instrumented
   classify over `admitSet` → `have_delta`, `unsatisfied_delta`, `newRefs_delta`.
3. **Compare (all four must hold, else `commit.delta.divergence++`):**
   - **`unsatisfied_full ∩ carried = ∅`** — the primary safety detector: a carried
     ref the full path deems unsatisfiable (missing/unpresent/marked/intented) is
     exactly the divergence that would let the delta path publish a dangling ref.
     This directly closes round 2 item 2 (carried refs are outside `admitSet`, so
     the old subset-compare was blind to them).
   - **`have_full ⊇ carried ∖ fence`** — every non-fenced carried ref is entitled
     +present in the full classification (the §4.1 identity's precondition).
   - **`newRefs_delta == newRefs_full`** (SHA set + per-sha size).
   - **`unsatisfied_delta == unsatisfied_full ∩ admitSet`**.
4. Only **after** comparison, execute accounting **once** (the authoritative full
   result in shadow; the delta result in enforce) — quota/entitlement mutate exactly
   once, never twice.

**Blind spots called out:** fence-abort and multi-super-batch over-cap outcomes
are **not** observable read-only (they depend on executing the fenced/guarded
batch). Their equivalence is proven **not** by shadow mode but by the deterministic
injected-race rig and the property tests (§7 gates R, 5) — shadow mode explicitly
does not claim to cover them. The **divergence gate**: `commit.delta.divergence`
and `commit.delta.index_divergence` read **zero** over the §7 soak before the flag
flips to enforce.

---

## 7. Falsifiable gates

Corpora: Workload A at **112k** and a **250k** worst-case (audit §Workload A),
plus a delta-size matrix of `added ∈ {0, 1, 10, 100, 1k, 10k}`. Statistics: 10
warm + 5 cold per cell; report p50/p95/p99 + raw counts (audit §Statistical
discipline).

1. **Total commit POST p50 ≤ 2s** on Workload A one-file change (from ~8s). The
   headline audit gate. Reported alongside the per-phase split so the residual O(N)
   parse/fetch is visible, not hidden.
2. **D1 accounting sub-phase O(added).** `admitAccountMs` ≤ **200ms** for `added ≤
   1`; and across the matrix, a linear fit of `admitAccountMs` and
   `commit.delta.admit_stmts` vs **workspace size** (at fixed `added`) has slope
   **not distinguishable from zero** (95% CI includes 0). `admit_stmts` ≤
   `5·ceil((added + 2)/33) + SELECTS_PER_BATCH·ceil((added+2)/90)` + a small
   constant — i.e. no workspace term.
3. **Total server admission** (`sidecarMs + diffMs + fenceQueryMs +
   admitAccountMs`) at 112k and 250k is reported; its residual is attributed to
   parse/fetch (the wire-delta follow-on's target), not D1.
4. **Peak-heap rig gate** (the §3.2 simultaneous-allocation model). At 250k disjoint
   parent/child, with max receipts, the fully-disjoint `added` list materialized,
   fallback exercised, shadow comparison on, **and a concurrent alarm fold active in
   the same isolate** (its two `Set`s live), measured peak heap < a fixed budget
   (proposed **110 MiB**, matching design 96 §4.2's rig) — else the pre-authorized
   paired-cap contingency (lower `FOLD_MAX_REFS`/`MAX_REFS_PER_COMMIT`) applies.
5. **Race suites pass unchanged.** The design-95/96 fence + race rigs, the
   quota/over-cap suite, and the E2EE-determinism suite.
6. **Response goldens.** 409 / epoch_stale / 402 byte-identical; 422 `needsUpload`
   set-equal (array-equal under the fixed ordering) — delta vs full, asserted by
   test.
7. **Zero divergence** — `commit.delta.divergence` and `.index_divergence` = 0 over
   the soak (§6), denominator ≥ **N_SOAK** commits (proposed 5,000 across dev+fleet)
   and ≥ **T_SOAK** (proposed 72h), covering the delta-size matrix and ≥1 each of a
   clean change, an added-ref-under-marker regrant, a quota-boundary charge, and a
   concurrent-GC window.
8. **Fallback ceilings.** In enforce, `commit.delta.fallback{reason≠first_commit,
   epoch_rotation}` rate below a fixed ceiling (proposed 0.1%); any
   `parent_unreadable`/`fence_violation` pages regardless of rate.
9. **Gate R — deterministic race rig (round 1 item 15, round 2 item 1).** A
   single-isolate interleaving harness over: parent read, fence snapshot,
   `phase1Mark`, global `gcMark`, P1 intent-open, P2 activity-unwind, P3 physical
   delete, delta accounting, final CAS, index fold, prune, **and an
   account-deletion transition** (`account-delete` step 2 dropping `blob_refs`
   concurrent with a commit → asserts the account-deletion fallback, §3.5A item 5,
   engages and admission ≡ full). For **every** interleaving, assert: (i)
   intent-open against a carried (live-`blob_refs`) sha is **rejected** by the `NOT
   EXISTS` guard — never reaching a physical delete; (ii) a published retained root
   of a live account is present and entitled; (iii) incomplete roots disable GC
   (fail-closed); (iv) `used_bytes` equals authoritative newly-entitled bytes; (v)
   the roots index equals brute-force retained history.

Any gate failing falsifies the design as scoped; none is a promise.

---

## 8. Out of scope

- **Manifest snapshot compression / O(change) manifest deltas** — design 84
  (C1/C2/D). Server admission vs client bytes; necessary-but-not-sufficient both
  ways (audit Finding 4).
- **Refset-delta wire representation** (client sends only the change; server never
  parses two full sidecars) — the audit's "later refset delta representation." This
  v1 still parses both complete sidecars (O(N) Worker CPU/R2), removing only the
  O(N) **D1** work (the measured ~6s pole). The wire-delta removes the residual
  parse/fetch measured by §7 gate 3.
- **Client preflight + early stale/epoch rejection** — design 103 (sibling). §9.
- **Feeding / priming the design-96 index from the admission delta** — a
  performance follow-on (§4.7), not part of this design's correctness.

---

## 9. Composition with design 103

```
parse envelope
  → [103] cheap preflight: read head; parent≠head → 409, epoch≠current → 409
  → resolveSidecarBytes (child)          ← [102] begins
  → delta admission (this design)
  → final atomic CAS (unchanged authority for both)
```

103 is a fast-reject; 102 a fast-admit. They touch disjoint code and share the
unchanged CAS as the single authority. On a known-stale commit 103 returns before
102 does any R2/D1 work; on a clean commit 103 is a no-op and 102 runs. Neither
weakens the other.

---

## 10. Rollout

Flag-gated by worker env var `RBOX_COMMIT_DELTA_ADMISSION ∈ {off, shadow,
enforce}`, read per request. **No D1 migration** — pure code + env var, so the
auto-apply-migrations Workers-Builds hook (`docs/DEPLOYMENTS.md`) is not engaged
and rollback is a var flip, not a redeploy.

1. **Dev worker first** (`rbox-dev-api`, DEPLOYMENTS dev-first): deploy `off`, then
   `shadow`. Run Workload A (112k + 250k), the delta-size matrix, and dev-fleet
   traffic.
2. **Soak in shadow** until §7 gate 7 (zero divergence) holds over `N_SOAK`/
   `T_SOAK`.
3. **Flip dev to `enforce`**; confirm §7 gates 1–6, 8, 9 on dev. Soak.
4. **Prod**: merge to `main` (auto-deploys) with the var **defaulting `off`**; flip
   prod `shadow`, soak with the divergence gate on prod traffic, then `enforce`.
   The full-validation path stays in code as the permanent fallback (§3.5) after
   `enforce`.

---

## 11. Open questions for the founder

1. **Soak thresholds.** §7 proposes `N_SOAK`=5,000 commits, `T_SOAK`=72h, fallback
   ceiling 0.1%, heap budget 110 MiB. Confirm or set the enforcement criteria (they
   are the flip preconditions).
2. **Parent-unreadable posture.** §3.5B falls back + pages but still admits the new
   commit atop an unreadable retained head (refusing would wedge the workspace,
   GC/prune already fail-closed). Acceptable, or should a corrupt retained head
   hard-reject new commits with a retryable integrity error until repaired?
3. **`FENCE_SET_MAX` / `FOLD_MAX_REFS` interplay.** Fence-probe cap vs a paginated
   probe; and whether the 250k `MAX_REFS_PER_COMMIT` cap should drop if the §7 gate
   4 heap budget is not met.
