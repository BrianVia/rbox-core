# 103 — Steady-sync quick wins: early stale rejection + change-only preflight

Status: ✅ ALIGNED v3, 2026-07-11 — 3 adversarial rounds (REVIEW-103.md),
codex (gpt-5.6-sol) round-3 verdict ALIGNED with zero items.
v3 folded round-2 items 1–6:
v3: (1) the early preflight is placed AFTER the cheap declared-count 413 checks
(terminal structural rejections keep precedence over 409; the I/O-derived
outcome re-ordering — bad_sidecar/422 now discovered post-pull on a stale
commit — is specified as an intentional, tested change); (2) the recovery
accumulator's real bound is `missingTotal ≤ MAX_REFS_PER_COMMIT` (decreasing
pages are budget-free), with a cardinality cap + full-audit fallback;
(3) the carried-loss detection claim is corrected: a zero-change push no-ops
before `encryptAndUpload` in BOTH modes — detection requires a push that
actually commits, and the acceptance scenario pairs the lost carried ref with
a real change; (4) the fence rig gate enumerates its assertions (head never
advances, budget consumption, post-fence fresh bytes, mixed
repairable+fenced page); (5) the epoch rotation test specifies the
route-pause seam; (6) the telemetry gate splits into a client-classification
assertion and a server metric-capture assertion.
v2: (1) the 422-recovery SHA threading is specified as a NEW field on the
`reupload` action (the current action carries only `unsatisfiedTotal`, not the
list — v1 claimed otherwise); (2) the carried-ref fence story is a full state
machine including the open-fence 503/`retry_later` path and the
`isDeleteFenceAbort` accounting abort, with the honest outcome (a push cannot
succeed while a referenced ref is actively fenced — identical flag-on/off);
(3) 422 paging (`MAX_MISSING_SHAS_RESPONSE = 10_000`) and the existing
progress-based attempt budget are named, and the "one extra round-trip" claim
is scoped to the single-ref case; (4) the epoch claim is softened to
"preserves the existing best-effort epoch snapshot semantics" with a
both-orderings rotation test; (5) "byte-identical" replaced by the structural
response contract, tested through `commitSigned` + the `sync.ts` branches, with
conflict-before-epoch precedence pinned; (6) an explicit `earlyReject` metric
detail replaces the zeros-as-proof gate; (7) gates get sample sizes, baselines,
and tolerances, and the suites are named; (8) the Part B complexity gate counts
unique introduced addresses post-defer, with per-class counters; (9) the
resumed-upload residue class is REMOVED (proven redundant: an interrupted push
never advanced the base, so its files are still non-carried); (10) the
`/blobs/check` cap gets an explicit client-first rollout order (today's full
check already flirts with the 8MB body cap); (11) the design-102 boundary is a
hard dependency statement, not advice.

Two bounded, independent, individually shippable steady-sync improvements drawn
from the 2026-07-10 sync-performance audit (Findings 2 and 3):

- **Part A (server):** a cheap parent/epoch preflight in the commit Durable
  Object, so a commit that is *already* stale when it reaches the DO returns
  without paying sidecar resolution + ref accounting.
- **Part B (client):** compute the blob-presence preflight (`missingBlobs`) from
  the files introduced since the last synced manifest, instead of every one of
  the ~114k ciphertext addresses in the workspace.

Each part sits behind its own flag and can ship, roll back, and be measured on
its own. Neither depends on the other.

**Not in this design (see Out of scope):** O(change) *commit admission* — the
server-side parent→child ref-delta that would stop `validateCommitRefs`/
`commitAccounting` validating every ref on every commit — is **design 102**, a
sibling being drafted in parallel. Part B is the *client* preflight only; it
does not narrow what the server validates.

## Motivation (measured evidence)

Cross-host propagation latency is a core product experience. Fresh fleet soak
(2026-07-11, 1.0.0-dev+16fea15, ~114k-blob workspace, pushes with **zero**
changed files):

| Phase | Wall |
|---|---:|
| Total push | 19–22s |
| `missing` preflight | 2.8–4.0s |
| `commit` (client-observed) | 11.8–14.5s (POST wall `p` = 7.7–10.3s) |

The design-97 server timings are now rendering live in prod and decompose that
POST. A zero-file push on the same ~114k-blob workspace measured:

| serverTimings field | Wall |
|---|---:|
| client POST `p` | 7.9s |
| server `totalMs` | 6.8s |
| `accountingMs` (D1 ref admission) | **5.8s** |
| `sidecarMs` | 0.8s |
| `mirrorMs` | 0.2s |
| `envelopeMs` / `commitMs` / `responseMs` | ≈0 |

Two structural wastes are visible in those numbers:

