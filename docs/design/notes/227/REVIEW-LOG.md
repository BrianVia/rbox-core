# Design 227 — review log

## Round 1 (2026-07-30) — premise collapse

Three lanes reviewed `227-phase2-gc-drop-reachability.md`, whose thesis was
"delete Phase 2 GC's reachability belts because the subrequest budget cannot
rise". Independently of the lanes, the premise was falsified: the paid-plan
Cloudflare ceiling is **10,000 subrequests per invocation**, not 1,000. The
repo already held both facts — `docs/design/112-batch-fill-wire-cap.md:112`
("10,000 subrequests/request") and `docs/learnings.md:206` ("Account is Workers
Paid"). `GC_BUDGET_SAFE = 800` was design-95-era margin under the free-plan
limit and was never revisited.

**Outcome: the design inverted.** The old file is deleted. The replacement,
`227-phase2-gc-unwedge.md`, keeps every belt, raises one constant, and fixes
two pre-existing bugs the lanes found while examining the old proposal.

### Disposition of round-1 findings

| # | Lane | Finding | Disposition |
|---|---|---|---|
| 1 | codex | Mint-after-delete ABA: canonical R2 write precedes the fence read, so a purge landing in between deletes both the bytes and the fence row, and the resumed request mints valid authority for deleted bytes | **Accepted as BLOCKER.** New §2.2; gates rollout (§4.2) |
| 2 | execute + rollout | `account-delete` drops refs and condemns before purging DOs / deleting `workspaces` rows, so the belts unwind candidates nothing re-condemns | **Accepted, inverted framing.** The old design called this proof the belt is net-negative; it is an ordering defect in account-delete. New §2.3 |
| 3 | execute | 835 `kind='canonical'` rows already carry open intents (frozen since 07-20) and must drain or be explicitly unwound; the canonical rows are blobs (audited against prod R2, all resolve at `blobKey`); prod holds zero `kind='manifest'` rows | **Accepted.** §5.4, §5.5 |
| 4 | rollout (F1) | Add `kind IN ('blob','manifest')` to `openIntents` to match `executePage` | **REJECTED.** `executePage` has no such filter (`gc-purge.ts:72`, `:77`); adding it would permanently fence finding 3's 835 rows and jam the intent cursor behind 63,360 more. Direct conflict with finding 3, resolved against F1. §2.4, §6.5 |
| 5 | both | `openIntents` builds one statement per row (`gc-purge.ts:176-191`); rewrite as set-based `json_each` chunks of ≤33 | **Accepted.** §2.4 |
| 6 | execute | Chunked/batched execute for throughput | **Deferred with arithmetic.** 200/day standing throughput means ~18 years for the backlog; even the budget-max 1,381/day is ~2.7 years. The external drain is mandatory either way, so batching changes nothing this cycle. Named follow-up with a measurement gate. §2.4 |
| 7 | codex (6) | `gcMark` probe-to-insert race; fix by making the write `INSERT … WHERE NOT EXISTS` | **Conditionally recorded.** `gcMark` keeps reachability and is otherwise untouched; apply only if `gcMark` is opened for another reason. §2.4 |
| 8 | rollout (F4) | `GC_WARN_WORKSPACE_ROWS = 6` / `GC_MAX_WORKSPACE_ROWS = 8` were derived from the old `maxW = 8`; at 12 workspaces the warn is permanently on | **Accepted.** Re-base on the new bound or delete the row-count trigger. §2.4 |
| 9 | rollout | Orphan-ref alarm (`blob_refs` with no `blobs` row) as the standing canary | **Accepted.** One indexed query, catches the finding-1 ABA class directly. §2.4 |
| 10 | rollout (F6/F11) | Rollout ordering: external drain stopped/complete, promote disabled, dry-run, one supervised execute, then enable | **Accepted, expanded.** §4, now 8 numbered preconditions |
| 11 | execute | `INSERT OR IGNORE` does not downgrade the fence trigger — proven empirically on real D1 | **Recorded as settled** so nobody re-tests. §5.3 |

### Corrections made to the founding brief during this rewrite

Verified against the worktree; all file:line anchors below were re-read, not
relayed.

1. `gcExecuteLimit` does **not** scale with the budget — `GC_MAX_EXECUTE_ROWS
   = 200` clamps it (`gc-policy.ts:6`, `:13`). The brief's "~1,380/tick" is
   wrong.
2. `gcPurge` runs **once per day** at `GC_PURGE_UTC_HOUR = 9`
   (`worker.ts:74`, `:159`), mark at 08 UTC. Real throughput is 200
   objects/day. This is what makes finding 6's deferral correct.
3. `RBOX_GC_PURGE_DISABLED` is **`"0"` — enabled — in prod today**
   (`wrangler.jsonc:194`; dev `:104`). The brief expected it already disabled.
   Raising the budget therefore *arms* the executor; disabling it becomes a
   blocking step in the same change.
4. The three `maxW` sites share `GC_BUDGET_SAFE`; what diverges is the
   expression (`gc-mark.ts:21` subtracts a bare `3`). Consolidation is right
   for a different reason than the brief gave.
5. Legacy PUT / multipart are fenced by **D1 triggers**
   (`migrations/0024_gc_state.sql:17-45`), not an app-level read. Their remedy
   needs no timestamp anchor.
6. Design 95's `checkTime`-before-fence-read invariant (`95:77-82`) is already
   satisfied in the letter (`blobs.ts:64` precedes `:68`). The violation is
   that the pair sits after the R2 write.
7. The brief's proposed "reject when elapsed exceeds the authority window" is
   unnecessary — moving the anchor ahead of the write restores design 95's
   terminal inequality on its own. Dropped as a moving part with no job.
8. Line drift corrected: `directWriteVerified` `:42-54`;
   `mintFenceCheckedReceipts` `:56-87`; `directWriteWithReceipt` `:89-98`;
   legacy single PUT `:264-296`; multipart `:516-549`; account-delete condemn
   `:248-255`.

### Open / unverifiable from the repo

- The 835-open-intent count, the zero-`manifest` count, and the R2 audit that
  the `canonical` rows resolve at `blobKey` are prod-data claims carried on the
  execute lane's authority. No `'canonical'` literal exists anywhere in this
  tree; the rows came from the out-of-band 07-08 storage-truth reconciliation.
  Re-confirm against prod D1 before the supervised execute (§4.6).
- `GcHealthV1.maxRows` is typed as the literal `8` (`gc-health.ts:15`) and is
  serialized into `/v1/gc/health`. Re-basing it is a response-shape change;
  check `rbox-admin` before picking the new value.

## Round 2 (2026-07-30) — final-gate codex review: CHANGES-REQUIRED

One codex lane reviewed `227-phase2-gc-unwedge.md` against the §2.2 anchor-move
argument and the §2.3 reorder. Verdict: budget raise, belts, batch anchor and
account-delete reorder are sound; **the ABA proof was not**. Three blockers
shared one root cause.

**The fold:** §2.2 was rewritten around a single principle rather than three
patches —

> Every time comparison the delete-fence safety argument relies on must be
> evaluated by D1, inside the same transaction that performs the durable write.

One rule, three applications (`deleting_at` stamping, receipt publication,
legacy publication), plus one consequence (mint rejects a stale anchor). **Zero
new constants** — the receipt paths use the signed `e`, the legacy paths reuse
`RECEIPT_TTL_MS` (`receipts.ts:10`). Added to §5 as settled.

### Disposition of round-2 findings

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | BLOCKER | `deleting_at` is stamped with `gcPurge`'s invocation-start `nowMs` (`gc-purge.ts:219` → `:293` → `:184`), not the intent's real opening time; a stalled P1 makes a fresh receipt instantly outlivable | **ACCEPTED** — folded as §2.2(a). D1-evaluated stamp using the `julianday` expression already in `fairuse.ts:215`/`:220`. Test §3.5 |
| 2 | BLOCKER | Receipt expiry is verified at request start (`workspace-sync.ts:544`/`:552`, `:907`/`:925`) but published much later (`commit-accounting.ts:196`, `:213`, `:266`); an arbitrarily long pause publishes on expired authority | **ACCEPTED** — §2.2(b). Carry `e` into accounting, guard every publishing statement with a D1-time comparison inside the same `db.batch`; guarded-out publish returns via the existing `needsUpload` path (`:270`). Test §3.6 |
| 3 | BLOCKER | The pre-write read alone does not protect legacy PUT / multipart: P2 removes the very `gc_candidates` row the triggers test, so publication resumes with the triggers silent | **ACCEPTED** — §2.2(c). Blobs insert (`blobs.ts:272`, `:526`) + grant (`:282`, `:537`) in one transaction carrying a D1-time deadline of `preReadTime + RECEIPT_TTL_MS`; refusal is the existing `503 retry_later` (`:276`, `:531`). Test §3.7. §6.6 rewritten |
| 4 | HIGH | Minting can return 200 with an already-expired receipt after a long stall (`receipts.ts:114`, `e` at `:121`), contradicting the stated 503/no-receipt contract | **ACCEPTED** — §2.2(d), same `RECEIPT_TTL_MS`, no new constant. Test §3.8. §6.8 flipped: round 1 dropped "reject on elapsed"; round 2 restores it as a *reuse*, not an invention |
| 5 | HIGH | Rollout dropped design 95's 48h clean soak (`95:355`) and let the external drain be merely *stopped*, arming a 200/day pipeline against 1.34M rows; and a completed drain legitimately zeroes the mandated non-zero audit counts | **ACCEPTED** — §4 now 10 steps: audit expectations made conditional (§4.5), backlog gate added (§4.7), 48h soak restored (§4.8). The drain completes ~2026-07-30 at ~113 rows/s, so the gate is already satisfied by any plausible deploy date — kept because it is free. Also folded: leaving the 08 UTC mark enabled is safe (`deleting_at = NULL` rows fence nothing), *and* fresh candidates make legacy `missingBlobs` (`blobs.ts:214`) report them missing, forcing a client re-upload — now stated, not discovered |
| 6 | HIGH | The orphan-ref query cannot detect the ABA — accounting re-creates `blobs` and `blob_refs` in one transaction, so D1 is consistent while R2 is empty | **ACCEPTED** — §2.4 keeps the query as a D1-integrity alarm and **deletes** the ABA claim. Sampled entitled-present-vs-R2 `head()` metric recorded as a named follow-up, explicitly out of scope (it costs subrequests). §6.10 |
| 7 | MEDIUM | The no-kind-filter decision is right; the stated mechanism is wrong | **ACCEPTED (mechanism only).** Decision stands. §2.4 now says the filter would strand the ~63,360 rows with `deleting_at IS NULL` (`gc-purge.ts:166`, `:171`); it could not re-fence the 835 already-open rows (past `openIntents`, on the execute cursor `:67`) or jam it. Both regression tests added (§3.10); settled as §5.9 |
| 8 | MEDIUM | `openIntents` batching conflates rows with statements and is an unmeasured optimization inside a safety-critical change | **ACCEPTED — OUT of scope.** Standing throughput is bounded by `GC_MAX_EXECUTE_ROWS = 200`/day and the external drain owns the backlog. Moved to a named follow-up with the distinction recorded: `ACCOUNTING_INSERT_CHUNK = 33` is rows/statement, `STMTS_PER_BATCH = 34` is statements/batch. Round 1's batching test (old §3.6) deleted. §6.9 |
| 9 | MEDIUM | `gc-health` "re-base or delete" unresolved; risks a second max-workspace owner | **Anchors folded only** (`maxRows` literal is `gc-health.ts:14`, not `:15`). Codex's `rbox-admin` check — no consumer of `maxRows`, `GcHealthV1`, or `/v1/gc/health` — is folded into §2.4, which removes the open unknown that blocked the choice. The choice itself is **not ruled**; carried to round 3 |
| 10 | MEDIUM | Publication-fence policy lacks one named owner | **NOT RULED** — carried to round 3. Note that §2.2's rewrite makes this cheaper to answer: the policy is now one rule with one deadline expression, so naming a single owner is a refactor decision, not a design question |
| 11 | LOW | `.agents/skills/account-cleanup/SKILL.md:37` still documents refs/orphans before workspace DO deletion, stale under §2.3's reorder | **NOT RULED** — carried to round 3. Verified stale in the worktree; recommend accepting it into the implementation surface, it is one line |

### Anchor corrections found while folding (verified in the worktree)

Two of the round-2 findings carried wrong line numbers. Decisions unaffected;
the doc uses the verified anchors.

1. Codex cited `gc-purge.ts:163` for `openIntents`' `deleting_at IS NULL`
   filter. `:163` is the cursor-`WHERE` ternary; the filter is at `:166`, with
   the cursor-reset fallback at `:171`.
2. Codex cited `commit-accounting.ts:26` for `ACCOUNTING_INSERT_CHUNK = 33`; it
   is at `:29` (which round 1 already had right). Likewise `d1-batch.ts:20` for
   the statements-per-batch limit: it is `STMTS_PER_BATCH = 34` at `:24`.
3. Design 95's soak requirement is `95:355`, not `95:353`.
4. The design's own `GcHealthV1.maxRows` anchor was `:15`; it is `gc-health.ts:14`.
5. `commit-accounting.ts:266` (`await db.batch(stmts)`) is the publication
   commit point; codex cited `:263` (the enclosing `try`).

### Process note

The worktree's tracked `CLAUDE.md` does not contain the "Primitive-first
architecture" section — it says "look at AGENTS.md for your rules". Reviewers
must be pointed explicitly at `AGENTS.md` or the global section; a lane told to
"apply CLAUDE.md's primitive rules" will find nothing at that path.

## Round 3 (2026-07-30) — serial confirm: ALIGNED

Convergence closed. The three carried findings are ruled; no new blocker.

### Rulings on the carried round-2 findings

| # | Finding | Ruling |
|---|---|---|
| 9 | `gc-health` "re-base or delete" unresolved | **DELETE, do not re-base.** `GC_WARN_WORKSPACE_ROWS`, `GC_MAX_WORKSPACE_ROWS`, the `rows >=` disjunct (`gc-health.ts:39`), and the whole `maxRows` field (literal type `:14`, population `:46`, warning-log echo `:67`) go. Re-basing would create a second owner of the workspace bound restating `gcMaxWorkspaces()`; `roots_budget_exceeded` already reports the bound being hit, surfaced via `purge.outcome`. `warn`'s third disjunct becomes the §2.4 orphan-ref count. Codex verified `rbox-admin` has no consumer of `maxRows`; this tree has none either |
| 10 | Publication-fence policy lacks one named owner | **ACCEPTED.** §2.2 now names it: the **D1-time-guarded publishing transaction** (`commit-accounting.ts:266` for receipt paths; the new single blobs-insert+grant transaction for legacy PUT/multipart). `deleting_at` stamping is the same rule's delete-side mirror, owned by `openIntents`' `UPDATE` |
| 11 | `account-cleanup/SKILL.md` stale under §2.3 | **ACCEPTED into the implementation surface.** Anchor corrected: the stale purge-order line is `:42`, not `:37` (`:37` is the dashboard sign-in step) |

### Round-3 focus items, answered

1. **Is §2.2's principle sufficient — any JS-evaluated time comparison left in
   the fence argument?** No. The four sites the argument needs are all covered:
   mint anchor (pre-write fence read, §2.2 remedy step 1 + (d)), receipt
   publication (b), legacy publication (c), `deleting_at` stamping (a). The
   remaining `Date.now()` calls — `workspace-sync.ts:544`/`:907`,
   `blobs.ts:64`, `gc-purge.ts:219` — become inputs to *early aborts* only; no
   durable delete-fence conclusion rests on them once (a)–(d) land.
2. **§2.2(b) guard granularity — are already-entitled refs too bluntly
   guarded?** No, and the code answers it: `validateCommitRefs` skips every sha
   in the entitled-AND-present `have` set (`commit-accounting.ts:135-136`), so
   `newRefs` contains **only** receipt-verified refs. The min-`e` guard covers
   nothing that did not arrive on a receipt. Its only conservatism is that a
   super-batch mixing receipts uses the earliest `e` — deliberate, and it fails
   toward `needsUpload`.
3. **Detection of a guarded-out publish** is read fail-closed: a fully
   guarded-out super-batch writes zero rows across all statements, and treating
   an all-zero super-batch as a shortfall is conservative (a false positive
   costs one client re-upload). Recorded so the implementation does not try to
   distinguish it from idempotent re-runs by `changes` alone.

### Anchor corrections made in round 3 (verified in the worktree)

1. The health endpoint is `GET /v1/admin/gc?phase=health`
   (`routes/admin.ts:142-144`, platform-secret gated) — **not** `/v1/gc/health`,
   which the design cited in §0.1 and the §4.4 rollout step. Corrected in place.
2. `account-cleanup/SKILL.md:42`, not `:37` (finding 11).
3. `missingBlobs`' condemned-sha filter is `blobs.ts:213`; `:214` is its
   comment.
4. §6's list numbered two entries `10`; the trailing item is now `12`.

### Verified this round (spot-check, all re-read not relayed)

`gc-purge.ts:166`/`:171`/`:184`/`:219`/`:223`/`:235`/`:293`/`:299-304`,
`:131-140`, `:36-44`; `gc-policy.ts:1-13`; `gc-mark.ts:21`; `gc-audit.ts:16`;
`gc-health.ts:7-8`/`:14`/`:39`/`:46`/`:67`; `commit-accounting.ts:29`/`:142-144`/
`:185`/`:196`/`:213`/`:266`/`:270`; `d1-batch.ts:24`; `receipts.ts:10`/`:114`/
`:121`; `fairuse.ts:215`/`:220`; `blobs.ts:42-54`/`:49`/`:64`/`:68-71`/`:96-97`/
`:213`/`:266`/`:272`/`:276`/`:282`/`:518`/`:526`/`:531`/`:537`;
`blob-batch.ts:268`/`:279`; `account-delete.ts:203-211`/`:242`/`:248-255`/
`:301-318`; `workspace-sync.ts:544`/`:552`/`:907`/`:925`; `worker.ts:73-74`/
`:142`/`:159-160`; `wrangler.jsonc:104`/`:194`; `0024_gc_state.sql:17`/`:27`/
`:37` (+ `:19`/`:29`/`:39`); `0005_gc.sql:16-18`; `95:66-67`/`:77-82`/`:303-311`/
`:355`; `112-batch-fill-wire-cap.md:112`; `learnings.md:206`. All arithmetic in
§2.1 re-derived (88, 88, 1381→200, 2,094 ≈ 26%).

### Test-setup confirmation (§3)

All 12 are settable up in `apps/api/test` as specified. The load-bearing seam
for tests 5–8 is that the JS clock is controllable (injected `nowMs`; a receipt
minted with a past `t`) while D1's `julianday('now')` is not — which is exactly
the property under test. Test 12's fixture is legal: `blob_refs`
(`0006_tenancy.sql:29-33`) has **no** foreign key to `blobs`, so a
ref-without-blob can be inserted directly.
