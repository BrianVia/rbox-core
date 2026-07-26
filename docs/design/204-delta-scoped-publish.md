# Design 204 — Delta-scoped publish wire

**Status:** DRAFT r3 (round-1 wave + serial gate folded — see `REVIEW-204.md`)
**Target:** v1.10.0 (rides the same release as designs 202+203; same burn-in)
**Kill switches:** `RBOX_PREFLIGHT_DELTA=0`, `RBOX_MDE_DELTA=0`,
`RBOX_MDE_SNAPSHOT=0` (master), `RBOX_MDE_FAST_PULL=0`, `RBOX_GIT_PLAN_LAZY=0`

## 1. Problem and field evidence

AE `sync_phase` telemetry, Mac (108,537 files, 101 repos, ~40 Mbps uplink),
steady-state publish of a **40-byte single-file change**, 2026-07-26:

| phase | wall | what it actually does today |
|---|---:|---|
| `missing` | 4.1 s | presence-checks **all 108,537** manifest blobs (7.2 MB of hashes upstream, 3 serial 50k POSTs, ~41 D1 batch subrequests) |
| `commit` | 4.4 s | uploads a **full 12.5 MB zstd manifest snapshot** (u≈2.0 s) + commit POST |
| `git-plan` | 2.7 s | serial fs work × 101 repos + whole-tree discovery walk (breakdown unmeasured — Part C5 instruments it) |
| total publish | **15.6 s** | for 40 bytes |

Post-202/203, the receive side is ~4.5 s; the publish side is now the
dominant term in end-to-end propagation (19.6 s measured Mac→FM).

Design principle (founder, 2026-07-26, see [[least-information-scoped-work]]):
payloads carry only what is necessary; consumers process only what the delta
names, never O(workspace).

## 2. The decisive recon finding

Parts A and B are **unfreeze designs**, not new mechanism. Both deltas are
fully built, reviewed, and shipped dark behind opt-in env flags:

- **A (`missing`):** `RBOX_PREFLIGHT_DELTA=1` (design 103 Part B) presence-
  checks only `toEncrypt − deferred + recoverAddresses`. Measured in the
  design-103 gate: 2.8–4.0 s → **0.1 s** on a 114k-file workspace.
  Default arm today: `src/cli/sync-recovery.ts:304-305` sends every manifest
  `encSha`, undeduped.
- **B (`commit`):** `RBOX_MDE_DELTA=1` (design 84 Phase C2) emits a zstd
  delta envelope (`ManifestDeltaOp[]`) chained to the prior snapshot via the
  signed `manifestChain`. Server accepts and GC-roots chains
  (`apps/api/src/workspace-sync.ts:481,648,849,1016`); **every reader since
  v1.1.0 folds deltas** (Phase B decode path,
  `src/cli/e2ee-remote.ts:160-305`; the fleet-floor verification of
  2026-07-17 is recorded in the comment at `src/cli/e2ee-remote.ts:77-83`);
  economic guard (`src/cli/e2ee-remote.ts:782`) and chain cap
  (`MAX_MANIFEST_DELTA_CHAIN=16`, `src/engine/manifest-chain.ts:1`) handle
  compaction. `state.manifestMeta` base evidence is maintained on every
  snapshot commit and every pull.

Both flips follow the founder default-on rule ([[default-on-preference]])
with kill switches retained. Part C is a **reduced** transfer of design
203's pattern to the plan; the ambitious discovery-delta lever was reviewed
out in round 1 and deferred (§5.5).

## 3. Part A — preflight delta default-on

### 3.1 Freeze condition and its discharge

REVIEW-103 item 11: `RBOX_PREFLIGHT_DELTA` must not ship enabled alongside a
design-102 narrowed admission until 102's acceptance proves carried-ref
fence/prune/loss handling. Status:

- **Mechanism half: discharged.** Under `RBOX_COMMIT_DELTA_ADMISSION=enforce`
  (prod: `apps/api/wrangler.jsonc:112,194`), the fence probe folds
  prune-marked carried refs into `admitData`
  (`apps/api/src/commit-delta.ts:75-79`) → they are presence-checked and
  422 on loss. Over-cap fails closed: `fence_over_cap` and
  `markedProbeSkipped` both force full-refset admission
  (`apps/api/src/workspace-sync.ts:84,344`).