1. **A conflicted commit pays the full admission cost before it discovers it is
   stale.** The parent/epoch check lives only in the final `transactionSync`
   (`apps/api/src/workspace-sync.ts:443–478`), *after* `resolveSidecarBytes`,
   `validateCommitRefs`, and `commitAccounting`. The prod decomposition above
   shows that ordering costs a stale commit **~6.6s of server work
   (`accountingMs` 5.8s + `sidecarMs` 0.8s) before the parent check runs**.
   Design-84 samples measured conflict retries adding **12–42s** end to end —
   the loser of a race did the entire ~112k-ref admission and then threw it
   away on a 409.

2. **Every ordinary push re-verifies the whole workspace's blob presence.** The
   client builds `encShas` from *all* files (`src/cli/sync-recovery.ts:256`) and
   POSTs the full ~114k-address set to `/v1/blobs/check`. That is the measured
   2.8–4.0s `missing` phase — paid even when the change is one file (or zero).

Audit success targets these map to (`docs/audits/2026-07-10-sync-performance-audit.md:1303–1318`):

- known-stale commit response **p50 ≤ 1s**;
- ordinary missing preflight **p50 < 500ms and O(changed refs)**.

Both are cheap, high-confidence, and independent of the larger O(change)
admission and manifest-delta work.

## Design

### Part A — early stale-parent / epoch rejection (server)

**Where.** `WorkspaceSync.commit` in `apps/api/src/workspace-sync.ts`. The
envelope is fully parsed and validated by line 341 (`serverTimings.envelopeMs`
is stamped there); `readRefMode(cb)` at line 335 has already told us the commit's
declared ref count without any R2 fetch. **The preflight runs in each branch
immediately before its first expensive (I/O) operation, and AFTER every cheap
structural validation** (v3; round-2 item 1):

- receipts + sidecar branch: after the `accountedCount > MAX_REFS_PER_COMMIT`
  → 413 check (`workspace-sync.ts:376–380`, pure arithmetic on `mode`), before
  `resolveSidecarBytes`;
- receipts + inline branch: after its 413 backstop (`:397–402`), before
  `validateCommitRefs`;
- legacy branch: after the envelope (it has no count cap today; none is added),
  before its `missingBlobs` D1 pass.

**Precedence is deliberate and split in two (v3):**

- *Terminal structural rejections keep precedence over 409.* 400 bad-envelope/
  type/seq and 413 `too_many_refs`/`body_too_large` are client bugs surfaced as
  a thrown `CommitRejectedError` (`commits.ts:217–221`); if the early 409 fired
  first, the client's pull-first loop would mask a permanent defect and
  exhaust `MAX_ATTEMPTS` with a useless "too many conflicts" error instead of
  the actionable one. A stale AND oversized commit therefore still returns
  **413**, flag-on and flag-off alike — tested explicitly.
- *I/O-derived outcomes are intentionally re-ordered after staleness.* Today a
  stale commit with a bad/absent sidecar or unsatisfied refs reports 400
  `bad_sidecar` / 422 first (admission runs before the CAS); with the flag on
  it reports **409 first**, and the post-pull retry — now on a fresh parent —
  rediscovers the 400/422 if it still holds. This is not "zero behavioral
  diff"; it is the point of the change, and it is strictly better ordered (a
  422's re-upload work on a stale parent is wasted — the commit must be rebuilt
  after the pull anyway). Convergence is unchanged: the same terminal outcome
  is reached, one pull earlier. Acceptance pins both: stale+oversized → 413;
  stale+bad-sidecar and stale+unsatisfied-carrier → 409 then (post-pull, still
  bad) 400/422.

**What.** A synchronous read of the authoritative head and watermark (the same
`this.ctx.storage.kv.get("head")` the final transaction reads), reusing the
existing helpers:

```ts
// AFTER envelope parse + the branch's cheap 413 count checks,
// BEFORE the branch's first I/O (sidecar fetch / D1 validation).
if (earlyRejectEnabled(this.env)) {
  const head = readHead(this.ctx.storage.kv.get("head"));
  const watermark = (this.ctx.storage.kv.get("headWatermark") as number | undefined) ?? head.sequence;
  const declaredRefs = mode.kind === "sidecar" ? mode.count : mode.refShas.length;

  // Order matters and mirrors the transaction: parent first, then epoch —
  // a commit that is BOTH stale-parent and stale-epoch reports `conflict`,
  // pinning today's precedence (workspace-sync.ts:448 before :456).
  if (parent !== head.sequence) {
    // Same equivocation signal the transaction path emits (audit Finding 2).
    const sameSeqHash = commitSeq <= watermark ? this.hashForSeq(commitSeq) : undefined;
    if (sameSeqHash && sameSeqHash !== commit.commitHash) metric(this.env, "same_sequence_different_hash");
    return timedResponse({ error: "conflict", head: head.sequence }, 409, "conflict",
      (o) => emit(declaredRefs)(o, { earlyReject: 1 }));
  }
  if (commitEpoch !== currentEpoch) {
    return timedResponse({ error: "epoch_stale", currentEpoch }, 409, "epoch_stale",
      (o) => emit(declaredRefs)(o, { earlyReject: 1 }));
  }
}
// ... unchanged: resolve sidecar, validate, account, then the final transactionSync.
```

