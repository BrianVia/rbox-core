# Verdict: ALIGNED

R4 correctly incorporates all three R3 MAJOR findings and both MINOR findings. Within the requested five-delta scope, I found no new correctness, durability, recovery, compatibility, or ownership defect.

## Delta confirmation

1. **Crash-seam boundary:** Correctly specified.

   `afterStateCasLockPersisted` is explicitly deleted rather than silently weakened. `afterStateCasLockAppended` now denotes append durability plus retained-fd/path binding, without implying namespace durability; `afterStateCasBatchDurable` establishes the post-parent-flush and final-readback boundary. Both seams are covered by the crash matrix. M0 attribution comes from the completed acquisition result, independently of test seams. See [design 268:48](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:48>).

2. **Retained-fd path binding:** Correctly adopted.

   The design requires no-follow regular-file validation, retained-fd `dev`/`ino` equality, sufficient length, and validated-boundary containment after every successful `fdatasync` and before persistence is acknowledged or a seam fires. Mismatch handling fails closed, cleans every transaction-published link, retains discoverable authority, and suppresses the hook. See [design 268:86](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:86>).

3. **Strict v2 codec and rollout:** Correctly specified.

   The fold now has explicit discriminators, one first-position header, allowlisted acquisition paths, unique outcomes and phases, complete-outcome gating for `locked`, ordered `committed`, bounded input, exactly one ignorable incomplete EOF suffix, and whole-journal indeterminacy for every other malformed or misordered record.

   Downgrade during a crashed-v2 transaction is explicitly unsupported but fail-closed, with the new binary as the operational recovery path. V1 retirement is evidence-gated rather than time-gated, and released-old/candidate behavior is included in validation. See [design 268:94](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:94>).

4. **Requirement-challenge ledger:** Correctly tightened.

   Consumed-name publication now requires both a native binding and an explicit threat-model ruling; it does not claim native no-replace rename alone defeats deliberate same-user consumption. K-batched provenance appends are separately exposed as a founder decision with their precise crash-litter tradeoff. See [design 268:156](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:156>).

5. **Measured performance framing:** Correct and appropriately qualified.

   The 2.92 ms FM probe and desktop syscall measurements are identified as evidence, while the approximately 9-second result is an expectation derived from the approximately 6 ms/lock durability floor and remains subject to benchmark and field confirmation. See [design 268:163](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:163>).

## Protected contracts and validation

R4 continues to protect exact observation-based ownership, copied-marker and inode-reuse safety, marker-content durability, containment/no-follow fences, non-blocking contention, per-lock provenance, complete failure cleanup, release durability, and fail-closed journal recovery.

The validation plan covers the relevant differential, crash, compatibility, filesystem, and performance gates. Ownership remains coherent: the CAS module owns batching and journal state transitions; reporting consumes only the final result.

The only approved retirement is the old crash hook together with its obsolete meaning. V1 parsing and existing recovery/durability guards remain protected until their stated evidence gates pass.

**Final confirmation: ALIGNED.**