- **Test half: NOT discharged — this design closes it.** Every carried-ref
  behavioral test today is shadow-mode
  (`apps/api/test/commit-delta-shadow.test.ts:43-54` accepts only
  `off|shadow`); `commit-delta.test.ts` covers the pure merge only. **Hard
  precondition for the flip (test 3, §6):** an enforce-mode endpoint
  regression proving (a) a prune-marked carried ref returns 422
  `error:"unsatisfied_blobs"` with that sha in the `missing` wire field and
  no head movement, (b) probe over-cap falls back to full-refset
  admission. Server-side test only; no server code
  change expected — if the test FAILS, Part A stays frozen and the failure
  is a design-102 bug to fix first.

### 3.2 Fault model and safety argument (corrected in r1 review)

The 422 backstop is real but its authority is 102's **fence probe**, not
full admission. State of each loss class after the flip:

1. **Prune-marked carried ref** (every sanctioned GC/prune flow marks before
   deleting): server 422s via the fence probe → `accumulateRecoveryPage`
   (`src/cli/sync/push.ts:373`) → next preflight checks the union of
   accumulated pages → re-upload. Covered.
2. **Unmarked `present=0` carried ref**: produced by NO sanctioned server
   flow; requires out-of-band catalog correction. After the flip, neither
   the delta preflight nor enforce admission checks it (today's full
   preflight does, on the receipts branch). This is the accepted narrowed
   fault model. The legacy inline-commit branch does not detect this class
   even today (`apps/api/src/workspace-sync.ts:1273-1300` is not
   `present`-aware).
   **Operator rule (add to docs/DEPLOYMENTS.md on merge):** any manual
   catalog repair that clears `present` must either prune-mark the affected
   refs or be followed by client `--verify` / one push with
   `RBOX_PREFLIGHT_FULL=1`.
3. **Physical R2/pack loss with healthy catalog**: invisible to preflight
   and admission both before and after (all checks are D1-only; bytes are
   verified on read, `apps/api/src/blob-pack.ts:122-134`). No regression;
   out of scope.

**Posture change, named:** today's full preflight opportunistically
re-uploads prune-marked blobs on every push. After the flip that repair is
driven by the server fence probe at commit time (and by `--verify` /
`RBOX_PREFLIGHT_FULL=1` for proactive audit — REVIEW-103 r2's ruling that
"proactive detection stays `--verify`").

### 3.3 Mechanism

One exported helper, consumed by BOTH arms (round 1 found two independent
env reads — `src/cli/sync-recovery.ts:185` feeds the pipeline arm via
`args.preflightDelta`, `:295` the serialized arm):

```ts
export const preflightDeltaEnabled = () =>
  process.env.RBOX_PREFLIGHT_DELTA !== "0";
```

Both read sites consume it. Everything else is unchanged and already built:
candidate set `toEncrypt − deferred + recoverAddresses`
(`src/cli/sync-recovery.ts:306-315`); recovery-page union + `forceFullAudit`
overflow latch (`src/cli/sync/push.ts:158-171,358-378`). Corrections to prior claims:
repair forces `forceSnapshot`, not a full audit; genesis is candidate-set
equivalence (`toEncrypt ≈ all`), not an audit; a recovery retry checks the
**union** of accumulated pages, not exactly the last residue.

### 3.4 Telemetry

Delta-arm details (`introduced/recover/sent/fullAudit`) already exist.
`introduced` gets ONE definition across both arms: unique post-defer
addresses. Field check: `missing` ≲0.2 s; `sent` ≈ changed-blob count.

## 4. Part B — manifest delta commits default-on (+ evidence fast-pull)

### 4.1 Freeze condition and its discharge

Design 108 §7 froze `RBOX_MDE_DELTA` so the files-first A/B gate would not
silently depend on it ("the gate must not silently depend on it" —
`docs/design/108-files-first-publish.md:561`); the gate closed with design
108's ship. Design 149 §A3 is the principled successor (reader-version
floors) but is unimplemented and NOT a dependency: the v1.7.1 snapshot flip
established the interim pattern — manual fleet-floor verification + kill
switch. Reader floor for deltas is v1.1.0 (same Phase-B reader, verified
2026-07-17). **Pre-merge step:** re-verify the live device floor via the
admin cockpit / D1 `devices.client_version` and record it here.

### 4.2 Mechanism — one policy, two seams, lattice inverted

Today's lattice is `delta ⟹ snapshot` with delta opt-in. The new lattice is
`snapshot ⟹ delta-eligible` with both default-on and `RBOX_MDE_SNAPSHOT=0`
as the master kill (149 §A3 precedence, adopted early):