Notes tying this to the existing code:

- **The response contract is structural, and identical to today's
  transaction-path 409s.** Conflict → status 409, `error: "conflict"`, numeric
  `head`; epoch-stale → status 409, `error: "epoch_stale"`, numeric
  `currentEpoch`; both carry a parseable design-97 `serverTimings` object via
  the existing `timedResponse` helper. (Not "byte-identical" — the timing
  *values* necessarily differ; no field is added to or removed from the JSON
  body, and nothing the client parser reads changes.) The client parser
  (`src/cli/remote/commits.ts:207–212`) and the `sync.ts` retry branches
  (`pull-first` at 722–725, `epoch-stale` at 719–721) are untouched; the
  acceptance tests exercise both early-reject variants **through `commitSigned`
  and those branches**, not just against raw JSON.
- **Precedence pinned.** The early path checks parent before epoch, the same
  order as the transaction, so a doubly-stale commit classifies as `conflict`
  under both paths. An acceptance test submits a commit that is both
  stale-parent and stale-epoch and asserts `conflict` with the flag on and off.
- **The equivocation metric is preserved.** The transaction path emits
  `same_sequence_different_hash` when a same-sequence commit arrives with a
  different hash (`workspace-sync.ts:449–450, 481`). The early conflict path
  recomputes the identical predicate (`commitSeq <= watermark ? hashForSeq(commitSeq)`)
  and emits the same metric before returning.
- **The early branch is explicitly identified in telemetry.** The commit
  `OpSpan` metric gains one numeric detail, `earlyReject: 1`, present only when
  the early return fired (absent → transaction-path outcome). This is the gate's
  identifying signal — near-zero `sidecarMs`/`accountingMs` alone is *not* proof
  the branch ran (millisecond timer resolution can produce zeros legitimately).
  Low-cardinality, numbers-only, no identifiers.
- **The count metric is preserved without a sidecar fetch.** `emit(count)`
  currently uses `shas.length` (post-resolution). The early path has no resolved
  sidecar, so it attributes the commit's *declared* ref count from `mode`
  (`mode.count` / `mode.refShas.length`) — cheap, no R2, still a real
  refs-per-commit signal.
- **The final in-transaction check is unchanged and remains authoritative.**
  There are `await`s between the early read and the transaction (sidecar +
  accounting), so the head can advance under us. The early read is a
  *best-effort fast path*, never a replacement; the `transactionSync` at line
  445 keeps the full parent/epoch/watermark CAS. A commit that passes the early
  check but loses the later race still 409s correctly through the existing path.
- **The early check rejects only what the transaction would reject.** It
  returns early *only* on `parent !== head.sequence` or
  `commitEpoch !== currentEpoch` — the same predicates the CAS applies. The
  watermark-gap branch (`commitSeq !== watermark + 1`, line 460) is **not**
  replicated early — if parent matches head but the watermark condition would
  fail, the request proceeds to the full path and is rejected there as today.
  The early path can never accept something the transaction would reject, nor
  reject on a predicate the transaction lacks; what changes is only the
  *ordering* against I/O-derived outcomes, per the precedence rules above.
- **Epoch semantics: unchanged best-effort snapshot, not a new guarantee.**
  `currentEpoch` is the value the Worker read from D1 and forwarded in
  `x-rbox-account-epoch` (`apps/api/src/routes/sync.ts:42`); both the early
  check and the final transaction compare the commit's `accountEpoch` against
  that *same* forwarded snapshot. Part A therefore **preserves the existing
  best-effort epoch precondition exactly** — including its existing window: the
  account epoch can rotate after the Worker's read and before the DO advances
  the head, today and after this change alike (the comment at
  `workspace-sync.ts:453–455` documents this; the client's roster/epoch check
  is the authority). No claim of atomic revalidation is made. Acceptance adds a
  controlled-rotation test in both orderings, **at the Worker seam** (v3;
  round-2 item 5 — a direct DO test with a chosen header cannot validate the
  Worker-read ordering): (a) rotate D1 *before* the route's epoch query →
  early `epoch_stale` (flag on) / transaction `epoch_stale` (flag off);
  (b) pause the route after its epoch query (test hook around
  `routes/sync.ts:42`), rotate D1 during the pause, release the DO request →
  assert the forwarded header still carries the pre-rotation epoch and the
  commit *decision* is identical flag-on/off (proceeds under the snapshot).

