# Review 141 — Git-shapes burn-in

## Verdict: CHANGES-REQUIRED

The proposed burn-in belongs in the rig, and most individual Git/filesystem
observations are possible through `Device.exec`. The design is not implementable
as written, however: its expected-failure mechanism does not exist, several
claimed outcomes are already contradicted by the engine, the macOS cell is still
two Linux guests, and the S5 lifecycle does not establish human-local operation
state. Design 138's two safety rules are represented accurately, but halt
detection needs to follow that draft's status/health contract rather than depend
on a daemon log.

## Findings

1. **BLOCKER — `knownFinding` has neither the claimed precedent nor a harness
   contract.** Design 141:97-101 says a failing assertion can remain green via
   `knownFinding`, citing a “known-races set.” `ScenarioReport` has only
   `PASS | FAIL | SKIP`, and any false assertion makes the report fail
   (`scripts/rig/scenarios/types.ts:66-101`); a failed report exits 1 both alone
   and in the suite (`scripts/rig/rig.ts:308-353`). The only rig “known race” is
   prose explaining why `chaos-restart` is omitted from `FAST_SUITE`
   (`scripts/rig/scenarios/index.ts:25-35`). Even the
   `EXPECTED-FAIL-TOLERANT` type-flip scenario asserts the healed state and fails
   otherwise (`scripts/rig/scenarios/type-flip.ts:81-108`). Define a typed
   `KNOWN-FINDING`/`XPASS` model, its exit semantics, and report rendering, or
   make each already-known engine refusal an ordinary passing expected outcome.

2. **MAJOR — two claimed rig conventions are false and would misdirect the
   implementation.** Design 141:18-23 says “per-scenario containers” and calls
   pure fixture builders “exactly like `git-entanglement`.” The rig actually
   creates/reuses the fixed `rig-dev-a`/`rig-dev-b` pair
   (`scripts/rig/lib/config.ts:13-19`; `scripts/rig/rig.ts:106-143`) and explicitly
   resets the same containers between scenarios (`scripts/rig/rig.ts:160-175`).
   `git-entanglement`'s builder is an impure async `Device` shell execution in the
   scenario, not a pure library seam (`scripts/rig/scenarios/git-entanglement.ts:55-102`).
   The `rig=1`/no-global-prune statements are valid
   (`scripts/rig/lib/container.ts:548-552`; `scripts/rig/lib/gc.ts:1-4`). Restate
   the convention as reused guests plus per-scenario guest reset/fresh account,
   and define purity as a command/tree description separated from its executor.

3. **MAJOR — fidelity clause 4 is not a pinned, single assertable contract.**
   Deferrals are observable in durable state and human/JSON status, as the
   existing scenario proves (`scripts/rig/scenarios/git-entanglement.ts:465-494`;
   `src/cli/status-cmd.ts:486-503`). “Drift alert” is undefined, however: the
   generic fingerprint deliberately excludes `.git`
   (`scripts/rig/lib/convergence.ts:27-49`), while daemon drift audit is a
   separate deep-scan/log mechanism (`src/cli/daemon/daemon.ts:1818-1926`) and
   capture is best-effort/non-verdict (`scripts/rig/rig.ts:250-252`). Likewise,
   the cited settlement proof merely bounds `lastSyncedSequence` and checks a
   third idle cycle (`scripts/rig/scenarios/git-entanglement.ts:331-348`); it does
   not prove publisher-ACK authority or retirement of pull-side P/K artifacts.
   Publisher ACKs are persisted as `advertised` plus `publisher-ack` provenance
   only after an accepted response (`src/cli/config.ts:260-280`;
   `src/cli/sync/push.ts:674-713`), and P/K retirement is a later state-CAS/ref
   transaction (`src/cli/sync-git/p-settlement.ts:76-157`;
   `src/cli/sync/pull.ts:271-305`). Define clause 4 as exact checks: a named
   status/state divergence signal, the JSON deferral set, per-device sequence
   checkpoints, expected `advertised`/origin state, and absence of
   pending/partial/P/K artifacts.