```ts
export function mdeWritePolicy(): { delta: boolean; snapshot: boolean } {
  const snapshot = process.env.RBOX_MDE_SNAPSHOT !== "0";
  const delta = snapshot && process.env.RBOX_MDE_DELTA !== "0";
  return { delta, snapshot };
}
```

Consumed at BOTH seams — `mdeWriteCaps()` in `src/cli/e2ee-remote.ts:84-87`
and push's deltaBase selection (`src/cli/sync/push.ts:773-778`). The push
seam must NOT re-read raw env vars: under master kill it constructs no
`deltaBase` (today it would still pay `validManifestMeta` +
`manifestFromMeta` + O(N) `validateManifest` for a base the writer then
discards). Contradictory pair (`RBOX_MDE_SNAPSHOT=0` + `RBOX_MDE_DELTA=1`)
logs `mde_delta_ignored_snapshot_kill_switch` **once** (module-scope latch —
`mdeWritePolicy` runs per operation).

**Master kill covers repair (round-1 blocker):** `forceSnapshot` currently
overrides `snapshotEnabled` (`src/cli/e2ee-remote.ts:769-795`), so
`RBOX_MDE_SNAPSHOT=0` would not force raw on repair. Change: with
`snapshot=false`, repair and every other arm emit **raw-v0** (chain-free);
`forceSnapshot` means "do not emit a delta", never "override the master
kill".

**Base-integrity precondition (round-1 blocker):** `validManifestMeta`
validates shape only — a structurally valid but stale/mismatched meta would
publish an unreadable delta (readers fail the base-hash check AFTER the head
commits), and the previously claimed sequence-gap guard is tautological
(`appliedSequence` is defined as `state.lastSyncedSequence`,
`src/cli/sync/push.ts:461-467,773-778`). New rule: delta selection additionally requires

```
canonicalManifestHash(reconstructedBase) === manifestMeta.manifestHash
```

Any mismatch → snapshot + fresh meta write. The hash pass is O(manifest)
CPU-only; implementation may memoize per push. Existing preconditions stay:
epoch equality, chain length + 1 ≤ 16, economic guard
(`chainBytes + candidateEncBytes < snapshotBytes`).

### 4.3 Receiver interaction — fast-pull joins the scope

