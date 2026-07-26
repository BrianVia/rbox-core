# REVIEW-204 — review ledger for design 204

## Round 1 (2026-07-26) — 2× codex gpt-5.6-sol (medium) + 1× opus (medium), parallel wave

All three: **CHANGES-REQUIRED**. Raw reports: `.claude-review-204-r1-codexA.md`,
`.claude-review-204-r1-codexB.md` (worktree-local), opus report inline in the
session. Findings deduped across reviewers; rulings below are the orchestrator's
synthesis. Labels: A=codexA, B=codexB, O=opus.

### Part A (preflight delta)

| # | Finding (deduped) | Ruling |
|---|---|---|
| A1/B9/O3/O4 | Freeze not discharged: no enforce-mode endpoint regression exists (all carried-ref behavioral tests are shadow-mode); under enforce, ordinary carried refs are presence-checked by NEITHER side; the doc's "server admission is the authority" backstop argument is false as written; doc test 3 as worded is vacuous (a ref absent from parent refset is `added` by definition). | **ACCEPT (synthesis).** The safety argument is rebuilt on 102's fence probe (O3): prune-marked carried refs DO enter `admitData` and 422; over-cap and probe-skip fail closed to full admission. The unmarked-`present=0` carried-ref class is stated as an explicit narrowed fault model: no sanctioned server flow produces it (GC/prune always mark first); it requires out-of-band catalog correction, and the legacy commit branch does not detect it even today (A2). Posture change named in the doc: opportunistic re-upload of prune-marked blobs moves from every-push client preflight to server fence probe + `--verify`/`RBOX_PREFLIGHT_FULL=1` (REVIEW-103 r2 item 3's "proactive detection stays --verify"). HARD precondition: new enforce-mode endpoint regression (prune-marked carried ref → 422 with sha in `unsatisfiedBlobs`; probe over-cap → full-refset fallback). Test 3 rewritten per O4. |
| A2 | Legacy (receiptless inline) commit branch `missingBlobs` is not `present`-aware — "receipts vs legacy both 422" claim false. | **ACCEPT (doc correction).** Safety proof scoped to the fault model above; the legacy branch is no worse after the flip than before it (it never checked `present`). No server change. |
| A3 | Physical pack/R2 loss with healthy catalog is invisible to preflight and admission. | **ACCEPT (doc correction).** True today for the full sweep too (D1-only checks, all reviewers agree). Removed from the 422-covered examples; no regression, no new mechanism. |
| A4/B10/O5 | "One flag read site" false — two independent env reads (`sync-recovery.ts:185` pipeline arm, `:295` serialized arm). | **ACCEPT.** Hoist to one exported `preflightDeltaEnabled()`; both arms consume it; both arms tested; ambient cleanup covers `RBOX_PREFLIGHT_FULL` too. |
| A5 | Repair does not set `forceFullAudit` (only `forceSnapshot`); genesis is candidate-set equivalence, not an audit. | **ACCEPT.** Doc corrected; no behavior change (recovery-overflow latch is the only full-audit trigger, which is the designed behavior). |
| A6 | Recovery retry checks the union of accumulated pages, not "exactly the residue"; `introduced` defined differently across arms. | **ACCEPT.** Tests assert the union; `introduced` unified as unique post-defer addresses in both arms. |
| O11 | Existing `sync.test.ts:733-746,750-759` use `delete env` to select the legacy arm — inverted by the flip. | **ACCEPT.** Named as required updates (`= "0"` where legacy arm is the intent). |

### Part B (manifest delta commits)

| # | Finding | Ruling |
|---|---|---|
| A7 | BLOCKER: structurally-valid-but-mismatched `manifestMeta` publishes an unreadable delta — `validManifestMeta` never binds `manifestHash` to the reconstructed base; the "sequence gap" guard is tautological (`appliedSequence` is defined as `state.lastSyncedSequence`). | **ACCEPT.** New hard precondition before delta selection: `canonicalManifestHash(reconstructedBase) === manifestMeta.manifestHash`; any mismatch → snapshot + meta rewrite. Tautological guard removed from the doc's claims (the real staleness protections are the hash binding + epoch checks). Regression: structurally valid stale meta → snapshot emitted, reader folds clean. |
| A8/O14 | `RBOX_MDE_SNAPSHOT=0` does not force raw on repair (`forceSnapshot` bypasses it at `e2ee-remote.ts:769-795`); push seam re-reads the raw env var and does wasted `deltaBase` work under master kill; "flip `===1`→`!==0`" mis-describes a lattice inversion. | **ACCEPT.** One shared exported capability fn consumed at BOTH seams; under master kill, repair emits raw-v0 (chain-free) and push constructs no `deltaBase`; doc describes the lattice inversion (`delta⟹snapshot` becomes `snapshot⟹delta-eligible`). |
| A9/O6 | `fastFoldBase` claim backwards: a grown chain is design 106's delta-suffix HIT (`e2ee-remote.ts:264-305`), already pinned at `e2ee-sync.test.ts:774-785`. Pinning it as a miss would enshrine a cold walk on the hot path. | **ACCEPT.** Test 9 rewritten: exact head → zero-fetch; grown chain → suffix-only fetch (`fold:"evidence"`); substituted/reordered evidence → fail-closed. Verify-don't-duplicate vs `e2ee-sync.test.ts:774`. |
| A10 | Receive-side win requires `RBOX_MDE_FAST_PULL === "1"` (opt-in); a default receiver does the cold chain walk — head + chain links + terminal snapshot per pull, i.e. MORE bytes than today's single snapshot. | **ACCEPT-EXPANDED.** Flipping delta writes without the evidence fast-pull regresses default receivers, so `RBOX_MDE_FAST_PULL` default-on joins Part B's scope (design 106 shipped it; client-local read path; own kill switch `RBOX_MDE_FAST_PULL=0`). Serial gate must re-review this addition. |
| A11 | Chain-cap/economic tests cited as "likely existing" are synthetic (injected chain, forced byte equality); "snapshot every ≤16 commits" wording wrong. | **ACCEPT.** Both tests made end-to-end (16 real linked delta commits → 17th snapshots; real candidate losing the economic comparison → snapshot). Wording: "at most 16 consecutive deltas; the next commit snapshots." |
| B11 | Two seams must share one policy result; behavioral wire test can't catch a seam divergence. | **ACCEPT** (covered by A8/O14 ruling; plus the pinned no-`deltaBase`-under-master-kill assertion). |
| O12 | Warn-once needs a module-scope latch (`mdeWriteCaps` runs per op). | **ACCEPT.** |
| O16 | Burn-in needs the failure discriminator: snapshot walls on EVERY push = a `deltaBase` precondition failing, not compaction. | **ACCEPT.** Added to §7 with the precondition checklist. |

### Part C (git-plan)

| # | Finding | Ruling |
|---|---|---|
| O1 | BLOCKER: `mode:"delta"` starves `kindByPath` (`plan.ts:866` fast-path admission requires it) — every repo falls to the slow path and SPAWNS; the lever inverts its own goal. | **ACCEPT → C3 DEFERRED** (see below). |
| O2/B5 | BLOCKER: registry is Linux+Parcel only; the predicate can never fire on the Mac — the measured host. | **ACCEPT → C3 DEFERRED.** |
| A17/A18/A19/A20/B3/B6/B8/O10 | C3 topology blindness (renamed-in clone, submodule init nuance, ignore-rule transitions), unverified parcel descendant-event assumption, restart/bootstrap gap, candidate-cap `discoverAll` overflow, candidate verification weaker than discovery, synthetic tests. | **ACCEPT → C3 DEFERRED.** |
| A16/B4 | Candidate handoff must be epoch-stamped and ACKed on accepted publication, not plan completion. | **ACCEPT → carried into the C3 successor seed.** |
| O9 | `mode:"delta"` drops `onGitReposDiscovered` → `planDiscoveredGitDirOwners` + registry upserts + git safety-floor refresh silently stop. | **ACCEPT → C3 DEFERRED** (successor must preserve this contract). |
| **C3 disposition** | | **DEFERRED to a successor design** (unanimous across reviewers in effect; opus recommended the split explicitly). C3 requires: a backend-independent daemon-owned discovery-continuity state, verified parcel rename semantics ([[verify-dependency-source-on-load-bearing-assumptions]]), per-candidate shape probing that reconstructs `kindByPath`, publication-ACKed epoch handoff, and preservation of the safety-floor contract. That is its own cycle, informed by C5's measured buckets. All round-1 evidence is banked here and in the raw reports. |
| A15/B2/B7 | BLOCKER: cross-repo common-dir memo produces false trusted hits after mid-plan shared-ref mutation; widens the racy-clean window from point-in-time to whole-plan; existing hand-invalidations (`plan.ts:1288`, comment `:1294-1295`) prove invalidation is correctness-bearing; value ~0 without linked-worktree density evidence. | **ACCEPT.** Lever **DROPPED** (the doc pre-authorized exactly this). |
| A12/B1/O8 | BLOCKER: C1 mis-scoped — `publisherAckBindings` (absence proofs `plan.ts:1086-1090`, pending supersession `:1231-1240`, publisher-ACK authoring `push.ts:966-985`), the `!ctx` quarantine arm (`:393-399`), and `recoveryAllowsSupersession` are NOT journal-only work. | **ACCEPT.** C1 narrowed: only `checkoutJournalBinding` + `recoverAndLandFollowJournal` (`plan.ts:418-419`) gate on `checkoutJournalPresent`. Everything else in the pre-loop stays eager. Savings estimate re-derived (~2-4 syscalls/repo net of the probe lstat, not 10-14). |
| A13 | Design 203 requires mutation-time journal recheck; plan stage-5 mutates conflict refs. | **ACCEPT-MODIFIED.** Stage-5 conflict-ref pruning consumes no journal state; the doc states the containment argument explicitly (journal consumption is confined to the pre-loop; the workspace mutex serializes journal producers) and adds the probe-to-mutation race test to prove it. |
| A14/O13 | Whole-plan ctx memo can serve stale identity across the capture boundary; call-site count wrong (8, not 4); `plan.ts:1294-1295` warns about exactly this. | **ACCEPT.** Memo scoped to the read-only stages (pre-loop + stage 2 decision reads); invalidated at the capture boundary; stage 5 keeps fresh derivation. Call-site inventory corrected. |
| A21/B12/B13 | Savings claims unsupported; bucket-sum test invalid without exclusivity/`otherMs`; fingerprint's internal `repoCtxFromDisk` unaffected by an outer memo without an API change. | **ACCEPT.** Per-lever savings restated as hypotheses C5 will measure; `otherMs = totalMs − Σ exclusive buckets` added; bucket test asserts finite/nonnegative/bounded, not sum≈wall. No fingerprint API change in this cycle. |
| O15 | Bare file anchors ambiguous. | **ACCEPT.** Fully qualified. |

### Round-1 outcome

r2 scope: **A (hardened) + B (hardened, + FAST_PULL default-on) + C-reduced
(narrow C1, scoped read-only memos, realpath hoist, C5 attribution) in
v1.10.0; C3 (delta discovery) and the cross-repo common-dir memo are OUT,
deferred with their evidence to a successor design.**

## Round 2 (2026-07-26) — serial gate, codex gpt-5.6-sol (medium)

Verdict: CHANGES-REQUIRED (1 HIGH, 3 MEDIUM, 2 LOW — strictly narrower than
round 1; converging). Raw report: `CODEX-204-R2-SERIAL.md` (worktree-local).

| # | Finding | Ruling |
|---|---|---|
| 1 | HIGH: FAST_PULL default-on opens a persisted-corruption wedge — grown-chain path trusts persisted `manifestHash` without re-hashing; fold failure → `ManifestChainError` → daemon repair's cold probe succeeds → retry reuses the same corrupt evidence (escapes the one-level catch at `src/cli/daemon/daemon.ts:2226`). | **ACCEPT.** r3 rule: any evidence-fold failure is a cold-walk miss WITHIN the same pull (retry without evidence; cold walk self-heals persisted state); only cold-walk failure raises `ManifestChainError`. New test 9b (real pull, repair catch not entered). Chose fallback over pre-hashing to keep steady state at zero extra cost. |
| 2 | MEDIUM: default-on `recordEvidence` forces meta collection under `RBOX_MDE_SNAPSHOT=0`; raw-v0 decode synthesizes `manifestMeta`; mixed-fleet expectation at `src/cli/e2ee-sync.test.ts:704` inverts. | **ACCEPT (behavior ruled fine, made explicit).** Synthesized meta from a raw head is harmless and keeps evidence live during an emergency raw window. Test 9c names the required update. |
| 3 | MEDIUM: O16 discriminator still non-exhaustive (economic rejection, kill switches, repair also cause persistent snapshots). | **ACCEPT.** Writer logs `mde snapshot cause=<policy\|no-base\|integrity\|force\|economic\|chain-cap>` on every non-delta commit (small implementation addition); §7 rewritten around the enum. |
| 4 | MEDIUM: test 3 named a nonexistent wire field — endpoint returns `error:"unsatisfied_blobs"` + `missing`/`missingTotal` (`apps/api/src/commit-envelope.ts:31`); `unsatisfiedBlobs` is the client-side name. Harness: `testEnv` must accept `"enforce"`; over-cap needs 50,001 markers (bulk insert). | **ACCEPT.** §3.1 + test 3 corrected; harness notes folded. Gate confirmed the regression is otherwise writable in the current harness. |
| 5 | LOW: O15 anchor-qualification was a silent no-op in r2; plus exact errors (economic guard :782 not :781; journal pair :419-420 not :418-419; `e2ee-remote.ts:77-83` is history, not reader-support evidence). | **ACCEPT.** All named anchors fixed; remaining bare anchors qualified; reader-support evidence re-anchored to the decode path (`src/cli/e2ee-remote.ts:160-305`). |
| 6 | LOW: C2 mis-stated `plan.ts:502` as a stage-2 read — it runs inside `captureWithConfig` post-capture (invoked from `:1000`). | **ACCEPT.** §5.4 rewritten: memo covers `:378,458` only, cleared before the capture pool; `:502`, `:1271`, `:1281` are fresh post-boundary derivations. |

Gate also verified with no findings: all other round-1 rulings materially
folded; §3.2 fault-model narrowing matches admission reality;
`canonicalManifestHash` exists (`src/engine/manifest-delta.ts:195`, sync
helper `canonicalManifestHashStreaming` at `:96`) and closes the A7 hole;
raw-v0 readable everywhere incl. doctor's `chainDiagnostic`; C1-narrow
matches `plan.ts` dependencies.

## Round 3 — focused re-check of the round-2 folds: pending
