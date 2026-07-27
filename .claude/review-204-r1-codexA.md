# REVIEW-204 — adversarial review of design 204 r1

1. **BLOCKER — REVIEW-103 item 11 is not discharged on the admission path that design 102 actually narrows.**

   **Evidence:** The claimed regression at `apps/api/test/workspace-sync-ws.test.ts:244-275` publishes inline `blobRefs`. Inline receipt commits always take full admission (`apps/api/src/workspace-sync.ts:647-659`); design-102 delta admission is used only for receipt-protocol sidecars (`apps/api/src/workspace-sync.ts:573-645`). In enforce mode, `computeCommitDelta` returns only `added + markedCarried` (`apps/api/src/workspace-sync.ts:348-354`), and `mergeAddedShas` merely counts an ordinary carried ref (`apps/api/src/commit-delta.ts:67-80`). Thus an unmarked carried ref whose catalog row has `present=0` is omitted from admission and can advance without the 422 on which design 204 Part A relies. The real-D1 test which demonstrates this harmful divergence runs only in shadow mode (`apps/api/test/commit-delta-shadow.test.ts:43-54,91-98`); there is no enforce integration test.

   **Disposition:** Do not unfreeze `RBOX_PREFLIGHT_DELTA` while enforce has this hole. Add a real sidecar/receipt/enforce regression with one introduced ref and one carried `present=0` ref, asserting 422 and no head movement, and change the mechanism so that test passes. If the product deliberately excludes unmarked catalog loss, state that narrower fault model and remove the REVIEW-103 discharge claim; a test alone cannot make the current mechanism safe.

2. **MAJOR — the blanket 422 backstop is also false on the legacy server branch.**

   **Evidence:** Receiptless inline commits call `missingBlobs` (`apps/api/src/workspace-sync.ts:661-673`). That helper treats a surviving `blob_refs` entitlement as “have” without joining `blobs` or requiring `present=1` (`apps/api/src/workspace-sync.ts:1270-1306`). A carried ref with `present=0` and an entitlement is therefore accepted. This differs from receipt admission, whose predicate explicitly joins `blobs` and checks `present=1` (`apps/api/src/commit-accounting.ts:91-145`).

   **Disposition:** Either make legacy commit admission present-aware and pin it, or prove that every client on which the new default can execute necessarily uses receipt admission and scope the safety proof to that protocol. The current “receipts branch vs legacy branch” statement is not true.

3. **MAJOR — physical pack loss is not detected by preflight or commit admission.**

   **Evidence:** Receipt admission trusts catalog state (`blobs.present`, entitlement, and fences) at `apps/api/src/commit-accounting.ts:103-145`. `/blobs/check` does the same at `apps/api/src/blobs.ts:136-170`. Actual packed-object existence and hash are checked only on blob read (`apps/api/src/blob-pack.ts:122-134`). If pack/R2 bytes disappear while catalog metadata remains healthy, no commit-time 422 is produced.

   **Disposition:** Narrow Part A's proof to cataloged loss and the modeled GC/prune state machines. Remove “pack loss” from the 422-covered examples and specify the separate detection/repair contract for catalog-vs-storage divergence.

4. **MAJOR — Part A's “one flag read site” is contradicted by the code, so the proposed edit can leave the pipeline arm opt-in.**

   **Evidence:** `RBOX_PREFLIGHT_DELTA` is read independently in the pipeline branch at `src/cli/sync-recovery.ts:184-203` and in the nonpipeline branch at `src/cli/sync-recovery.ts:295-315`. `pipeline.ts:437-480` only consumes the threaded boolean; it does not read the environment. Editing only the cited `sync-recovery.ts:295` site does not flip large publishes which select the pipeline.

   **Disposition:** Read the flag once before branch selection and thread it into both arms, or explicitly specify both reads and behavior-test both arms. Update the cited seam and the “same read” claim.

5. **MAJOR — repair does not force the full preflight audit claimed in §3.2.**

   **Evidence:** Push state initializes `forceFullAudit: false`; repair initializes only `forceSnapshot` (`src/cli/sync/push.ts:283-299`). The only later path to `forceFullAudit` is recovery-accumulator overflow (`src/cli/sync/push.ts:371-378`). Genesis similarly relies on `toEncrypt` being approximately the whole tree; it is not formally a full audit.

   **Disposition:** Either remove repair from the full-audit assertion and make the narrower fault model explicit, or set the latch for repair and add the corresponding test. Describe genesis as candidate-set equivalence, not as `forceFullAudit`.