**Effect.** A request already stale on arrival avoids `resolveSidecarBytes` (R2
fetch + parse), `validateCommitRefs` (batched D1 SELECTs), and
`commitAccounting` (batched D1 writes) — the measured ~6.6s of pre-CAS server
work on the ~114k workspace. It does not change uncontested clean commits at
all: those never take the early return, and the added cost is two synchronous
KV reads.

### Part B — change-only blob-presence preflight (client)

**Where.** `encryptAndUpload` in `src/cli/sync-recovery.ts`. It already receives
`base` (`= appliedBase = state.lastSyncedManifest`, `src/cli/sync.ts:570, 668`),
already splits `local.files` into **carried** (plaintext sha present in
`baseEnc`, ciphertext descriptor reused verbatim, `sync-recovery.ts:177–190`)
and **`toEncrypt`** (new/changed). Today it then *ignores that split* for the
presence check and rebuilds `encShas` from **all** files at line 256.

**What.** Build the preflight candidate set from the introduced/at-risk
addresses only:

```ts
// Replaces the all-files encShas build at sync-recovery.ts:256.
const candidate = new Set<string>();

// (1) NEW / CHANGED — exactly the non-carried set, now carrying fresh (or
//     cache-hit) ciphertext addresses after the encrypt phase above.
//     Deferred paths have no fresh descriptor and are excluded (they are
//     dropped from or base-carried in the committed manifest anyway).
for (const f of toEncrypt) if (f.encSha && !deferred.has(f.path)) candidate.add(f.encSha);

// (2) POST-422 RECOVERY — addresses the server reported unsatisfied on a prior
//     attempt of THIS push loop (threaded down via the reupload action; see
//     "Recovery threading" — this is a NEW field, it does not exist today).
for (const sha of options.recoverAddresses ?? []) candidate.add(sha);

const encShas = fullAuditRequested(cfg)
  ? local.files.filter((f) => f.type === "file" && f.encSha).map((f) => f.encSha!)  // fallback
  : [...candidate];
```

**Exactly which refs stay in the preflight, and why:**

| Class | Source | Why it must be checked |
|---|---|---|
| New / changed | `toEncrypt` (non-carried), fresh `encSha`, not deferred | May not exist server-side yet — the whole reason to preflight. |
| Post-422 recovery | server-reported `missing` page(s) from prior 422s this loop | Server just told us these are unsatisfied; must re-PUT them. |

**Resumed-upload residue is deliberately NOT a class** (v2; round-1 item 9).
An interrupted prior push never advanced the base (`lastSyncedManifest` moves
only on a completed pull/commit cycle), so any file whose upload didn't finish
still has no matching `sha256 → encSha` entry in `baseEnc` — it lands in
`toEncrypt` (class 1). If it re-encrypts to the same address and that address
is reported missing, `putBlobFile` resumes the multipart from the existing
`.rbox/state/uploads` state exactly as today (`sync-recovery.ts:262, 341`);
if the file changed again, the stale state is dead weight the existing upload
expiry already owns. No enumeration of upload-state files into SHAs is needed,
so no new abstraction over that state format is introduced. The edge case
"file changed → upload interrupted → file reverted to base content" makes the
file carried again — and the half-uploaded orphan blob is then *unreferenced by
this commit*, so its absence cannot cause a 422.

**What is deliberately dropped — carried (unchanged) refs — and what protects
them:**

A **carried** file is one whose plaintext sha256 is present in the last synced
manifest with a ciphertext descriptor, which `encryptAndUpload` reuses *verbatim*
(`applyCipherDescriptor(f, reuse)`). Its `encSha` was committed at the base
sequence — meaning it was, at that point, entitled + canonical-present. Today
the full preflight re-checks all of them; Part B stops doing so.

The safety net is the **server commit admission, which is unchanged and
validates every ref in the commit — carried and new alike.** For a
receipts-mode (sidecar) commit, `WorkspaceSync.commit` resolves the *complete*
refset and calls `validateCommitRefs(env, db, accountId, shas, receipts, nowMs)`
over all of it (`workspace-sync.ts:392–410`, `commit-accounting.ts:61–110`).
That query is the identical predicate the preflight uses:

```sql
SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
 WHERE r.account_id = ? AND b.present = 1 AND r.sha256 IN (...)
   AND NOT EXISTS (blob_ref_candidates c ...)          -- §33 prune-marker barrier
   AND NOT EXISTS (gc_candidates g WHERE g.deleting_at IS NOT NULL)  -- GC fence
```