4. **BLOCKER — S1's full-fidelity hypothesis is already impossible under the
   supported-shape contract.** Design 141:51-58 requires the parent gitlink
   index, raw submodule `.git` pointers, and `.git/modules` interior to round-trip.
   Raw `.git` files and directories are unconditionally excluded at every depth
   (`src/engine/ignore.ts:8-17,231-245`), and a superproject with `.git/modules`
   is a structural refusal (`src/engine/git/preflight.ts:22-28,57-62`) already
   pinned by a test (`src/engine/git-nested.test.ts:196-201`). An independently
   discovered pointer repo received on a fresh machine is deliberately
   materialized with `git init` as a standalone dir repo, not as the sender's
   pointer layout (`src/engine/git/apply.ts:253-268,406-424`). Specify exact loud
   structural refusal for the parent and separate outcomes for independently
   discovered nested repos; do not land “full fidelity” as a known failing cell.

5. **BLOCKER — S2 cannot provide `.git/lfs/objects` fidelity, and its install
   matrix is not the topology the design names.** Design 141:59-67 makes the LFS
   object store a fidelity artifact and expects full fidelity with LFS installed
   on both machines. The file plane excludes it, while native Git capture uploads
   only bundle, index, and allowlisted op-state (`src/engine/ignore.ts:231-245`;
   `src/engine/git/capture.ts:207-221,274-295`); a bundle carries the committed
   pointer blob, not the external LFS payload. `filter.lfs.*` is also outside the
   synced config allowlist (`src/engine/git/config-sync.ts:13-21`). In addition,
   both devices use the same image (`scripts/rig/rig.ts:120-141`), so adding
   `git-lfs` to `scripts/rig/Dockerfile:14-19` installs the executable on both.
   Replace “A only” with a precisely constructed filter-config/PATH cell, assert
   pointer bytes via `git cat-file` separately from plain-plane worktree binary
   bytes, and expect the LFS cache to be absent unless an explicitly observed
   git-lfs side effect recreates it. Such recreation is not rbox byte fidelity.

6. **BLOCKER — S3's Linux case-collision cell cannot produce a valid manifest.**
   Design 141:68-74 expects `Readme.md` and `README.md` to reach B on Linux, but
   manifest validation rejects the second case-insensitive duplicate on every
   platform (`src/engine/manifest-validate.ts:146-161`). The tracked worktree
   files travel in the plain-file manifest, so the push fails before the Git
   index's receiver-equivalence path is exercised. Split the case pair from the
   NFC/NFD byte-preservation cell and declare the exact manifest refusal. For the
   feasible NFC/NFD Linux proof, emit UTF-8 pathname bytes as hex in the guest;
   `Device.exec` returns decoded stdout (`scripts/rig/lib/device.ts:125-135`), so
   comparing display strings is not a byte pin.

7. **MAJOR — the declared Linux-to-macOS S3 cells are not runnable with zero new
   code.** Both runtime backends run the same Ubuntu image
   (`scripts/rig/Dockerfile:1-6`), and `/work/ws` is explicitly container-local
   (`scripts/rig/lib/config.ts:24-30`). Running that Linux guest through Apple
   `container` does not put its workspace on the host's normalizing APFS, and
   `Scenario`/`RigCtx` has no native-mac device kind
   (`scripts/rig/scenarios/types.ts:11-51`). The dormant cells need a native-mac
   backend or a reviewed host-filesystem mount and platform metadata; merely
   marking them runnable on the Mac host cannot test normalization behavior.

8. **MAJOR — S4 shallow behavior is settled code, not an outcome to discover.**
   Design 141:75-81 generically accepts clause 6, but preflight returns the exact
   structural shallow refusal and unshallow hint
   (`src/engine/git/preflight.ts:43-50`), the planner drops/not-captures that
   section loudly (`src/cli/sync-git/plan.ts:506-536`), and the integration test
   already pins drop, log visibility, and post-drop zero divergence
   (`src/cli/sync-git/git-sync.test.ts:1882-1927`). Specify that exact expected
   outcome. The builder must use a `file://` source—plain local-path clones ignore
   `--depth`, as the existing fixture precedent reflects
   (`src/cli/sync-git/git-sync.test.ts:1900-1903`)—and a valid shallow repo does
   not inherently owe an `fsck` complaint.

