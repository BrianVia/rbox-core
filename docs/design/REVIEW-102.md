# REVIEW-102 — adversarial review ledger for design 102 (O(change) commit admission)

Reviewer: codex (gpt-5.6-sol), read-only, adversarial. Cap 6 rounds.
Attack focus: carried-ref regrant under active deletion intents (can a fenced
blob's data be lost?), client-forged/replayed refsets, parent-refset
unavailability (fail closed?), quota under-charging via delta manipulation,
root-index divergence, shadow-mode blind spots, Worker memory bounds,
unfalsifiable gates.

---

## Round 1 — VERDICT: REVISE (15 items)

Codex (gpt-5.6-sol, medium) delivered a deep review. Dispositions:

1. **Carried-ref fence TOCTOU** — ACCEPT (reframe). The snapshot was presented as
   load-bearing; it must not be. Rewrote §3.3 so carried-ref safety rests on the
   D1-level **blob_refs-row-persistence invariant** (openIntents opens a
   `deleting_at` intent only `WHERE NOT EXISTS blob_refs` — versions.ts:431 — so an
   intent literally cannot be created against a carried ref that still holds this
   account's grant; phase1Purge resurrects reachable candidates rather than
   dropping them; `/roots` fails closed). The fence probe is demoted to a
   fail-closed bug-detector: nonempty `fence ∩ carried` ⟹ fallback + alert.
2. **Fenced carried blob loss** — ACCEPT/REBUT. Precluded by item 1's invariant;
   proof rewritten and the deterministic race rig (item 15) added as the gate.
3. **blob_ref_candidates race** — ACCEPT (reframe). Same treatment; phase1Purge's
   fresh reachable-resurrect is the serialization; marker-skip cannot drop a
   head-reachable ref. Documented in §3.3/§4.4.
4. **Child-refset trust overstated** — ACCEPT. Rewrote §3.4: safety = authoritative
   parent + full validation of every server-derived addition, NOT "server-authored
   child bytes." Added replay/omission/substitution/dup adversarial tests.
5. **Quota sizes must come from receipts** — ACCEPT (important). mergeDiff now
   yields SHA membership only; sizes for added refs continue to come from
   `verifyReceipt` inside the unchanged `validateCommitRefs`. §3.2/§4.1 fixed.
6. **Parent-unreadable = history corruption, not just a miss** — ACCEPT. §3.5 now
   distinguishes optimization-fallback from authoritative-history-corruption, pages
   on the latter, notes GC/prune independently fail-closed.
7. **Roots-index "equality-of-derivation" insufficient** — ACCEPT. §4.7 reframed:
   this design does NOT feed the index; index stays correct via the unchanged
   stored `seq:<n>` body; added a divergence monitor (admission delta vs folded
   dropped_index) and made index-priming an explicit follow-on.
8. **Shadow mode can't compare equivalent values** — ACCEPT (important). Rewrote
   §6: read-only comparison of `validateCommitRefs(admitSet).newRefs` vs
   `validateCommitRefs(fullChild).newRefs` from ONE immutable pre-state; fence/
   over-cap equivalence proven by the injected-race rig, not a dry query.
9. **Shadow telemetry unbounded** — ACCEPT. Bounded to counts + stable digest +
   ≤K sample shas.
10. **Memory argument not credible** — ACCEPT (important). Rewrote §3.2 to a
    streaming two-pointer merge over the two sidecar **byte buffers** (40B fixed
    records, already sorted) — no Ref[]/Set materialization; only the `added` SHA
    list is built. Added a measured peak-heap rig gate at 250k disjoint.
11. **Fold guard doesn't bound commit+fold memory** — ACCEPT. Byte-buffer merge
    keeps heap small; added the combined-peak overlap rig test.
12. **Unfalsifiable gates** — ACCEPT. §7 now has concrete sample sizes, delta-size
    matrix, zero-workspace-slope statement bound, p50/p95/p99, fallback ceilings,
    zero-divergence denominator, deterministic race schedules.
13. **200ms gate omits residual O(N) parse/fetch** — ACCEPT. Added per-phase
    timings + a total server-admission gate at 112k and 250k; clarified ≤200ms is
    the D1-accounting sub-phase, ≤2s is total (residual parse is the wire-delta
    follow-on's target).
14. **Response equivalence too broad** — ACCEPT (reframe). Proved delta's
    accounting input (`newRefs`) is IDENTICAL to full's, so 409/epoch/over-cap are
    byte-identical and needsUpload is set-equal; scoped the claim precisely.
15. **Required deterministic race rig** — ACCEPT. Added as a named acceptance gate.

Revision written as draft v2. Proceeding to round 2.

## Round 2 — VERDICT: REVISE (3 items)

Codex verified the round-1 fixes against the code and confirmed the core GC
invariant holds for normal Phase-1/2 (cited openIntents `NOT EXISTS` guard
versions.ts:423, phase1Purge resurrect gc-phase1.ts:106, marker-guarded delete
:125, global zero-ref recheck versions.ts:349). Three residual items, all valid:

1. **Persistence invariant not universal — account hard-deletion drops blob_refs.**
   `account-delete.ts:228–254` unconditionally deletes the account's `blob_refs`
   (step 2) BEFORE the DO purge (step 4, :301–316). ACCEPT: scoped the invariant to
   **live (non-deleting) accounts**, added **"account deletion in progress" as a
   fallback trigger** (§3.5A) so the delta path is provably ≡ full under deletion
   races, and refined "never marked" — for `phase1Mark`/`blob_ref_candidates` it
   holds via the grace+reachable argument (mark immediately follows the reachable
   snapshot in `runPhase1`, so a ref that entered head after the snapshot is
   grace-fresh); the global `gcMark` may leave a harmless `deleting_at IS NULL`
   candidate row (not in the fence probe, cannot open an intent, resurrected). Added
   the account-deletion transition to Gate R.
2. **Shadow mode doesn't detect unsatisfied carried refs.** Because carried refs are
   outside `admitSet`, the old `unsatisfied_delta ⊆ unsatisfied_full` compare misses
   a carried ref that full validation would mark unsatisfied. ACCEPT: §6 now asserts
   `unsatisfied_full ∩ carried = ∅` and `have_full ⊇ carried∖fence` explicitly, via
   an instrumented read-only classify (validateCommitRefs early-returns needsUpload,
   so shadow computes the full have/unsatisfied/newRefs classification). This is the
   primary safety-divergence detector. §4.10 updated to cite it.
3. **Byte-buffer memory model doesn't match the APIs.** `resolveSidecarBytes`
   returns `refShas: string[]`, not the raw buffer (sidecar.ts:72–112). ACCEPT: §3.2
   now specifies the loader refactor (`loadSidecarRaw` returns verified bytes; the
   delta path merges over buffers and does NOT materialize `refShas`/`Set`; the
   fallback path materializes as today; `totalBytes` streamed) and states the honest
   simultaneous-allocation model (parent+child raw buffers + `added` hex strings +
   at-most-one concurrent fold's two `Set`s, bounded by the isolate fold-mutex),
   measured by Gate 4 — dropping the "combined-peak removed" overclaim.

Revision written as draft v3. Proceeding to round 3.

## Round 3 — VERDICT: REVISE (converging; items 2–4 PASS)

Codex verified v3 against the code. Items 2 (account-deletion fallback
implementable via `account_deletions status IN ('pending','purging')`), 3 (shadow
`unsatisfied_full ∩ carried = ∅` correctly shaped), 4 (loader refactor + memory
model now match the APIs) — **confirmed/PASS**. Two actionable items:

1. **"Never marked" not airtight** (sharp). A stale `phase1Mark` reachability
   snapshot can mark a carried ref that was re-added as an already-entitled (`have`)
   ref — `commitAccounting` doesn't refresh `granted_at` for a `have` ref, so the
   grace-skip doesn't fire, and the stale snapshot marks it. Codex confirms
   **durability survives** (resurrect + `NOT EXISTS blob_refs` intent guard), but the
   "never marked" invariant + `newRefs` identity + exact response-equivalence are too
   strong. ACCEPT: §3.3 now leads with the **durability** invariant (load-bearing)
   and acknowledges a **benign transient marker**; the fence probe splits by table —
   `blob_ref_candidates ∩ carried` → **regrant** (matches full, routine, no page);
   `gc_candidates active-intent ∩ carried` → **fallback + page** (provably
   impossible). §4.1/§4.10 characterize the sole **benign divergence** (delta safely
   publishes where full redundantly 422s a present ref). §6 splits shadow divergence
   into **HARMFUL** (not-present/active-intent → zero-tolerance flip gate) vs
   **BENIGN** (present + marked → counted, not a blocker). Gate R adds the
   stale-snapshot marker interleaving.
2. **Unfalsifiable thresholds + "95% CI includes zero."** ACCEPT: added §7.1
   **normative constants table** (frozen before measurement, founder changes once
   pre-soak); replaced the noisy CI slope with a **deterministic `admit_stmts`
   closed-form bound** (primary) + a **fixed max timing slope** (≤5ms/100k, secondary).

Revision written as draft v4. Proceeding to round 4.

## Round 4 — VERDICT: REVISE (4 tightening items; core proof declared sound)

Codex: "the underlying durability proof and benign-marker regrant mechanism are
sound against the inspected GC code." Four precision items:

1. **Shadow BENIGN too loose.** The `have` query requires present ∧ entitled ∧
   ¬marked ∧ ¬active-intent (commit-accounting.ts:83). A present-but-**unentitled**
   carried ref is HARMFUL (mischarge + `openIntents` could condemn). ACCEPT: §6 now
   defines BENIGN ⟺ present ∧ entitled ∧ marked ∧ ¬active-intent; everything else
   HARMFUL.
2. **"One immutable pre-state" not implementable across re-reads.** ACCEPT: §6 now
   issues **one batched read returning the four flags as columns**, and derives full
   + delta + harmful/benign entirely in-memory from that single relation (no second
   D1 pass); conservative (ambiguity ⇒ HARMFUL). Soak-only cost.
3. **§4.4 stale** — still said "never marked"/page. ACCEPT: rewrote §4.4 to the §3.3
   split (observed markers regrant; post-probe markers benign; only active-intent
   pages).
4. **`admit_stmts` bound not self-contained.** ACCEPT: gate 2 now defines what counts
   (prepared statements, excluding CAS/mirror/receipt-crypto), freezes the three
   named `commit-accounting.ts` constants, enumerates the count by outcome path
   (422 / ok / 402), and gives the closed form `ceil(K/90)+1+5·ceil(K/33)+1` with no
   workspace term — falsified by equal `admit_stmts` at 112k vs 250k for equal
   `added`.

Also fixed §3.1 pseudocode to show the split probe (regrant vs fallback). Draft v5.
Proceeding to round 5.

## Round 5 — VERDICT: REVISE (1 item; other three round-4 fixes declared correct)

Codex: "The other three round-4 fixes are correct and self-consistent." One
remaining precision item on gate 2's statement enumeration:

1. **Gate-2 per-path counts contradicted `commit-accounting.ts`.** ACCEPT: (a) `N=0`
   OK path is `ceil(K/90)` only (early return at `:128`); (b) 402 `no_plan` adds the
   accounts SELECT but **not** the used/cap re-read; (c) trigger over_cap counts only
   chunks through the failing ≤3,000-ref super-batch, not `5·ceil(N/33)`. Rewrote the
   enumeration accurately, kept `ceil(K/90)+5·ceil(K/33)+2` as an explicit
   **conservative upper bound**, and changed the workspace-slope falsifier to hold
   **identical `K` and outcome** (not just `added` — `carried_fenced` varies at equal
   `added`).

Draft v6. Proceeding to round 6 (final).

## Round 6 — VERDICT: REVISE (2 items, both gate-2 arithmetic; no safety blocker)

Both items refine the **same** §7 gate-2 statement-count formula — no correctness or
safety finding. ACCEPT both:

1. **Slope falsifier over-simplified.** At fixed `K`, the `ok N>0` count still varies
   with `N` (and over_cap with the failing super-batch). Folded: the exact count is a
   pure function of `(K, N, outcome, failing-super-batch index)`; the falsifier is now
   two-part — (a) the K-only conservative upper bound shows no workspace growth, (b)
   exact equality asserted on a fixture fixing all four variables.
2. **Missing the 422 delete-fence-abort path.** Folded: enumerated separately from
   422 validation-unsatisfied — `ceil(K/90) + 1 + C_fail`.

## Disposition at the 6-round cap

The adversarial loop converged monotonically: 15 → 3 → (2, items 2–4 PASS) → (1 of 4
was a real safety refinement, rest tightening) → 1 → 2, with the trajectory moving
from safety-critical findings (rounds 1–3: fence TOCTOU, quota sizing, memory,
account-deletion scope, benign-marker race) to pure measurement-gate arithmetic
(rounds 5–6). In rounds 4–6 the reviewer explicitly confirmed the safety-critical
core sound against the code: the carried-ref durability invariant (`blob_refs`
persistence vs `openIntents` `NOT EXISTS` guard + `phase1Purge` resurrect), the
benign-marker regrant mechanism, the quota/entitlement `newRefs` identity, the
harmful/benign shadow classifier, the loader refactor + memory model, and the
account-deletion fallback.

**The final REVISE is not a substantive disagreement.** The only items open when the
cap was hit were the precise statement-count enumeration in §7 gate 2 — a checkable
arithmetic fact about `commit-accounting.ts`, iterated in rounds 5–6 and resolved in
v7 (the reviewer had not re-run against the v7 arithmetic). No safety, correctness,
GC, quota, or memory concern remained open. Design is ready for founder review; the
statement-count fixture is an implementation-time detail, not a design fork.