- **`RBOX_MDE_FAST_PULL` (design 106) flips default-on in this design.**
  Round 1 established that delta writes WITHOUT the evidence fast path
  regress default receivers: `decodeManifestAt`'s cold walk fetches the
  head + every chain link + the terminal snapshot per pull — more bytes
  than today's single snapshot. With evidence: exact head → zero fetch;
  grown chain → **delta-suffix hit** (`src/cli/e2ee-remote.ts:264-305`, design
  106's primary win — fetch only the new links). Kill switch
  `RBOX_MDE_FAST_PULL=0`. Read path shipped in v1.7.x; pinned at
  `src/cli/e2ee-sync.test.ts:774-785`.
- Corrected claim from r1: a grown chain is an evidence-prefix HIT, not a
  miss. The miss/fail-closed cases are substituted, reordered, or non-prefix
  evidence.
- **Evidence-fold failure falls back to the cold walk (serial-gate HIGH):**
  the grown-chain path trusts the persisted `manifestHash` as
  `trustedBaseHash` without re-hashing the persisted manifest
  (`src/cli/e2ee-remote.ts:264`, `src/engine/manifest-delta.ts:487`), so
  locally corrupted persisted state surfaces as a result-hash
  `ManifestChainError` — and the daemon's one-level repair catch
  (`src/cli/daemon/daemon.ts:2226`) would retry with the SAME corrupt
  evidence, wedging an otherwise healthy chain. Rule: any evidence-fold
  failure is treated as a cold-walk miss **within the same pull** — retry
  without evidence; only a cold-walk failure raises `ManifestChainError`
  (the cold walk is authenticated and self-heals the persisted state, which
  is exactly what FAST_PULL-off does today). Steady state pays nothing; the
  corrupt-evidence case pays one slow pull.
- **recordEvidence under the master kill (serial-gate ruling):** default-on
  fast-pull sets `recordEvidence: true` (`src/cli/sync/pull.ts:97`), which
  forces meta collection even when `RBOX_MDE_SNAPSHOT=0`, and raw-v0
  decoding then synthesizes `manifestMeta` (`src/cli/e2ee-remote.ts:327`).
  Ruled ACCEPTED: synthesized meta from a raw head is harmless (evidence
  only accelerates future pulls) and keeping evidence live during an
  emergency raw window is desirable. The mixed-fleet expectation at
  `src/cli/e2ee-sync.test.ts:704` ("raw-v0 without manifest meta") inverts
  and must be updated as part of this design, not discovered in CI.
- The WS "committed" doorbell stays content-free (design 120). No wire
  shape changes anywhere: the delta envelope is an opaque encrypted blob.

### 4.4 Compaction cadence

At most 16 consecutive deltas; the next commit emits a snapshot. Amortized:
one snapshot-sized commit per ≤17 pushes; steady-state commits carry
KB-scale deltas.

## 5. Part C — lazy git-plan (reduced scope after round 1)

### 5.1 What survives review

Round 1 removed the two aggressive levers: **cross-repo common-dir
fingerprint memoization** (unsound — a shared-ref mutation between linked-
worktree decisions yields a false trusted hit; existing hand-invalidations
at `src/cli/sync-git/plan.ts:1288,1294-1295` prove invalidation is
correctness-bearing; ~zero value without linked-worktree density) and
**delta discovery / walk skipping** (§5.5). What ships in this cycle is
measurement plus two safe, narrow levers. Kill switch: `RBOX_GIT_PLAN_LAZY`
(`!== "0"`), one read at plan entry, legacy arm byte-faithful.

**Repo skipping via the file-plane delta remains unsound** — git ref
movement never appears in the manifest diff; the fingerprint IS the change
detector. The visited set does not shrink.

### 5.2 C5 — sub-phase attribution (the point of this cycle's Part C)

`gitPlanStats` gains exclusive wall-clock buckets: `discoverMs`,
`journalPreloopMs`, `fingerprintMs`, `hygieneMs`, and `otherMs =
totalMs − Σ(exclusive buckets)` (cache load/save, config lane, proofs,
capture all land in `otherMs` this cycle). Carried into the existing
`recordDetails("git-plan", …)` summary. Tests assert buckets are finite,
nonnegative, and individually ≤ total — NOT that they sum to the wall
(non-exclusive nesting was a round-1 finding). This is what tells the
successor design which lever is worth building; the per-lever savings
below are hypotheses, not commitments.

### 5.3 C1-narrow — gate ONLY the journal recovery pair

The pre-loop (`src/cli/sync-git/plan.ts:376-445`) is NOT journal-only work
(round-1 blocker, all three reviewers): `publisherAckBindings`
(`src/cli/sync-git/plan.ts:404-417`) feeds absence-proof rejection (`:1086-1090`), pending
supersession (`:1231-1240`), and publisher-ACK authoring
(`src/cli/sync/push.ts:966-985`); the `!ctx` quarantine arm (`:393-399`)
sets `recoveryAllowsSupersession`, consumed at `:805`. **All of that stays
eager.** Only this pair gates on the probe:

```ts
const recover = !gitPlanLazy || await checkoutJournalPresent(root, rel);
if (recover) { /* checkoutJournalBinding + recoverAndLandFollowJournal (src/cli/sync-git/plan.ts:419-420) */ }
```

`checkoutJournalPresent` (single lstat, fails open on non-ENOENT —
`src/engine/git/journal.ts:152`) is the same primitive design 203 uses at
`src/cli/sync-git/apply.ts:644`. Containment argument for mutation-time
recheck (203's rule): the plan's journal consumption is confined to the
pre-loop; stage-5 conflict-ref pruning consumes no journal state; journal
producers are serialized by the workspace mutex. The probe-to-mutation race
test (§6 test 13) pins this.

Honest saving: ~2–4 syscalls/repo net of the added lstat (NOT the 10–14
claimed in r1 — the lineage cluster stays). C5 measures the actual value.

### 5.4 C2-narrow — scoped memos, read-only stages

- `repoCtxFromDisk`: 8 call sites in `src/cli/sync-git/plan.ts`
  (`:378,458,502,1044,1193,1231,1271,1281`). Memo `rel → ctx` covering ONLY
  the pre-capture read stages (pre-loop + stage-2 decision reads:
  `:378,458`), **cleared before the capture pool starts**; `:502` runs
  inside `captureWithConfig` AFTER repository capture (invoked from
  `:1000`) and therefore performs a fresh post-boundary derivation, as do
  the stage-5 hygiene sites (`:1271,1281`) — the `src/cli/sync-git/plan.ts:1294-1295`
  comment warns about exactly the stale-memo-across-capture hazard. No
  change to `gitFingerprint`'s
  internal derivation (no API change this cycle). Reuse design 203's `memo`
  helper by hoisting it from `src/cli/sync-git/apply.ts:408-419` into a
  shared module — do not copy-paste it.
- `realpath(workspaceRoot)`: once per plan run (`readStateLineageV1`
  currently re-resolves it per repo).
- Fingerprint policy stays `"per-decision"`. Common-dir work per repo is
  untouched this cycle.

### 5.5 Deferred: delta discovery (C3/C4 of r1)

Skipping the whole-tree `discoverGitRepos` walk is deferred to a successor
design. Round 1 established it needs (evidence in `REVIEW-204.md` +
`.claude-review-204-r1-codex{A,B}.md`):

- `kindByPath` reconstruction for the visited set (it gates the fingerprint
  fast path at `src/cli/sync-git/plan.ts:866` — an empty map forces every repo to the
  spawning slow path, inverting the goal);
- a backend-independent, daemon-owned discovery-continuity state
  (`GitRefWatchRegistry` is Linux+Parcel only — the predicate could never
  fire on the Mac, the measured host);
- verified `@parcel/watcher` rename/descendant-event semantics (read the
  source, per [[verify-dependency-source-on-load-bearing-assumptions]]);
- epoch-stamped candidate handoff ACKed on accepted publication (not plan
  completion), overflow (`discoverAll`) poisoning, restart-forces-walk;
- preservation of `onGitReposDiscovered` → safety-floor refresh.

### 5.6 What does NOT change

Plan output contract (sections, base carry, `captureObserved`/
`configObserved` totality, protectedPending, `onGitReposDiscovered`), the
discovery walk itself, slow-path behavior, 422 `force` recapture. Lazy=0
restores today's exact sequence.

## 6. Tests the implementation MUST write

Part A:
1. Default-on: no env → delta arm in BOTH the serialized and pipeline arms;
   `RBOX_PREFLIGHT_DELTA=0` → legacy full-sweep arm in both (byte-shape
   preserved: undeduped full manifest list).
2. 422-recovery: retry's check set is the union of accumulated recovery
   pages + introduced; overflow latches `forceFullAudit`.
3. **Enforce-mode server regression (hard precondition):** under
   `RBOX_COMMIT_DELTA_ADMISSION=enforce`, (a) a commit whose carried ref is
   prune-marked returns 422 `error:"unsatisfied_blobs"` with that sha in
   the response's `missing` array (the wire field —
   `apps/api/src/commit-envelope.ts:31`; there is no `unsatisfiedBlobs`
   field on the wire, that is the client-side name) and no head movement;
   (b) marked-probe over-cap falls back to full-refset admission. Harness
   notes: `testEnv` must accept `"enforce"` (the shadow fixture caps at
   `off|shadow`); over-cap needs `FENCE_SET_MAX`+1 = 50,001 markers — use
   batched/bulk insertion.
4. Ambient-env hygiene: force-delete `RBOX_PREFLIGHT_DELTA` AND
   `RBOX_PREFLIGHT_FULL` in beforeEach of every touched suite; update
   `src/cli/sync/sync.test.ts:733-746,750-759` to set `="0"` explicitly
   (they currently `delete` to select the legacy arm — inverted by the
   flip).

Part B:
5. Default-on steady state: valid base ⇒ delta envelope, chain grows,
   signed `manifestChain`; reader folds exactly.
6. Kill-switch matrix: `RBOX_MDE_DELTA=0` ⇒ snapshot despite valid base
   (and NO `deltaBase` constructed at the push seam); `RBOX_MDE_SNAPSHOT=0`
   ⇒ raw-v0, no delta, no `deltaBase`, warn-once; `RBOX_MDE_SNAPSHOT=0` +
   repair ⇒ raw-v0 (the `forceSnapshot` override is subordinate to the
   master kill).
7. Chain cap end-to-end: 16 real consecutive delta commits; the 17th
   snapshots (not an injected synthetic chain).
8. Economic guard end-to-end: a real candidate whose
   `chainBytes + candidateEncBytes ≥ snapshotBytes` ⇒ snapshot.
9. Fast-pull evidence (verify vs `src/cli/e2ee-sync.test.ts:774-785`,
   don't duplicate): exact head ⇒ zero-fetch; grown chain ⇒ suffix-only
   fetch (`fold:"evidence"`); substituted/reordered/non-prefix evidence ⇒
   fail-closed re-walk. Plus `RBOX_MDE_FAST_PULL=0` ⇒ cold-walk behavior
   preserved.
9b. **Evidence-fold fallback (serial-gate HIGH):** corrupted persisted
   manifest + structurally valid meta + advanced delta head ⇒ the pull
   falls back to the cold walk in the SAME operation, succeeds, and
   self-heals the persisted state; no `ManifestChainError` surfaces and no
   repair loop triggers. Exercise through a real pull (the daemon repair
   catch at `src/cli/daemon/daemon.ts:2226` must not be entered).
9c. Raw-v0 evidence synthesis: with `RBOX_MDE_SNAPSHOT=0` and
   `recordEvidence:true`, raw-v0 decode synthesizes `manifestMeta`; update
   the inverted mixed-fleet expectation at `src/cli/e2ee-sync.test.ts:704`.
10. Base-integrity: structurally valid meta whose `manifestHash` mismatches
    the reconstructed base ⇒ snapshot emitted + meta rewritten; reader
    folds clean end-to-end.
11. Repair/422 arms force snapshots (with master kill off).

Part C:
12. C1-narrow fidelity: no journal ⇒ binding/recovery pair skipped, AND
    absence-proof, pending-supersession, and publisher-ACK behavior
    byte-identical to lazy=0 (the round-1 regression concern); journal
    present ⇒ recovery identical to lazy=0.
13. Probe-to-mutation race: journal created after the pre-loop probe ⇒ next
    plan recovers it; no stage-5 arm consumes journal state.
14. Ctx memo: invalidated at the capture boundary; stage-5 derivations
    fresh; a repo whose `.git` shape flips mid-plan (dir↔pointer) gets
    fresh ctx post-capture.
15. Lazy=0 byte-faithful legacy order (203's pattern), including the
    unconditional journal pair.
16. `gitPlanStats` buckets: exclusive brackets finite, nonnegative, each ≤
    total wall; `otherMs` present; summary string carries them.
17. Zero-spawn steady state preserved (existing pin) under lazy=1.

## 7. Rollout

One release (v1.10.0, with 202/203). All flips default-on with independent
kill switches; wire is backward-compatible in every direction (readers fold
deltas since v1.1.0; server roots chains; preflight and git-plan are
client-local). Burn-in on the founder fleet as dev builds. Field acceptance:

- `missing` ≲0.2 s; `sent` ≈ changed count.
- `commit` ≲1 s steady state. Expected: one snapshot-sized wall per ≤17th
  push (compaction). **Failure discriminator:** the writer logs the
  snapshot cause on every non-delta commit —
  `mde snapshot cause=<policy|no-base|integrity|force|economic|chain-cap>`
  (a small implementation requirement of this design; the enum covers
  master/delta kill, missing or integrity-rejected deltaBase,
  repair/forceSnapshot, economic rejection at `src/cli/e2ee-remote.ts:782`,
  and compaction). Persistent `economic` or `no-base`/`integrity` walls are
  the bug signatures; `chain-cap` at ~1/17 cadence is healthy.
- Receive side: steady-state pulls fetch only the new chain link
  (`fold:"evidence"`, suffix-only) — `download`/`decrypt` AE drop is
  expected and attributable to the FAST_PULL flip.
- `git-plan`: C5 buckets present in details; C1/C2-narrow deltas measured
  (hypothesis: a few hundred ms; the honest answer comes from the buckets).
- End-to-end Mac→FM single-file propagation: ≤12 s expected (from 19.6 s;
  publish ~15.6→~8 s dominated by the remaining git-plan/address/encrypt
  residual). The successor discovery design targets the rest.

## 8. Non-goals

- Implementing design 149's `minReaderVersion` floor (149 stays the
  principled successor; third use of the manual-floor + kill-switch
  interim).
- Server-side code changes (the enforce-mode regression in test 3 is a
  test; if it fails, that is a design-102 bug fixed under 102, and Part A
  stays frozen until green).
- Git-plan delta discovery / walk skipping and cross-repo common-dir
  fingerprint memoization (deferred with evidence — §5.5).
- Blob packing / upload-lane throughput (designs 111/114).
- Shrinking the git-plan visited set.
- Batching/`updateScope` burst coalescing (existing debouncers batch;
  revisit only if burn-in shows per-push fixed costs dominating bursts).
