# Fold plan — 174 r1 → v2 (orchestrator rulings)

Inputs: REVIEW-174-R1-CODEX.md (C1-C18), REVIEW-174-R1-OPUS.md (O1-O9),
REVIEW-174-R1-OPUS-B.md (B1-B4). Every finding ruled ACCEPT unless noted;
resolutions below are BINDING — fold exactly these, do not invent additional
mechanism (founder rule: no over-engineering; prefer the minimal resolution
written here).

## Dedup map
- Reflog gap: C1 = O2. Ancestry/grafts/objects: C2. Reasons API: C3.
  Placement/binding: C4 = O4. B atomicity: C5+C6 = O3 = B2. Lane
  exhaustiveness: C7 = O7 = B4b. Tombstones: C8 = O1 = B1. State API: C9.
  Journal claim: C10 = B4a. E: C11+C12+C13 (O's E-acceptable is OVERRULED by
  C's stronger evidence). Seeding: C14. Clocks/busy: C15. C metrics: C16 + O5
  (anchor). D scheduling: C17 + O6. Editorial: C18, O8, O9, B3.

## Rulings → exact doc changes

1. §4.1 REWRITE (C1,C2,C3,C4,O2,O4):
   - Eligibility: allowlist shrinks to reason set {local-commits, local-stash}
     obtained from a NEW complete typed blocker-set seam (classification
     returns the full set with provenance; skip only when EVERY blocker is in
     the allowlist — never the collapsed display reason). Name the seam
     (FollowResult gains `blockers: TypedBlocker[]`).
   - Attempt key adds: digest of `logs/refs/stash` bytes + every branch
     reflog consulted by the boundary proof (enumerate at classification
     time, record the digested path list in the attempt record).
   - Grafts: preflight structurally REJECTS `info/grafts` /
     `shallow`-adjacent graft files (repo becomes `unsupported`, never
     skippable). Indeterminate ownership/preservation proofs map to an
     `indeterminate` blocker OUTSIDE the allowlist — never encoded as
     local-commits/local-stash.
   - Placement: A runs strictly AFTER journal recovery, follower-protocol/P
     settlement, and partial revalidation; any of journal-present, standing P,
     partial-disposition-change, BASE/origin change invalidates the attempt.
     Attempt record binds: incomingKey, fingerprint BRACKET (stable
     before/after read, divergence-cache style), reflog digests, repo
     identity + state nonce, BASE/origins snapshot hash, partial disposition.
   - Delete the sentence "divergence cache already proves this primitive
     sound"; replace with per-input coverage table (which input, covered by
     what). Delete "ALL deferral reasons" scope overclaim (C18).
   - Safety floor unchanged (1h); floor re-follow refreshes attempt.at on
     same outcome (C15). A-skip refreshes the SAME apply episode's lastSeen
     via ordered sidecar-only update (C15 resolution 1, the minimal one).

2. §4.2 REWRITE — staged supersession (C5,C6,C7,C8,C9,C10,O1,O3,B1,B2):
   New shape: **capture-then-prove-then-swap**. Pending repos still enter the
   capture pool when the cheap pre-probe (fingerprint-gated) says local MAY
   supersede; P and ALL sidecars stay byte-intact through the entire push.
   After capture+normalization produce the final candidate:
   - Prove supersession against THE FINAL CANDIDATE (not the live repo):
     branches same-name FF-or-equal; tags exact-equal; ALL other lanes exact
     candidate equality: stash oid, HEAD (symbolic AND detached — any
     mismatch blocks), refScope, semantic index projection (indexIdentityV2),
     exact opState path→artifact map, canonical config. Fail closed on any
     error/shallow/missing-object.
   - Tombstone retention: the normalizer for a superseding candidate takes
     validated P's refTombstones + refTombstoneGeneration as an EXPLICIT
     retention source (merged alongside advertised; high-water =
     max(advertised, P, candidate)). Authoring-predecessor semantics stay
     advertised-based (C8 fix direction, first option).
   - Publish the candidate; on ANY failure (preflight/config/capture/upload/
     422/commit/409) carry P byte-for-byte — the today-path.
   - Clear pending/partial/deferral/attempt ONLY in the accepted-commit ACK
     state transition, expressed through the EXISTING ordered sidecar
     transitions (pending absence, partial[rel]=null, attempt=null, ordered
     apply-lane deferral clear bound to predecessor lastSeen) and the
     existing publisher-ack composer arm. Document which BASE members remain
     per composer rules — remove the false "wholesale" wording (C9).
   - Journal precondition: B proceeds only when the existing recovery
     prepass reached a terminal disposition (none / rolled-back /
     landed-and-cleared / quarantined-binding-mismatch); defer/corruption/
     human-intervention blocks supersession. DELETE the invented
     "absence-supersession quarantine primitive" claim (C10).
   - Busy: a B probe that observes git-busy surfaces it as a capture busy
     observation (arming the existing +2s/+8s retries) while carrying P (C15).
   - Multi-writer text: keep the CAS-is-airtight-for-unseen-sequences
     conclusion (codex verified) but remove the promise that post-409 the
     newer section "becomes pending" (it may apply cleanly); state that the
     ACK-gated clear makes the 409 case trivially safe (nothing was cleared).
   - Soften "no data destroyed" to branch/tag lanes; stash reflog-only
     content is device-local by existing stash-sync semantics (O8).