6. **MINOR — Part A's required assertions and pipeline telemetry do not match the implemented sets.**

   **Evidence:** A recovery retry checks introduced candidates plus the union of every accumulated recovery page (`src/cli/sync-recovery.ts:307-315`; `src/cli/sync/push.ts:371-378`), not “exactly the residue.” Pipeline mode records `introduced = args.toEncrypt.length` while its check batches deduplicate addresses (`src/cli/publish-pipeline/pipeline.ts:205-220,435-480`); nonpipeline `introduced` is the unique post-defer address count.

   **Disposition:** Assert the precise union, not exact residue. Give `introduced` one definition across both arms (prefer unique post-defer addresses) and test convergent duplicates and deferrals.

7. **BLOCKER — a structurally valid but mismatched `manifestMeta` can publish an unreadable delta; the asserted sequence-gap/base-validity guard does not exist.**

   **Evidence:** `validManifestMeta` validates shape, counters, chain syntax, and the git map, but never binds `manifestHash` to `manifestFromMeta(...)` (`src/cli/sync-state-model.ts:96-122`). Push defines `appliedSequence = state.lastSyncedSequence` (`src/cli/sync/push.ts:461-467`) and then tests `state.lastSyncedSequence === appliedSequence` when selecting the base (`src/cli/sync/push.ts:773-778`), which is tautological and detects no gap. `encodeDeltaEnvelope` diffs the reconstructed base while copying the supplied trusted `baseManifestHash` without verifying the two agree (`src/engine/manifest-delta.ts:338-365`). The server cannot inspect the encrypted relationship (`apps/api/src/workspace-sync.ts:458-482,595-645`). An honest reader later checks the base hash while folding and can fail (`src/engine/manifest-delta.ts:487-489`), after the bad head is committed.

   **Disposition:** Before delta selection, require `canonicalManifestHashStreaming(reconstructedBase) === manifestMeta.manifestHash`; add explicit sequence binding if “sequence gap” remains a precondition. Any mismatch must snapshot. Add a structurally valid stale/corrupt pair regression through a real push and reader fold.

8. **MAJOR — the proposed snapshot master kill switch does not force raw-v0 on repair, so Part B is not a two-seam-only change.**

   **Evidence:** The proposed `mdeWriteCaps` can make `snapshotEnabled=false`, but encoding still selects a snapshot whenever `options.forceSnapshot` is true (`src/cli/e2ee-remote.ts:769-795`). Repair always supplies that option (`src/cli/sync/push.ts:779-785`). This contradicts both design 204's “forces raw-v0” rule and design 149's precedence ruling (`docs/design/149-storage-economics.md:318-337`; `docs/design/REVIEW-149.md:442-449`).

   **Disposition:** Specify and implement raw-v0 as the chain-free repair encoding when `RBOX_MDE_SNAPSHOT=0`, including the contradictory delta-on pair and warn-once behavior. Expand the touch list beyond the two flag comparisons and test repair under the master kill.

9. **MAJOR — the `fastFoldBase` claim and required test prescribe the opposite of design 106.**

   **Evidence:** Exact same-head evidence requires full identity equality and returns without fetching (`src/cli/e2ee-remote.ts:188-208`). For an advanced head, however, the reader intentionally accepts the persisted chain as an exact prefix and folds only the suffix plus head (`src/cli/e2ee-remote.ts:264-303`). Design 106 explicitly specifies that grown-chain hit (`docs/design/106-manifest-fold-fix.md:112-159`), and `src/cli/e2ee-sync.test.ts:1209-1237` pins it.

   **Disposition:** Replace test 9 with: exact same head is a zero-fetch hit; a correctly grown chain is an evidence-prefix hit; substituted, reordered, or non-prefix evidence misses or fails closed. Do not add a grown-chain-miss regression.

10. **MAJOR — the claimed receive-side download win is conditional on a separate flag which remains opt-in.**

   **Evidence:** Pull supplies `fastFoldBase` only when `RBOX_MDE_FAST_PULL === "1"` (`src/cli/sync/pull.ts:89-101`). Without it, `decodeManifestAt` performs the cold chain walk (`src/cli/e2ee-remote.ts:306-324`). Existing coverage distinguishes those cases (`src/cli/e2ee-sync.test.ts:952-976`). Defaulting delta writes alone can therefore make a default receiver fetch the head plus its historical chain/snapshot, rather than only the small new link.

   **Disposition:** Make the expected receive AE improvement explicitly conditional on FAST_PULL, or bring its default flip into scope with a separate safety review and kill switch. Do not use that receive improvement as acceptance evidence for the Part B flip as currently scoped.