9. **MAJOR — S4's partial-clone fixture silently removes the condition it claims
   to burn in and cannot preserve its listed config artifact.** Preflight comments
   mention partial/promisor stores but implement only shallow, modules, and
   alternates checks (`src/engine/git/preflight.ts:43-68`). Capture runs
   `git bundle create` without `GIT_NO_LAZY_FETCH`
   (`src/engine/git/shared.ts:75-93`; `src/engine/git/capture.ts:237-253`), whereas
   graph safety explicitly disables lazy fetch so missing objects remain evidence
   (`src/engine/git/reachability.ts:25-32`). With the proposed available local
   origin, bundling hydrates promised blobs; the cell can pass after ceasing to be
   an incomplete-object test. Meanwhile `remote.*.promisor`,
   `remote.*.partialclonefilter`, and `extensions.partialClone` are outside the
   config allowlist, and `file://` remote URLs are rejected
   (`src/engine/git/config-sync.ts:13-21,126-135`). Require
   `uploadpack.allowFilter=true`, pre/post missing-object assertions, and an
   unavailable-origin/no-lazy-fetch arm. design 146 supersedes the initial
   silent-hydration classification: corrected observation shows no hydration and
   no engine gap. Remove “promisor config lines round-trip” from the expected
   artifact set.

10. **BLOCKER — S5's bisect cell is invisible to the engine, so the expected
    deferral is false.** The exhaustive op-state universe contains merge, rebase,
    cherry-pick/revert, breadcrumbs, and sequencer state, but no `BISECT_*`
    (`src/engine/manifest-validate.ts:226-248`); `refs/bisect/*` is also outside
    the syncable ref namespaces (`src/engine/manifest-validate.ts:261-264`).
    Identity/follow classification consequently cannot raise `local-operation`
    for bisect (`src/engine/git/identity.ts:21-35`;
    `src/cli/sync-git/follow.ts:435-448,479-498`). Byte-stable leftover BISECT
    files could therefore coexist with sync-mutated HEAD/index and falsely look
    safe. Make this an explicit already-known finding and assert semantic bisect
    status/HEAD/index/ref invariants, or remove it pending an engine design.

11. **BLOCKER — the universal fixture sequence makes S5's “op state is NEVER
    mutated” expectation false even for supported operations.** The shared flow
    says A creates the in-progress fixture and B materializes it
    (design 141:27-29), so B's op-state initially equals BASE. Follow defers only
    when live op bytes differ from both BASE and incoming
    (`src/cli/sync-git/follow.ts:435-447`); a later incoming section may
    legitimately replace/delete BASE op-state during the checkout transaction
    (`src/cli/sync-git/follow.ts:1128-1195`;
    `src/engine/git/checkout-txn.ts:742-756`). Tests pin both behaviors: incoming
    `MERGE_HEAD` is applied (`src/cli/sync-git/follow.test.ts:244-261`), while an
    operation started locally after BASE defers unchanged
    (`src/cli/sync-git/follow.test.ts:859-877`). Give S5 a different lifecycle:
    establish a clean shared BASE, start the operation only on the receiver,
    advance the other machine, and pull into the operation holder. Also allow
    safe-ref/config partial progress, which intentionally precedes checkout
    classification (`src/cli/sync-git/follow.ts:938-1002`), while pinning only
    checkout/index/op-file non-mutation across retries.

12. **MAJOR — the design-138 rules are substantively correct, but unexpected
    halt detection is incomplete.** The single-stream/no-manufactured-journal
    rules in design 141:103-121 agree with the in-flight draft's mismatch,
    authorization, and physical-classification boundaries
    (`138-DRAFT-REFERENCE.md:40-101`, a review-time draft snapshot; the merged
    doc is `docs/design/138-reset-path-hardening.md`). The draft also makes classification an
    operation-boundary gate, suppresses repeated halted work/logging, and keeps a
    degraded status/health JSON path live (`138-DRAFT-REFERENCE.md:121-156`). A
    cell may therefore stop before producing an outcome and need not emit a fresh
    daemon line. Probe status/health at every operation timeout and cell boundary;
    classify `halted` or `recovering` as a finding with status/side-file/run-log
    evidence. Keep the root draft reference-only; this review cites it but does
    not make it an implementation input or copy it into the design.