**Carried-ref repair state machine (detection AND repair, per fence state).**
A carried ref can be in one of three bad states when the commit admits it; the
outcomes below are *identical with the flag on or off* — the only difference is
that flag-off would also have surfaced the ref in the preflight, one phase
earlier:

1. **Prune-marked (`blob_ref_candidates`, design 33) or lost (`present=0`)
   with NO open fence.** `validateCommitRefs` reports it → **422** → client
   reupload → PUT succeeds, mints a receipt → next commit's
   `commitAccounting` re-grants entitlement, un-condemns
   (`DELETE FROM gc_candidates WHERE deleting_at IS NULL`), and clears the
   prune marker (`DELETE FROM blob_ref_candidates`,
   `commit-accounting.ts:176–182`) → head advances. Converges in one extra
   round-trip for a single ref.
2. **Actively delete-fenced (`gc_candidates.deleting_at IS NOT NULL`,
   design 95).** `validateCommitRefs` reports it → **422** → client re-PUT →
   the fence-aware upload path **refuses to mint** and returns
   `503 retry_later` (`blobs.ts:229–230`) → `BlobRetryLaterError` → the file
   defers (`sync-recovery.ts:354–359`) — but `deferManifest` carries the *base
   entry*, which still references the fenced address, so the retried commit
   422s again. The attempt budget (below) bounds this; the push **fails this
   cycle and the daemon retries after the fence resolves** (P2 delete →
   verify → fence drop → the re-PUT lands fresh bytes, mints, re-grants).
   This is design-95's intended semantics — *no publication authority spans a
   delete* — and it is exactly what happens today with the full preflight
   (which also cannot mint through an open fence). Part B changes discovery
   timing, not the outcome.
3. **Fence race inside accounting (`isDeleteFenceAbort`).** If P1 raises the
   fence *between* `validateCommitRefs` and `commitAccounting`'s batch, the
   trigger aborts that super-batch and the server returns **422** for its shas
   (`commit-accounting.ts:190–192`) → same client path as state 2.

The acceptance rig must cover all three states end to end with the flag on.
"Same terminal state as flag-off" alone is too weak to catch retry-path
regressions (v3; round-2 item 4), so the state-2 (open fence) rig asserts each
step: the fenced address **remains referenced** by every retried commit (the
base-entry carry is intact); the **head never advances** while the fence is
open; every unchanged-total 422 **consumes the attempt budget**; the cycle
**terminates after the documented `MAX_ATTEMPTS`** with the reupload-exhausted
error; and the post-fence retry **uploads fresh bytes and mints a receipt
before the head advances**. A **mixed-page scenario** (one page containing both
repairable and fenced refs) is included: the repairable subset shrinks
`missingTotal` (free retries) while the fenced residue eventually holds the
total constant — the rig asserts the budget starts being consumed exactly then,
so decreasing totals cannot grant unbounded free retries in front of a fence.

**Therefore Part B is a pure client-side upload optimizer, not an authority.**
Its only possible failure mode is *skipping a PUT it should have made* for a
carried ref that silently went bad. For a single such ref the cost is one extra
422 round-trip (state 1); for many refs or an open fence, convergence is
governed by the paging and attempt budget below — in every case terminating in
the same state as flag-off. It can never publish a head referencing an
absent/fenced blob, because the server admission — not the client preflight —
gates the head advance.

**Recovery threading (NEW plumbing, required for correctness).** The current
`reupload` action does **not** carry the unsatisfied SHA list — it is
`{ kind: "reupload"; forceGitRecapture; localForRetry; unsatisfiedTotal? }`
(`sync.ts:464`); the list is consumed only to derive `gitForce` and then
dropped (`sync.ts:732–737`). Under today's full preflight that is fine (the
retry re-discovers the missing refs by checking everything); under Part B the
narrowed retry would compute an *empty* candidate set and re-produce the same
422 forever. So Part B adds:

- `unsatisfiedBlobs: string[]` on the `reupload` action (the server's reported
  page, ≤ `MAX_MISSING_SHAS_RESPONSE`);
- an accumulator in the `pushManifest` retry loop: each retry's
  `recoverAddresses` is the **union of all pages reported so far this push
  loop**, reset when the loop exits. **Real bound (v3; round-2 item 2):**
  decreasing-total retries are budget-free (`sync.ts:515–520`), so the union is
  NOT bounded by `MAX_ATTEMPTS`·page — it is bounded by the total unsatisfied
  set, i.e. `missingTotal ≤ MAX_REFS_PER_COMMIT` (250k shas ≈ 17MB of strings,
  up to 25 free decreasing pages). That transient worst case is tolerable but
  not free, so the accumulator carries an explicit cardinality cap
  `RECOVER_ACCUM_MAX = 100_000`; exceeding it flips the remainder of this push
  loop to the chunked full-audit preflight (which needs no recovery set to
  converge). A unit test asserts the cap triggers the fallback;