11. **MAJOR — the chain-cap and economic-fallback tests cited as likely existing do not pin the real mechanisms.**

   **Evidence:** The current test injects a synthetic max-length chain containing duplicate self SHAs and separately sets `chainBytes=snapshotBytes` (`src/cli/e2ee-sync.test.ts:470-489`). It does not create 16 valid linked delta commits, prove the next commit snapshots, or construct a real candidate whose encrypted bytes lose the economic comparison. The code permits 16 consecutive deltas (`src/cli/e2ee-remote.ts:769-782`), so §4.2's “snapshot every ≤16 commits” is also inconsistent with test 7's correct “16 deltas, then snapshot” wording.

   **Disposition:** Keep both tests mandatory and make them end-to-end. Say “at most 16 consecutive deltas; the following commit snapshots,” not “a snapshot every ≤16 commits.”

12. **BLOCKER — C1 incorrectly classifies all lineage work as journal-only.**

   **Evidence:** With no journal, the current pre-loop still derives `publisherAckBindings` from repository identity and state lineage (`src/cli/sync-git/plan.ts:400-413`). Later absence-capture compares that binding against the follower protocol (`src/cli/sync-git/plan.ts:1069-1091`), pending supersession requires it (`src/cli/sync-git/plan.ts:1228-1245`), and accepted push state consumes it for publisher acknowledgements (`src/cli/sync/push.ts:966-986`). Moving the whole cluster behind journal presence changes no-journal absence and supersession semantics, contradicting §5.3.

   **Disposition:** Separate journal-only recovery inputs from independently demanded binding/lineage inputs. Preserve lazy demanders explicitly and add no-journal absence-capture and pending-supersession regressions, not only syscall-count coverage.

13. **MAJOR — C1 omits design 203's authoritative mutation-time journal recheck.**

   **Evidence:** Design 203 calls its initial existence probe advisory and requires every mutating arm to recheck under the common-dir chain lock (`docs/design/203-lazy-git-apply-probes.md:60-64`). Design 204 specifies only the pre-loop probe and present-at-entry fidelity test. Push planning later mutates conflict refs in stage 5 (`src/cli/sync-git/plan.ts:1261-1290`).

   **Disposition:** State the lock-held recheck for every planner mutation, or prove from the workspace mutex and every journal producer that a journal cannot appear during planning. Add the probe-to-mutation race test either way.

14. **BLOCKER — a whole-plan `repoCtxFromDisk` memo can direct stage-5 mutation through stale repository identity.**

   **Evidence:** Today stage 5 deliberately re-derives context immediately before choosing `commonDir` and calling `pruneConflictRefs` (`src/cli/sync-git/plan.ts:1267-1289`). C2 proposes reusing context obtained much earlier around `plan.ts:378/458/502`. A `.git` pointer or repository replacement during the intervening asynchronous capture/proof work can make the memo refer to the old common directory.

   **Disposition:** Do not carry an unversioned context across mutation boundaries. Revalidate `.git` shape/context under the mutation lock, or scope the memo to read-only stages and add a repository/worktree-replacement race test.

15. **MAJOR — the cross-repo common-directory fingerprint memo is not a point-in-time-equivalent optimization.**

   **Evidence:** A fingerprint combines a memoized common-directory token with freshly read per-worktree/git-dir state (`src/cli/sync-git/fingerprint.ts:265-307,349-375`). The current `per-decision` policy clears common tokens when moving to another repo (`fingerprint.ts:304-307`). Under `cross-repo`, a shared ref can move after worktree A's read but before worktree B's decision; B can combine the old common token with fresh local state and satisfy the cache/racy-clean hit predicate (`src/cli/sync-git/divergence-cache.ts:112-114,258-277`), missing the ref move.

   **Disposition:** Drop this separable lever, or bracket/version the entire common-dir group and retry on mutation. Add a deterministic “ref moves between linked-worktree decisions” test; the static clean/ref/index matrix is insufficient.

16. **BLOCKER — C3 acknowledges candidate discovery after plan completion rather than after successful publication.**

   **Evidence:** Design 204 §5.2 says the set is cleared when a consuming plan completes. Planning finishes at `src/cli/sync/push.ts:526-545`; upload and commit occur later, and conflict/epoch/422 paths can retry (`src/cli/sync/push.ts:825-914`). If the candidate is cleared and that publication fails, the retry's `base ∪ pending ∪ candidates` no longer contains the new repo and no watcher event is required to repeat. This is not equivalent to design 202's safely replaceable read-view consumption.

   **Disposition:** Generation-token the handoff and acknowledge it only after accepted commit/state acknowledgement, or derive every candidate set from durable/registry inventory. Test 409, epoch-stale, 422, process restart, and failure between plan and commit.

