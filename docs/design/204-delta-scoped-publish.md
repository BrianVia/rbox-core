# Design 204 — Delta-scoped publish wire

**Status:** DRAFT (r1)
**Target:** v1.10.0 (rides the same release as designs 202+203; same burn-in)
**Kill switches:** `RBOX_PREFLIGHT_DELTA=0`, `RBOX_MDE_DELTA=0` / `RBOX_MDE_SNAPSHOT=0`, `RBOX_GIT_PLAN_LAZY=0`

## 1. Problem and field evidence

AE `sync_phase` telemetry, Mac (108,537 files, 101 repos, ~40 Mbps uplink),
steady-state publish of a **40-byte single-file change**, 2026-07-26:

| phase | wall | what it actually does today |
|---|---:|---|
| `missing` | 4.1 s | presence-checks **all 108,537** manifest blobs (7.2 MB of hashes upstream, 3 serial 50k POSTs, ~41 D1 batch subrequests) |
| `commit` | 4.4 s | uploads a **full 12.5 MB zstd manifest snapshot** (u≈2.0 s) + commit POST |
| `git-plan` | 2.7 s | walks all 101 repos: unconditional journal/lineage pre-loop (~10–14 serial fs syscalls/repo, ~8 realpath), full fingerprint per repo (refs-tree walk, packed-refs read, ≤1 MiB index hash), whole-tree `discoverGitRepos` readdir walk, and a stage-5 hygiene re-derivation per repo |
| total publish | **15.6 s** | for 40 bytes |

Post-202/203, the receive side is ~4.5 s; the publish side is now the
dominant term in end-to-end propagation (19.6 s measured Mac→FM).

Design principle (founder, 2026-07-26, see [[least-information-scoped-work]]):
payloads carry only what is necessary; consumers process only what the delta
names, never O(workspace).

## 2. The decisive recon finding

Parts A and B below are **not new mechanism**. Both deltas are fully built,
reviewed, and shipped dark behind opt-in env flags:

- **A (`missing`):** `RBOX_PREFLIGHT_DELTA=1` (design 103 Part B) presence-
  checks only `toEncrypt − deferred + recoverAddresses`. Measured in the
  design-103 gate: 2.8–4.0 s → **0.1 s** on a 114k-file workspace
  (`docs/design/103-steady-sync-quick-wins.md` §gate record, CHANGELOG
  v1.7.x). Default arm today: `src/cli/sync-recovery.ts:304-305` sends every
  manifest `encSha`, not even deduped.
- **B (`commit`):** `RBOX_MDE_DELTA=1` (design 84 Phase C2) emits a zstd
  delta envelope (`ManifestDeltaOp[]`) chained to the prior snapshot via the
  signed `manifestChain`. Server accepts and GC-roots chains
  (`apps/api/src/workspace-sync.ts:481,648,849,1016`); **every reader since
  v1.1.0 folds deltas** (Phase B, fleet floor verified 2026-07-17 before the
  snapshot flip, comment at `src/cli/e2ee-remote.ts:77-83`); the economic
  guard (`e2ee-remote.ts:782`) and chain cap (`MAX_MANIFEST_DELTA_CHAIN=16`)
  handle compaction. `state.manifestMeta` base evidence is already
  maintained on every snapshot commit and every pull.

So 204's parts A and B are **unfreeze designs**: verify the freeze
conditions are discharged, flip the defaults per the founder default-on rule
([[default-on-preference]]), keep the kill switches. Part C (git-plan) is
the only new mechanism, and it is a transfer of design 203's pattern.

## 3. Part A — preflight delta default-on

### 3.1 Freeze condition and its discharge

REVIEW-103 item 11 (hardened round 2): `RBOX_PREFLIGHT_DELTA` must not ship
enabled alongside a design-102 narrowed admission **until 102's acceptance
proves carried-ref fence/prune/loss handling**. Status now:

- Design 102 delta admission is `enforce` on prod (REVIEW-142:147), live
  since the v1.8.x line, with per-commit `commit.delta` AE metrics and the
  fallback counter at zero in steady state.
- Carried-ref handling is implemented (`apps/api/src/commit-delta.ts` —
  `carriedCount`, `markedCarried`, `intentCarriedHit`, fence set) and pinned
  by `apps/api/test/commit-delta.test.ts` + `commit-delta-shadow.test.ts`.

The implementation MUST re-verify (not assume) that a test exists pinning
"admission checks carried refs against the parent refset" (REVIEW-103 item
11's companion regression test). If absent, add it in this cycle — it is a
server-side test only, no server code change.

### 3.2 Mechanism (flag semantics flip only)

`src/cli/sync-recovery.ts:295` becomes default-on:

```ts
const preflightDelta = process.env.RBOX_PREFLIGHT_DELTA !== "0";
```

Same flip at the pipeline seam (`src/cli/publish-pipeline/pipeline.ts:437`
consumes `args.preflightDelta`, set from the same read — one flag read site,
threaded; verify there is exactly one env read and keep it that way).

Everything else already exists and is unchanged:

- **Candidate set:** `toEncrypt` encShas − `deferred` + `options.recoverAddresses`
  (`sync-recovery.ts:306-315`).
- **Safety net (the correctness backstop):** if the client under-checks —
  server lost a blob (GC, prune, pack loss) that the delta didn't name — the
  commit returns **422 `reupload` with `unsatisfiedBlobs`**, which feeds
  `accumulateRecoveryPage` (`src/cli/sync/push.ts:373`) → next attempt
  presence-checks the named residue; escalation to `forceFullAudit` (full
  sweep) already exists for pathological pages. This loop is why the delta
  arm is safe: the server's refset admission is the authority, the preflight
  is only an optimization.
- **First publish / repair:** `forceFullAudit` continues to force the full
  sweep; genesis pushes have `toEncrypt ≈ everything` anyway.

### 3.3 Telemetry

The delta arm already records `introduced/recover/sent/fullAudit` details
(`sync-recovery.ts:326-332`). No new telemetry. Field verification: AE
`missing` wall drops to ≲0.2 s; `sent` ≈ changed-file count.

## 4. Part B — manifest delta commits default-on

### 4.1 Freeze condition and its discharge

Design 108 §7 froze `RBOX_MDE_DELTA` on both A/B arms so the files-first
gate would not silently depend on it. That gate concluded (design 108
shipped, v1.3.x); the freeze simply was never revisited. Design 149 §A3
plans the principled successor (`minReaderVersion` floor, tri-state
overrides) but 149 is unimplemented and NOT a dependency: the snapshot flip
(v1.7.1) established the accepted interim pattern — **manual fleet-floor
verification + env kill switch**. Reader floor for deltas is v1.1.0 (same
Phase-B reader as snapshots, already verified 2026-07-17); current fleet is
≈ entirely ≥1.8. The implementation MUST re-verify the live device floor via
the admin cockpit / D1 `devices.client_version` before merge, and record the
verification in the doc (same discipline as the `e2ee-remote.ts:77-83`
comment).

### 4.2 Mechanism (two seams, one semantic)

Both existing gates flip from `=== "1"` to `!== "0"`, with the 149 §A3
precedence rule adopted early because it costs nothing:

1. `mdeWriteCaps()` (`src/cli/e2ee-remote.ts:84-87`):
   ```ts
   const snapshot = process.env.RBOX_MDE_SNAPSHOT !== "0";
   const delta = snapshot && process.env.RBOX_MDE_DELTA !== "0";
   return { delta, snapshot };
   ```
   `RBOX_MDE_SNAPSHOT=0` is the master kill switch: it forces raw-v0 AND
   disables delta regardless of `RBOX_MDE_DELTA` (149 §A3 precedence). The
   contradictory pair logs once: `mde_delta_ignored_snapshot_kill_switch`.
2. Push's deltaBase selection (`src/cli/sync/push.ts:771`): same
   `!== "0"` read. Keep the two seams reading the SAME env var so a single
   `RBOX_MDE_DELTA=0` disables both (pin with a test that greps both call
   sites... no — pin behaviorally: with `RBOX_MDE_DELTA=0`, a steady-state
   push emits a snapshot envelope even when a valid base exists).

All Phase-C2 preconditions stay as-is and keep the flip safe:

- No valid base (`manifestMeta` missing/epoch-mismatched, sequence gap,
  `validateManifest` fail) → snapshot. First publish → snapshot.
- Economic guard: delta only when `chainBytes + candidateEncBytes <
  snapshotBytes` (`e2ee-remote.ts:782`) — degenerate huge deltas
  self-select snapshot.
- Chain cap 16 → periodic snapshot compaction; amortized cost = full
  snapshot every ≤16 commits.
- 422 / chain-error repair paths force snapshots (`push.ts:188,295`).

### 4.3 Receiver interaction (must not regress 202 / 106)

- Readers fold chains since v1.1.0; `fastFoldBase` (design 106) short-
  circuits on exact chain evidence — verify its evidence comparison treats a
  grown chain as a miss (it compares the full signed chain, so yes; pin with
  a test).
- The WS "committed" doorbell stays content-free (design 120). No wire shape
  changes: the delta envelope is an opaque encrypted blob like any other.
- Pull `download`/`decrypt` phases shrink too (receivers download the small
  delta link instead of 12.5 MB when their base is current) — a free win on
  the receive side; record expected AE movement.

## 5. Part C — lazy git-plan (design 203 transferred to the push side)

### 5.1 What the 2.7 s is (and what it is NOT)

Steady state is already spawn-free on fingerprint hits (`sp=0` in
`gitPlanStats`). The cost is serial fs work × 101 repos plus one whole-tree
walk. **Repo skipping via the file-plane delta is unsound** — git ref
movement never appears in the manifest diff; the fingerprint IS the change
detector. So Part C cuts the per-repo constant and the workspace-level walk,
never the visited set. (Same invariant 203 pinned: "the visited set does not
shrink".)

Kill switch: `RBOX_GIT_PLAN_LAZY` (`!== "0"`), one read at plan entry,
legacy arm preserved byte-faithful like `RBOX_GIT_APPLY_LAZY`.

### 5.2 Levers, in expected-value order

**C1 — gate the journal/lineage pre-loop on the journal probe.**
`plan.ts:376-445` runs `checkoutJournalBinding` + `recoverAndLandFollowJournal`
+ the lineage cluster unconditionally per repo (~8 realpath + reads), yet
`recoverJournal` ENOENTs in steady state. Transfer 203's gate exactly:
`checkoutJournalPresent(root, rel)` (already exported,
`src/engine/git/journal.ts`) — one lstat per repo; only on presence (or
lazy=0) derive the binding and run recovery. The probe fails open
(non-ENOENT ⇒ present), same as 203. The lineage reads
(`readRepoIdentityV1`/`readStateLineageV1`) that exist only to validate a
journal binding move behind the same gate; lineage reads needed for other
plan decisions (pend/needsRes arms) stay where they are. Recon inventory
says this deletes ~10–14 syscalls/repo → ~1–1.4k syscalls/push.

**C2 — memoize per-plan-run derivations.**
- `repoCtxFromDisk(repoDir)`: derived up to 4× per repo per run
  (`plan.ts:378,458,502`, inside `gitFingerprint`, again at `:1271` stage-5
  hygiene). One memo map `rel → ctx` for the duration of one
  `planGitSections` call (203's `memo` helper, `apply.ts:408-419`, hoisted
  to a shared module — do NOT copy-paste it a second time).
- `realpath(workspaceRoot)`: once per run, not once per repo
  (`readStateLineageV1` re-does it per repo).
- Common-dir fingerprint memo: switch the plan's fingerprint run from
  `"per-decision"` to the existing-but-unused `"cross-repo"` policy
  (`fingerprint.ts:84-88,303-307`) so linked worktrees sharing a common dir
  fingerprint it once. CAUTION: verify the racy-clean trust margin
  (`trustedGitFingerprintHit`) is still per-repo-correct when the common-dir
  token is shared across repos within one run — the token is a point-in-time
  read either way; the sharing window is one plan pass. If a reviewer finds
  a soundness hole here, drop this lever alone (it is separable).

**C3 — skip the whole-tree `discoverGitRepos` walk when nothing demands it.**
The walk (`plan.ts:360` → full ignore-pruned readdir of 108k files) exists
to find NEW repos (not yet in `base`/`pending`). New-repo appearance is
exactly what the daemon already observes: `classifyRepoCandidate`
(`git-ref-watch.ts:73`) emits `RepoCandidateWork{owner,dirty,discover}` into
`handleGitSignalBatch` (`daemon.ts:901-926`), which today only feeds
`gitRefRegistry.markCandidates` + a reason-only `requestPush`. Mechanism:

- The daemon accumulates a **discovery-pending flag + candidate rel set**
  from the signal batches since the last completed plan (a set union, not
  a queue; cleared only when a plan that consumed it completes
  successfully — single-use handoff, exactly 202's view-consumption
  pattern).
- `planGitSections` gains an optional `discovery` input:
  `{mode:"delta", candidates: Set<string>} | {mode:"walk"}`. Under
  `mode:"delta"`, the visited key set = `base ∪ pending ∪ candidates`
  (each candidate still `lstat`-verified before admission, same as the
  walk's own verification); NO tree walk.
- Trust predicate (mirrors 202's P): delta mode only when the live watcher
  is healthy since before the last completed plan, the git-ref registry
  snapshot is `complete`, and no `overCap/outside/refused/failed` owner
  exists whose floorDir could hide a new repo. Any failure ⇒ `mode:"walk"`
  (today's behavior) + one log line `git-plan discovery=walk cause=<c>`.
- CLI one-shot pushes (no daemon) always pass `mode:"walk"`.
- Removal is already handled by state (`gitReposRemoved` + base keys), not
  by the walk — deleting a repo dir surfaces via the file plane; verify and
  pin this claim in a test (delete a repo dir, delta-mode plan still
  produces the removal section).

C3 is the riskiest lever; it is severable (C1+C2 alone likely recover
>1.5 s). If review finds the trust predicate needs more than the registry
already records (e.g. a per-owner "armed continuously" fact), prefer adding
that ONE fact to the registry over widening the predicate's inputs.

**C4 — stage-5 hygiene reuses stage-2 work.** `plan.ts:1268-1290` re-derives
ctx per repo; consume the C2 memo. `pruneConflictRefs` stays once-per-common-
dir (dedupe already exists), and its namespace probe joins the common-dir
memo.

**C5 — sub-phase attribution (ships first, in the same PR).** `gitPlanStats`
gains wall-clock buckets: `discoverMs`, `journalMs`, `fingerprintMs`,
`hygieneMs` (Date.now brackets, no per-repo overhead beyond 8 adds), carried
into the existing `recordDetails("git-plan", …)` summary string. This is how
burn-in proves which lever paid.

### 5.3 What does NOT change

The plan's output contract (sections, base carry, `captureObserved`/
`configObserved` totality, protectedPending), slow-path behavior on
fingerprint miss, 422 `force` recapture, and every `mode:"walk"` semantics
are byte-identical to today. Lazy=0 restores today's exact sequence
including the unconditional pre-loop.

## 6. Tests the implementation MUST write

Part A:
1. Default-on: no env → delta arm taken (`sent` == introduced count), full
   sweep NOT sent; `RBOX_PREFLIGHT_DELTA=0` → legacy all-blobs arm
   (byte-shape: undeduped full manifest list, preserving today's behavior).
2. 422-recovery loop: server reports `unsatisfiedBlobs` → next attempt's
   check set includes exactly the residue; `forceFullAudit` escalation still
   reachable.
3. Server regression pin (verify exists / add): 102 admission rejects a
   commit whose carried refs are absent from the parent refset.
4. Ambient-env hygiene: force-delete `RBOX_PREFLIGHT_DELTA` in beforeEach of
   every touched suite (the 202/203 lesson, three separate recurrences).

Part B:
5. Default-on steady state: valid base ⇒ delta envelope emitted, chain
   grows, `manifestChain` signed; reader (existing fold path) reproduces the
   manifest exactly.
6. Kill switches: `RBOX_MDE_DELTA=0` ⇒ snapshot despite valid base;
   `RBOX_MDE_SNAPSHOT=0` ⇒ raw-v0 AND no delta even with `RBOX_MDE_DELTA=1`,
   warn-once log emitted.
7. Chain cap: 16 deltas ⇒ 17th commit is a snapshot (compaction) — likely
   already pinned in design-84 suites; verify, don't duplicate.
8. Economic guard: crafted change where delta ≥ snapshot bytes ⇒ snapshot.
9. `fastFoldBase` evidence miss on grown chain (design 106 interaction).
10. Repair/422 arms still force snapshots.

Part C:
11. Spawn/syscall parity: lazy=1 steady state ⇒ zero git spawns (existing
    pin) AND journal binding NOT derived when no journal file exists (probe
    lstat only — assert via call-count seam, mirroring 203's tests).
12. Journal present ⇒ recovery runs identically to lazy=0 (fidelity).
13. Lazy=0 byte-faithful legacy order (203's pattern).
14. Delta-discovery: new repo created while daemon runs ⇒ candidate set
    carries it ⇒ plan admits it without a walk; trust-predicate failure
    (registry incomplete / owner refused / no daemon) ⇒ walk mode; repo dir
    deleted ⇒ removal section still emitted in delta mode.
15. Cross-repo common-dir memo: linked worktrees share one common-dir
    fingerprint within a run; fingerprint hit/miss decisions unchanged vs
    per-decision policy on a matrix of (clean, ref-moved, index-touched)
    states.
16. `gitPlanStats` sub-phase buckets sum ≈ phase wall (tolerance), present
    in the details summary.

## 7. Rollout

One release (v1.10.0, with 202/203). All three parts default-on with
independent kill switches (founder default-on rule; the wire is
backward-compatible in every direction — old readers fold deltas since
v1.1.0, the server already roots chains, presence-check is client-local
policy, git-plan is client-local). Burn-in on the founder fleet as dev
builds, same protocol as 202/203. Field acceptance:

- `missing` ≲0.2 s; `sent` ≈ changed count.
- `commit` ≲1 s steady state (small delta upload + POST); periodic
  compaction commits may still show snapshot-sized walls every ≤16th push —
  expected, not a regression.
- `git-plan` ≤0.5 s with `discovery=delta`; sub-phase buckets attribute the
  remainder.
- End-to-end Mac→FM single-file propagation target: ≤8 s (from 19.6 s).

## 8. Non-goals

- Implementing design 149's `minReaderVersion` floor mechanism (149 remains
  the successor for principled capability gating; this design uses the
  established manual-floor + kill-switch interim, third use of the pattern).
- Server-side changes of any kind (none are needed; the commit endpoint,
  chain rooting, GC, and 102 admission are untouched).
- Blob packing / upload-lane throughput (designs 111/114 territory).
- Shrinking the git-plan visited set below `base ∪ pending ∪ candidates`.
- The publish pipeline flag path (`RBOX_PUBLISH_PIPELINE`, default off,
  failed its design-98 gate) — Part A threads the flag through it for
  consistency but no pipeline-specific work.
- Batching/`updateScope` burst coalescing (the founder's ideation note):
  the existing debouncers already batch; revisit only if burn-in shows
  per-push fixed costs dominating burst scenarios after A–C land.