- `recoverAddresses` on `EncryptAndUploadOptions`, consumed as class 2.

**When carried-ref loss is detected at all (v3; round-2 item 3).** A push with
*zero* changes (files AND git identity match the applied base) short-circuits
at the no-op check (`sync.ts:610–654`) **before `encryptAndUpload` and before
any commit** — in BOTH flag states. Neither today's full preflight nor Part B's
narrowed one ever runs on such a push, so a lost/fenced carried ref is *not*
proactively detected by an idle workspace in either mode (flag-on == flag-off;
no regression, but also no repair). Detection happens on the next push that
actually commits — that commit's full-refset admission reports the bad carried
ref. The acceptance scenario is therefore: **one changed file + one carried ref
lost server-side** → commit 422 lists the carried address → the flag-on retry's
candidate set contains it (via `recoverAddresses`) → converges. Proactive
detection on an unchanged workspace remains what it is today: `rbox sync
--verify` (the full audit).

**422 paging and convergence (v2; round-1 item 3).** The server caps each 422
at `MAX_MISSING_SHAS_RESPONSE = 10_000` shas plus a true `missingTotal`
(`commit-envelope.ts:28–35`). The existing retry budget already handles paging:
a `reupload` retry consumes **no attempt** while `unsatisfiedTotal` strictly
decreases (`sync.ts:515–520`), so a K-page recovery makes monotonic progress —
each retry re-uploads the reported page, the next 422 reports the next page
with a smaller total — and only stalls (an unchanged total, e.g. an open fence)
consume the `MAX_ATTEMPTS = 5` budget. Part B keeps this loop untouched; the
accumulator above merely ensures every already-reported page stays in the
retry's preflight set. The "one extra 422 round-trip" claim is therefore scoped
to a single bad carried ref; multi-ref and fence cases converge (or
deliberately fail-this-cycle) under the same bounds as flag-off.

**Git artifacts are not part of this preflight** (the `encShas` build is
`local.files`-only; git bundles have their own `planGitSections` upload + the
`forceGitRecapture` 422 path, `sync.ts:726–732`), so Part B does not touch git
recovery.

**Full-audit fallback (kept available, and chunked).** A full-workspace check
remains for genesis/first publish, disaster recovery, remote-loss repair, and
explicit `rbox sync --verify`. It is selected by `fullAuditRequested(cfg)`
above and, because it can be ~114k addresses, **must chunk**: split the address
set into batches of ≤ `MAX_SHAS_PER_CHECK` (proposed 50k) and call
`missingBlobs` per batch, unioning the results. The narrowed normal path sends
one small request; only the fallback chunks.

**Server body cap — a real API change with a client-first rollout (v2;
round-1 item 10).** `blobsCheck` (`apps/api/src/blobs.ts:119–124`) reads the
body with an **uncapped** `req.json()`. Today's full-workspace check on the
~114k workspace already sends a ~7.9MB body — within sight of
`MAX_REQUEST_BODY` (8MB). Capping is therefore NOT behaviorally inert for
existing clients and must roll out in order:

1. **Client first:** ship the chunked fallback (and Part B's narrowing) to the
   fleet; after this, no client sends > `MAX_SHAS_PER_CHECK` addresses in one
   request.
2. **Server second, after fleet upgrade is confirmed** (single-account fleet;
   `rbox --version` per host): `blobsCheck` reads via
   `readBodyCapped(req, BLOBS_CHECK_MAX_BODY)` (a dedicated constant sized for
   `MAX_SHAS_PER_CHECK` shas + JSON overhead, ~4MB at 50k) and rejects
   > `MAX_SHAS_PER_CHECK` addresses with `413 too_many_shas`.
3. **Client 413 handling:** a post-cap client never triggers it; `missingBlobs`
   maps an unexpected 413 to a fatal, actionable error ("upgrade rbox / reduce
   check size"), never a silent empty-missing result. Tests cover both limits
   (byte cap → abort, count cap → 413) and the in-range path unchanged.

**Effect.** On a one-file change the preflight sends the file's unique
introduced address(es) instead of ~114k; on a push with zero file changes that
still commits (e.g. a git-identity-only change — the measured soak pushes are
this shape; a *fully* unchanged push no-ops before the preflight in both
modes) it sends 0 and the phase collapses to nothing (the existing
`shas.length === 0` early return in `missingBlobs`, `context.ts:75`, means no
request at all). `toUpload`
(`sync-recovery.ts:269`) is unchanged in form — it still filters `local.files`
by `missing.has(f.encSha)`; carried files are absent from `missing` and so are
not uploaded, which is correct because their ciphertext is already durable at
the base sequence.

## Correctness requirements

Both parts must preserve, and the test plan must prove:

1. **409 retry loop unchanged.** Early-reject 409s satisfy the structural
   contract (status 409; `error` ∈ {`conflict`, `epoch_stale`}; `head` /
   `currentEpoch`; parseable `serverTimings`) and are exercised through
   `commitSigned` (`commits.ts:207–212`) and the `sync.ts` `pull-first` /
   `epoch-stale` branches, asserting the same actions as flag-off. Doubly-stale
   input classifies `conflict` (precedence pinned).
2. **Equivocation detection unchanged.** `same_sequence_different_hash` fires on
   the early conflict path under the same predicate as the transaction path.
3. **Final CAS remains authoritative.** The `transactionSync` parent/epoch/
   watermark check is untouched; the early check is additive and best-effort.
4. **422 recovery unchanged in outcome.** The `reupload` action gains the
   reported SHA page; the push loop accumulates pages into `recoverAddresses`;
   multi-page recovery converges under the existing progress-based attempt
   budget, flag-on == flag-off. The one-changed-file + lost-carried-ref
   scenario is explicitly tested (zero-change pushes no-op before the preflight
   in both modes and detect nothing — see the Part B detection note).
5. **GC fence / regrant safety for carried refs.** The three-state machine
   above (prune-marked/lost → one-round-trip repair; open fence → bounded fail
   + post-fence convergence; `isDeleteFenceAbort` mid-accounting → 422 → same
   path) is covered by rig tests with the flag on, asserting terminal states
   identical to flag-off. The client preflight narrowing cannot bypass any of
   it because it does not gate the head advance.
6. **Epoch rotation mid-push.** Part A preserves the existing best-effort epoch
   snapshot semantics exactly (same forwarded header value compared in both
   places; the pre-existing Worker-read→DO-commit rotation window is neither
   widened nor narrowed). Controlled-rotation tests cover both orderings.
7. **Receipt semantics unchanged.** Part A short-circuits *before* receipt
   validation/accounting — a rejected stale commit does no accounting. Part B
   does not touch receipts; `redeemReceipts` idempotence is untouched.
8. **Privacy.** No raw file names or paths enter any metric or log. Part B adds
   only integer counters (per-class candidate counts, fallback flag); Part A
   adds one numeric detail (`earlyReject`) on an already-emitted metric.

## Phase 0 — measurement (before flipping either flag on)

Use the shipped instrumentation; add only tiny counters.

- **Already present:** design-97 `serverTimings` on success + 409 (live in
  prod — the Motivation table); the client `missing` phase wall and
  `report.record("missing", { count })` (`sync-recovery.ts:258–261`); the
  commit `OpSpan` outcome metric.
- **Add (counts only, no identifiers):**
  - Part A: `earlyReject: 1` numeric detail on the commit metric's `conflict` /
    `epoch_stale` outcomes when the early branch fired.
  - Part B: per-class preflight counters in the `missing` phase details —
    `introduced` (unique class-1 addresses post-defer), `recover` (class-2
    count), `sent` (deduplicated union actually posted), and `fullAudit` (0/1)
    — so a narrowed run, a recovery run, and a fallback run are
    distinguishable and the O(changed refs) gate is directly assertable.
    `report.record("address", { count: carried })` already gives the carried
    count for the ratio.

## Gates (falsifiable, per audit targets)

Workload A (`docs/audits/…:1227–1244`) on the fixed ~114k-ref workspace, with
the audit's statistical discipline (`…:1294–1301`): **10 warm samples per
scenario**, p50 + p95 + range reported, flag-off runs of the same build as the
A/B control.

**Part A:**
- Known-stale commit POST **p50 ≤ 1s** over ≥10 deliberately stale-parent
  pushes and ≥10 epoch-stale pushes (client `postMs`; response
  `serverTimings.totalMs` as the server-side cross-check).
- Two split assertions (v3; round-2 item 6 — `earlyReject` lives in the server
  metric, not the response body, so `commitSigned` alone cannot see it):
  (a) *client integration* — the early 409s classify into the same `pull-first`
  / `epoch-stale` retry actions through `commitSigned` + `sync.ts`;
  (b) *server metric capture* — the test metric sink records `earlyReject: 1`
  and the declared-ref `count` on every early 409, and records **no**
  `earlyReject` on transaction-path 409s (raced commits) or any other outcome.
- `same_sequence_different_hash` fires on an equivocating stale commit with the
  flag on, identical to flag-off.
- Clean uncontested commit regression bound: 10 warm flag-on vs 10 warm
  flag-off clean one-file commits; flag-on p50 of both client POST wall and
  `serverTimings.totalMs` within **+5%** of flag-off p50.

**Part B:**
- One-file changed push: `sent == introduced`, and `introduced` equals the
  change's **unique post-defer introduced ciphertext address count** (1 for a
  non-duplicate change; the counter, not the file count, is the assertion —
  convergent duplicates and deferrals legitimately shrink it). Zero-file-change
  push that still commits (git-identity-only, the soak shape): `sent == 0` and
  **no `/v1/blobs/check` request issued**. **O(changed refs), not
  O(workspace)** — asserted on the counters across the 10-sample runs.
- `missing` phase **p50 < 500ms** over 10 warm one-file pushes on the ~114k
  workspace.
- Full-audit fallback enumerates all addresses through ≤`MAX_SHAS_PER_CHECK`
  chunks and converges on the remote-loss repair rig.
- Multi-page carried-loss rig (>10k refs lost server-side): converges within
  the existing attempt budget; per-retry `unsatisfiedTotal` strictly decreases.

**Both — named suites, flag-on reruns, zero behavioral diff:**
- Server: `apps/api/test/gc-phase1.test.ts`, `gc-purge.test.ts`
  (fence/candidate races), `receipts-flow.test.ts`, `sidecar-flow.test.ts`,
  `worker.test.ts` (commit admission + quota/over-cap),
  `blob-check-batch.test.ts` (check semantics) — all green with
  `RBOX_COMMIT_EARLY_REJECT=1`.
- Client: `src/cli/sync.test.ts`, `remote-commits.test.ts`,
  `sync-scan-defer.test.ts`, `git-sync.test.ts` (422/defer/recapture paths) —
  all green with `RBOX_PREFLIGHT_DELTA=1`.
- New rig scenarios (from §Correctness 4–5): one changed file + lost carried
  ref (recovery threading); carried ref prune-marked / lost / actively-fenced /
  fence-raised-mid-accounting (with the state-2 step assertions and the
  mixed repairable+fenced page); Part A precedence (stale+oversized → 413;
  stale+bad-sidecar / stale+unsatisfied-carrier → 409 then post-pull 400/422);
  recovery-accumulator cap → full-audit fallback.

## Rollout

Each part behind its own flag; ship, soak, and roll back independently.

- **Part A:** server env flag `RBOX_COMMIT_EARLY_REJECT` (add to
  `apps/api/src/env.ts` alongside the other `RBOX_*` toggles). Unset/`"0"` →
  today's behavior (no early return). `"1"` → early check active. Deploy to
  `rbox-dev-api` first (DEPLOYMENTS.md dev-first rule), verify the gate signals
  on a dev workspace, then enable in prod. Rollback = flip the flag; no schema,
  no migration.
- **Part B:** client env flag `RBOX_PREFLIGHT_DELTA`. Unset/`"0"` → today's
  full-workspace check. `"1"` → change-only candidate set. `rbox sync --verify`
  (or `RBOX_PREFLIGHT_FULL=1`) always forces the chunked full audit regardless.
  The `/blobs/check` server cap follows the client-first rollout order in the
  design (client chunking → fleet upgrade confirmed → server cap), and is a
  separately revertable server deploy.
- Sequence follows the audit's Track A (`…:1201–1210`): design-97 timings
  collected (done — live in prod), ship Part A, then Part B; O(change)
  admission (design 102) and manifest deltas (design 84 C1/C2/D) follow
  separately.

## Out of scope

- **O(change) commit admission (design 102) — hard boundary and hard
  dependency.** This document designs **no** server-side ref-delta admission:
  no parent-sidecar reads, no delta computation, no
  `carriedRefsNeedingFenceRegrant` set, no modification of the admission SHA
  set. Part B's carried-ref safety proof **depends on the current full-ref
  server admission** (`validateCommitRefs` over the complete refset). This is a
  correctness dependency, not advice: **`RBOX_PREFLIGHT_DELTA` must not remain
  enabled alongside a design-102 narrowed admission until design 102's own
  acceptance proves carried-ref fence/prune/loss handling under its delta
  scheme** — design 102 must list that proof as a blocking precondition for
  coexistence, and this design's acceptance adds a regression test pinning that
  today's admission checks carried refs (so any future narrowing that breaks
  the assumption fails loudly, not silently).
- **Manifest snapshot compression / deltas (design 84 C1/C2/D).**
- **Daemon pull narrowing / foreground delegation (designs 39/85).**
- Any change to receipt attestation, multipart, or the crypto pipeline.
</content>