3. §1.2/§1.3 seeding correction (C14): mark the seq-83 schema-bump seeding
   narrative RETRACTED (keep the observed timeline as raw evidence). State:
   the loop-after-seed mechanism is code-confirmed; the SEED is an open
   forensic question with candidate hypotheses (pre-existing pending from an
   earlier hold; accepted-commit/state-save crash recovery; another writer's
   earlier section) to be resolved by RepoRecord/sequence forensics on the
   live Mac during implementation. §5 test 1's fixture must construct the
   pending state through a REAL reachable transition (e.g. a second writer
   advancing the section, or the documented crash-recovery path), not the
   retracted narrative.

4. §4.5 E: DELETE as a 174 item. Move to Non-goals with rationale: designs
   172/175 deliberately keep the watcher latency-only (silent Parcel drops,
   startup gap); lastSyncedManifest is BASE, not local truth (reconcile
   corruption, mass-delete guard distortion); daemon post-pull
   replaceManifestFromScan remains regardless. A future design needs a
   loss-detecting baseline protocol first. C2 telemetry stays and will
   quantify the scan share to motivate that design.

5. §4.3 C (C16, O5): exclusive leaf accounting — leaf timers
   (fetchDecrypt, bundleVerify, gitImport, refTxn-exclusive, ownership,
   reflog, connectivity-proof, indexOpState) + explicit residual; acceptance
   becomes `repoWall − union(leafIntervals) ≤ 10%`. Nested parents
   (classifyMs) reported separately, excluded from the sum. Fix the fsck
   anchor: the follow-path connectivity proof is checkout-txn.ts:282-284
   (gated :563-566); engine/git/apply.ts:712 is the legacy diverged path.

6. §4.4 D (C17, O6): retention runs as an independently bounded hygiene
   phase permitted after a stable probe/carry OR capture (not capture-only);
   each deletion batch refreshes/invalidates the repo's divergence-cache
   entry; delete transaction race-checks old OIDs; fail closed on
   reachability errors. Note explicitly: D does not run on a still-wedged
   repo until B clears it (A removes the interim per-pull cost).

7. Editorial (C18, O9, B3): label fleet numbers as author-observed (no
   checked-in fixture); refresh drifted 130↔174 anchors; cite the plan-side
   recovery preamble (plan.ts:262-317) as the real journal safeguard.

## §5 test-list updates
- Test 1 rebuilt on a real seed transition (ruling 3).
- ADD: B preserves P's tombstone chain+generation when advertised lacks them
  (three-device shape, C8/O1).
- ADD: capture-failure during superseding push carries P byte-for-byte, no
  regression publish (C5).
- ADD: candidate-vs-probe divergence (ref reset between probe and capture)
  → carry P (C6).
- ADD: 409 during superseding push leaves pending+deferral byte-intact (O3).
- ADD: reflog-only stash mutation (drop stash@{1}, T→U→T) invalidates the
  attempt (C1); grafts file → unsupported (C2); mixed-blocker
  (local-commits + unreadable) never skips (C3); journal-present pull never
  skips (C4).
- REPLACE test 9 (E deleted) with: sync_phase sampling emits on outlier
  ops and every Nth op; no repo paths in samples (C2 telemetry).
- Test 10 acceptance reworded per exclusive accounting (ruling 5).
- D tests: hygiene phase runs on carry pushes; cache entry refreshed after
  prune batch (ruling 6).

## Out of scope for the fold
No new items. Do not re-litigate accepted architecture. Keep §2 scope list
(minus E) and §6 rollout (drop RBOX_PULL_SCAN_REUSE).