17. **BLOCKER — atomic rename of a fully formed repository is not covered by the candidate detector.**

   **Evidence:** `classifyRepoCandidate` recognizes only an event whose exact path is `.git` or ends in `/.git` (`src/cli/daemon/git-ref-watch.ts:69-85`). Parcel forwards events individually and gives no guarantee that renaming a populated directory emits descendant `.git` creation events (`src/cli/daemon/watcher.ts:331-380`). A create/rename event for `dst/` is ordinary file-plane work. By contrast, full discovery descends through repository boundaries and recognizes nested repositories (`src/engine/git-discover.ts:14-32,46-63`). An ignored-to-included rename is the sharpest instance.

   **Disposition:** Conservatively enqueue targeted subtree discovery for directory create/rename, or poison delta trust and walk. Add real-backend tests for an atomic ordinary-repo rename, a directory containing nested repos, and ignored-to-included movement.

18. **MAJOR — candidate verification is underspecified and weaker than current discovery for submodules and worktrees.**

   **Evidence:** C3 carries only `Set<string>` and proposes an `lstat` before admission. Current discovery inspects `.git` itself and distinguishes a real directory from a gitfile pointer (`src/engine/git-discover.ts:5-12,46-55`); submodule init and `git worktree add` create the pointer form. An owner-directory lstat neither proves repository shape nor supplies `kind`.

   **Disposition:** Run `discoverGitReposUnder` for every candidate (or an equivalent no-follow `.git` classifier returning `DiscoveredGitRepo`). Test stale/deleted candidates, ordinary repos, submodule init, worktree add, and symlinked `.git` refusal.

19. **MAJOR — restart/bootstrap cannot satisfy the proposed discovery trust predicate with current state.**

   **Evidence:** Startup begins an initial discovery walk before awaiting watcher subscription and later forwards only its repo list (`src/cli/daemon/watcher.ts:324-329,331-397`; `src/cli/daemon/daemon.ts:872-882`). The registry exposes owner watch states but no workspace-discovery-complete or continuously-armed-since generation (`src/cli/daemon/git-ref-watch.ts:122-131,251-263`). A repo created while the daemon was down, or in the scan-before-subscribe window, has no in-memory pending candidate; a restart also loses the claimed “since the last completed plan” history.

   **Disposition:** Force the first post-start plan to walk, or establish a generation-stamped complete discovery snapshot after continuous watch coverage begins and seed all base/pending-absent owners into the handoff. Add daemon-down and startup-window tests.

20. **BLOCKER — candidate-map overflow is dropped from C3's handoff/trust contract.**

   **Evidence:** The signal debouncer clears its candidate map and sets `discoverAll=true` at its own cap (`src/cli/daemon/watcher.ts:153-204`). The current consumer responds with a full `discoverGitRepos` walk (`src/cli/daemon/daemon.ts:901-913`). Design 204 mentions a pending flag/set and registry-owner `overCap`, but not `GitSignalBatch.discoverAll`; those are different caps and states. Treating the overflow batch as an empty set can omit every new repo in the burst.

   **Disposition:** Make `discoverAll` monotonically poison delta trust and force a walk until publication-generation acknowledgement. Add overflow followed by failed-plan/failed-commit retry tests.

21. **MAJOR — the stated C1/C2 savings, ≤0.5 s gate, and subphase-sum test are not supported by the correctness-preserving mechanism.**

   **Evidence:** C1 must retain non-journal lineage demanders (finding 12); C2's cross-repo sharing is unsafe as written (finding 15); independent repos still recursively fingerprint refs and packed-refs (`src/cli/sync-git/fingerprint.ts:265-287,329-375`). The proposed `discoverMs/journalMs/fingerprintMs/hygieneMs` buckets omit config, preflight, capture, proofs, and cache writes across `src/cli/sync-git/plan.ts:452-1260`, yet test 16 requires them to sum approximately to the whole phase.

   **Disposition:** Mark per-lever savings as hypotheses until measured, gate each lever independently, and add `otherMs` or complete non-overlapping brackets. Expand C3's tests to the rename, nested, ignore-transition, submodule, worktree, restart, overflow, discovery-error, and failed-consumption cases above.

The v1.1.0 reader floor is corroborated by the release history, the design-108 freeze is real (`docs/design/108-files-first-publish.md:561`), and the current manifest-chain roots path does include chain refs in folded sets/raw gaps and the GC union (`apps/api/src/workspace-sync.ts:841-858,1008-1027`; `apps/api/src/versions.ts:98-124`). Those facts do not close findings 7–11.

**Verdict: CHANGES-REQUIRED**