13. **MINOR — the findings sidecar path/schema does not match the rig report
    model.** Design 141:91-100 names `scripts/rig/runs/<ts>/...`, while the harness
    creates `runs/<timestamp>-<scenario>` and exposes that exact directory as
    `ctx.runDir` (`scripts/rig/rig.ts:203-239`). The report has no outcome-class
    field (`scripts/rig/scenarios/types.ts:66-77`;
    `scripts/rig/lib/report.ts:36-75`), although a file written into `ctx.runDir`
    will be included in the artifact index (`scripts/rig/lib/capture.ts:393-408,497-505`).
    Pin the sidecar to `ctx.runDir/git-shapes-findings.md` and decide whether the
    outcome table remains a sidecar or extends `ScenarioReport`; coordinate that
    choice with finding 1's typed known-finding semantics.

## Round 2 — Verdict: CHANGES-REQUIRED

Round 1's reframe is directionally accepted: `knownFinding` is gone, the real
rig topology and sidecar path are used, macOS cells are removed, settled
shallow/case refusals are named, and S5 now starts operations on the receiver.
However, the common lifecycle is impossible for refusal cells, and several
cells still do not pin today's exact observable outcome. Those change the
scenario implementation and assertions, so the design is not aligned yet.

### Round-1 closure audit

- **Closed:** f1, f2, f6, f7, f8, f12, f13.
- **Still open in build-changing ways:** f3, f4, f5, f9, f10, f11, as detailed
  below.

### Findings

1. **BLOCKER — the universal fidelity lifecycle cannot run for refusal cells.**
   Design 141:35-54 requires every cell to materialize B, run Git status/fsck,
   and make a B-side branch commit. But S1(a) and S4(a) intentionally omit/drop
   the native Git section after structural preflight
   (`src/engine/git/preflight.ts:48-61`;
   `src/cli/sync-git/plan.ts:523-536`), leaving B without the asserted Git
   repository, while S3(b) rejects the manifest before B can receive the tree
   (`src/engine/manifest-validate.ts:146-161`). Those cells cannot execute
   clauses 1, 2, or 5. Scope clauses 1-5 to materialization cells and define a
   separate refusal lifecycle (including its exact settle/no-republish proof).
   Round-1 f3 is therefore only partially closed.

2. **MAJOR — S1(c) still delegates the contract to implementation-time
   observation.** Design 141:72-73 says to assert “whatever preflight/plan does
   today.” An uninitialized gitlink has no `.git/modules`, so it does not hit the
   only superproject structural check (`src/engine/git/preflight.ts:57-62`). The
   design must state whether normal capture/materialization occurs and pin B's
   gitlink, worktree, status, and bidirectional outcome. “Whatever” is not an
   implementable exact assertion, leaving f4 open.

3. **MAJOR — S2's receiver construction does not select one observable LFS
   contract.** “Unconfigured” and “PATH-masked” are distinct fixtures with
   potentially different status/error behavior. LFS filter config cannot travel
   through rbox (`src/engine/git/config-sync.ts:13-21`); pull applies plain-plane
   bytes before native Git (`src/cli/sync/pull.ts:201-207,252-266`), and checkout
   publishes the captured index without invoking a smudge filter
   (`src/engine/git/checkout-txn.ts:743-756`). An unconfigured B can therefore
   hold binary worktree bytes against an index whose blob is the pointer and
   report the file modified, whereas a configured-but-masked filter may fail
   differently. Pin one construction and its exact `git status`, error, and cache
   outcome. F5 is not fully closed.

4. **MAJOR — S4's partial-clone arms remain conditional, not pinned.** Design
   141:97-104 says “if bundling hydrates” and to assert behavior “exactly as
   observed.” Preflight currently rejects shallow repositories but has no
   partial/promisor check (`src/engine/git/preflight.ts:43-50`); capture invokes
   `git bundle create` without `GIT_NO_LAZY_FETCH`
   (`src/engine/git/capture.ts:242-253`; `src/engine/git/shared.ts:75-93`), and a
   bundle failure becomes a capture deferral (`src/cli/sync-git/plan.ts:794-808`).
   Pin the pre/post missing-object state and exact available-origin and
   unavailable-origin result, including deferral category and public surface.
   The current discovery language contradicts the design's “today's exact
   contract” reframe, so f9 remains open.

5. **BLOCKER — bisect invisibility does not imply that no deferral fires.**
   `BISECT_*` and `refs/bisect/*` are indeed outside the op-state/ref universes
   (`src/engine/manifest-validate.ts:226-264`), but follow independently checks
   the applied-manifest oracle, semantic index, and current-tip ownership
   (`src/cli/sync-git/follow.ts:408-459`). A normal bisect checks out an older
   candidate and can therefore defer as `local-edits` or `local-index` even
   though it cannot produce `local-operation`. Specify a fixture (for example,
   identical-tree/empty commits) that demonstrably avoids those gates, or assert
   the ordinary deferral actually produced. The claimed “NO deferral” contract
   does not follow from the cited code, leaving f10 open.

6. **BLOCKER — real supported S5 operations do not generally display
   `local-operation`.** Mid-merge/rebase/cherry-pick conflict fixtures normally
   leave changed worktree or index state. The oracle then adds `local-edits`
   (`src/cli/sync-git/follow.ts:408-410`) while op-state also adds
   `local-operation` (`src/cli/sync-git/follow.ts:435-447`), and public reason
   precedence selects `local-edits` first (`src/cli/sync-git/follow.ts:384-389`).
   Either specify controlled operation fixtures whose worktree/index still equal
   BASE or incoming, or assert the actual public reason while separately proving
   that op-state supplies a safety veto. The receiver-side lifecycle fixes the
   core f11 error, but its required exact classification is not reliably
   implementable as written.

## Round 3 — Verdict: ALIGNED

The ratified normative annex, `docs/design/141-cell-outcomes.md`, closes all six
Round-2 findings with exact, implementable outcomes. Its explicit precedence
over the main design for cell expectations removes any build-changing
ambiguity. Only editorial residue remains in the main document.

### Round-2 closure audit

- **f3 closed:** Annex sections 1 and 6 split materialization,
  native-refusal, and whole-manifest-refusal lifecycles; refusal cells now have
  exact plane, durable-deferral, settlement, retry, and no-republish checks
  instead of impossible B-repository clauses.
- **f4 closed:** S1(c) is pinned as normal capture with an exact mode-160000
  index entry, absent B worktree path, ` D mod` porcelain, clean fsck, and a
  constrained unrelated-file B-to-A proof.
- **f5 closed:** S2 chooses two distinct fixtures—configured and explicitly
  unconfigured, not PATH-masked—and pins pointer/worktree bytes, local config,
  cache timing, porcelain, fsck, and each allowed B-to-A mutation.
- **f9 closed:** The online partial-clone arm pins `{O1,O2}` to `{}` silent
  hydration and the finding; the offline arm pins Git 2.54, exact stderr,
  capture/artifact deferral surfaces, unchanged missing objects, and retry
  settlement without a remote-sequence advance.
- **f10 closed:** Identical-tree empty commits deliberately avoid the ordinary
  worktree/index/ownership gates. The bisect cell now pins no deferral, exact
  HEAD reattachment, semantic-index equality, unmanaged `BISECT_*`/bisect-ref
  persistence, status/log surfaces, and the engine-gap sidecar entry.
- **f11 closed:** Supported-operation fixtures pin all three simultaneous
  safety vetoes, the actual persisted/displayed `local-edits` precedence, an
  independent resolve surface proving the hidden operation-state veto,
  receiver-only byte invariants, safe-ref partial progress, and clean
  post-abort settlement before the B-to-A proof.

The main design retains stale summary phrases such as advancing the same branch
for every S5 arm, displaying `local-operation`, and calling bisect metadata
untracked operation litter. It also loosely calls the fresh shallow outcome a
drop. Those phrases are editorial residue: the main design's v3 preamble makes
the annex authoritative for cell expectations, and the annex pins the contrary
implementation choices explicitly. No unresolved annex/main contradiction can
change the build.
