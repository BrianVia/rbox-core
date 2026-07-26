# 202 — Pull consumes the watcher-maintained manifest

Status: ALIGNED (r3 — parallel wave + serial gate + focused re-check; 2026-07-26)
Companion: [203 — Lazy per-repo probes in applyGitSections](203-lazy-git-apply-probes.md)
(shared pull seam; review jointly). See §Combined steady state for the joint
contract.

## Problem

Every daemon pull pays two O(workspace) filesystem passes regardless of how
small the pulled change is:

1. **Pre-pull scan** — `pull()`'s main line runs `scanManifest` over the whole
   workspace (`src/cli/sync/pull.ts:236`, phase `scan`) to rebuild the local
   view it diffs against the remote.
2. **Post-pull refresh** — `doPull` ends with an unconditional
   `replaceManifestFromScan` (`src/cli/daemon/daemon.ts:2155`). It lands
   *after* `syncPhaseSampler.recordCompleted` (`daemon.ts:2130`), so it is
   invisible in `sync_phase` telemetry — the measured pull wall understates
   the true cost.

Field evidence (prod Analytics Engine, 48h to 2026-07-26): fleet pull wall p50
64.5s of which `scan` is 6.45s sample-weighted; on the founder's 110-repo
workspace every pull's `scan` phase is 8.0–9.5s and total pull wall ~20s, on a
2–4 minute backstop cadence all day. A one-file change in a plain folder took
~30s end-to-end; the transfer itself (`download`+`decrypt`+`apply`) was ≤1ms.

Meanwhile the daemon already maintains exactly the state the scan re-derives:
the watcher hot path patches `this.manifest` in O(changed)
(`daemon.ts:1971-1990` → `applyWatchEvents`, `src/engine/manifest.ts:257`) and
that manifest is trusted to **author push truth** under explicit completeness
gates (`daemon.ts:1846-1848`).

Principle (founder, 2026-07-26): consumers do work proportional to the delta,
never to the workspace; events/payloads carry no more information than
necessary. The WS `committed` frame remains a content-free doorbell — nothing
in this design adds wire data.

## Mechanism

When a trust predicate holds, the daemon hands its in-memory manifest (with
its unsettled-path set) to the **single top-level** pull as an explicit
argument, and pull's main line skips `scanManifest`; the post-pull refresh
becomes an O(applied) patch. When the predicate does not hold — or any
fallback trigger fires — behavior is byte-for-byte today's. The scan path is
the permanent fallback, not a transition aid.

### The trusted view is single-use and main-line-only

The trusted view is passed as an explicit parameter of `pull()` (NOT a
`SyncDeps` field). `doPull` currently builds one `pullDeps` object reused by
`repairChain` and the post-repair second `pull()` (`daemon.ts:2105-2123`),
and `repairChain` runs `applyPulledManifest` in a loop over historical
sequences, each iteration mutating disk — a view captured before repair is
stale for every subsequent consumer. Contract:

- only the first, top-level `pull()` invocation of the op may receive the
  trusted view;
- `reconcileResolutionReceipt`'s inner `applyPulledManifest` (runs before the
  main line, can mutate disk) always scans;
- every chain-repair iteration and the post-repair re-pull always scan;
- CLI one-shots (`rbox pull`, `rbox sync`, `chain-repair` entry points) never
  receive a trusted view — it is constructed only inside the daemon.

Passing it as a call argument to exactly one call site makes this
single-use property structural rather than disciplinary.

### Unsettled paths: the daemon-side deferred set

Pull's scan path deliberately **omits** scan-deferred paths from `local` —
`pull.ts:224-231`: feeding base-carried entries into reconcile would let a
remote delete plan a disk delete against an unreadable path (design 108). The
daemon's manifest has the opposite shape: `replaceManifestFromScan` installs
`deferManifest(fresh, previous, deferred)` (`daemon.ts:2860`) and
`applyWatchEvents` retains the prior entry for mid-write paths
(`src/engine/manifest.ts:288-318`). Handing that manifest to `local`
unmodified would re-enable the design-108 hazard.

Additionally, no existing daemon field can supply the deferred set:
`deferredRetryPaths` is a retry queue that **gives up** after
`MAX_RETRIES = 15` ("the safety scan will heal it", `daemon.ts:2032-2035`)
while the stale entry stays in the manifest and
`manifestObservationComplete` stays `true` — the watcher-deferral path never
clears it (`daemon.ts:1971-1985`).

Therefore the daemon gains a durable **`unsettledPaths: Set<string>`**:

- **added**: when `applyWatchEvents` defers a path; when a scan defers a path;
  when the write-finish retry gives up (the give-up currently drops the path
  silently — it now records it); `keepLocalAs` conflict-copy paths created by
  a pull, until the watcher observes them;
- **removed**: when the path is successfully re-observed (its event applies
  cleanly, or a covering scan with no deferral for it installs).

The trusted view is then: `manifest` = `this.manifest` **minus entries for
every unsettled path** (restoring scan-omission semantics), `deferred` =
`unsettledPaths` (feeding the oracle's exemption list at `pull.ts:355`
exactly as `scanDeferred` does today).

### Manifest updates carry a provenance type

Every install of `this.manifest` is stamped with a discriminated provenance
(founder ask, 2026-07-26 — make PARTIAL vs FULL WORKSPACE explicit in the
types, not implicit in call sites):

```ts
type ManifestUpdate =
  | { kind: "full-workspace";                    // replaceManifestFromScan
      coverage: ScanCoverage["coverage"];        // existing "full-tree" | "pruned"
      deferred: ReadonlySet<string> }
  | { kind: "partial";                           // O(changed)/O(applied) patches
      source: "watch-events" | "pull-applied";
      paths: ReadonlySet<string> };              // exactly what was touched
```

`coverage` reuses the existing `ScanCoverage` vocabulary
(`daemon.ts:2870-2875`) — no new terms. **P5 is satisfied by ANY
`full-workspace` install, pruned included**: P5's only job is clearing
seed-staleness (the state seed is last-synced base, not disk truth), and a
pruned scan is already the system's accepted basis for
`manifestObservationComplete = true` when it defers nothing
(`daemon.ts:2858-2863`) — pruning itself is gated on a live, healthy watcher
(`watcherScanMode`, `daemon.ts:2749-2754`), and P1 independently requires the
stronger trusted/non-degraded state.
Coverage *quality* stays governed by the existing scan-cadence invariants
(deep tick forces `full-tree`), not by P.

The daemon stores the last update (`lastManifestUpdate`). Consequences:

- P5 stops being a bespoke boolean: it reads "a `full-workspace` install has
  occurred since `seedFromState`" (seed clears `lastManifestUpdate`).
- The pull log line derives from it (`local=trusted` iff the local view came
  from a manifest whose lineage is full-workspace + partial patches only —
  any degraded state forces scan anyway via P1–P4).
- A `partial` update can never flip `manifestObservationComplete` to `true`
  — only a `full-workspace` install with an empty deferred set may (this is
  today's rule at `daemon.ts:2862`, now enforced by the type: the upgrade
  path simply has no access from the `partial` arm).
- `paths` on the `partial` arm is the least-information payload: patch
  consumers (status/telemetry readers, future invalidation) see exactly what
  changed, never the whole workspace.
- **Batch, never burst** (founder concern, 2026-07-26): a `partial` update
  is emitted once per drain of a settled event batch — all events present in
  one drain coalesce into ONE update via the existing `pendingEvents` buffer
  and the single-flight pump; there is no per-file update stream (events
  arriving after one drain land in the next drain's single update). A directory
  event whose subtree was authoritatively re-derived (`applyWatchEvents`
  unlinkDir semantics) may appear in `paths` as the directory prefix rather
  than an enumeration — the implicit scope ladder is path-batch → subtree →
  full-workspace, and no intermediate lossy tier (e.g. FOLDER-widening of
  file batches) is introduced, because consumers of a widened scope could
  only re-derive its contents by scanning, which is the work this design
  deletes.

### Trust predicate P (evaluated by the daemon at op start)

| # | Condition | Anchor |
|---|---|---|
| P1 | Watcher live and trusted: `this.watcher !== undefined && this.watcherHealthy && this.trustState === "trusted" && !this.watcherDegraded` | `daemon.ts:458-470`, `2749-2754` |
| P2 | `this.manifestObservationComplete && this.activeCaseCollisions.length === 0` | `daemon.ts:379-380`, `1994-2000` |
| P3 | Pending watcher events drained via `applyPendingWatchEvents` **at the top of `doPull`** — a NEW call site (today's only callers are push-side: `daemon.ts:1676`, `:1819`) — and `pendingEvents.length === 0` after the drain (paths the drain defers land in `unsettledPaths`) | `daemon.ts:1951-1992` |
| P4 | `watcherErrorGeneration` captured at op start and re-checked immediately before the **synchronous** post-pull install (see below) | `daemon.ts:470`, `806-811`, `1642-1643` |
| P5 | A `full-workspace` manifest update has occurred since `seedFromState` (which clears `lastManifestUpdate`; reset recovery re-seeds immediately before returning to ready, `daemon.ts:1255-1259`) | `daemon.ts:1177-1182`, `2814-2879` |
| P6 | `resetLifecycle === "ready"` at pump-op entry (the op boundary, not the WS frame gate) | pump entry, `daemon.ts:1569` region |
| P7 | Daemon matcher generation current: the matcher must have been rebuilt since the last change to the base `gitRepos` key set (see fallback trigger F2 — a git-topology-changing pull forces the scan path, which realigns provenance) | `daemon.ts:3006-3011`, `src/cli/sync/policy.ts:88-94` |

P is evaluated by the daemon; `pull()` stays policy-free.

Note on the P3/P4 residual race (events arriving *during* the pull): such an
edit produces a watcher event that remains pending. The post-pull patch may
still install (memory temporarily lacks the edit) because **`doPush` drains
`pendingEvents` before authoring any publish** (`daemon.ts:1819-1822`) and
`applyWatchEvents` re-derives unlink/write truth from disk — the stale window
closes before any publication. A *dropped* event in that window bumps
`watcherErrorGeneration` and fails the P4 re-check → fallback scan. Known
measurement-only consequence: a pre-pull drain moves when events are counted
against deep-scan drift audits (`pendingCoverage`, `daemon.ts:2944`); an
audit opened after the drain no longer sees them as pending — covered by a
dedicated test, not by prose.

### Fallback triggers (any ⇒ post-pull `replaceManifestFromScan` as today)

- **F1** P4 re-check fails (watcher drop during the pull).
- **F2** The pull changed git topology or sections. **Detection is entirely
  daemon-side and pure — no new plumbing out of `pull()`**: `doPull` already
  reloads the post-pull base (`daemon.ts:2148`, `loadSyncBase`); F2 fires
  when the pre-op `syncBase.lastSyncedManifest.gitRepos` and the post-op
  base's `gitRepos` differ in key set (repo materialized/removed) or in any
  section value (deep-compare via the existing pure `gitIncomingKey`,
  `sync-git/shared.ts:115`). `pull()`'s return type and `gitOutcome`'s
  internality are untouched. This preserves the post-pull scan's
  non-manifest side effects where they matter — `discoveredGitRepos` →
  `gitRefRegistry.upsert` + `refreshGitSafetyFloor` (`daemon.ts:2843-2856`)
  — so a newly cloned repo is registered immediately, not at the next safety
  tick; and it realigns matcher provenance (P7), since `knownGitRepos`
  derives from base `gitRepos` keys.
- **F3** The pull wrote an ignore-rule file (`daemon.ts:2142-2145`) — matcher
  changed; patching cannot re-evaluate exclusions.
- **F4** Chain repair engaged (`repairChain` ran at all).
- **F5** Kill switch.

Side-effect inventory of the replaced scan, item by item: repo discovery —
F2; `deferralDiscoveryAuthority` reset (`daemon.ts:2831-2839`) — a
scan-epoch concern, only scans consume it, unchanged; dircache load/save
(`daemon.ts:2828`) — pull's own `withDircache`+`dircacheSave`
(`pull.ts:220`, `:345`) still runs; what the patch path forgoes is only the
walk that could advance `lastUnprunedScanAtMs`, whose staleness bound is
owned by the deep tick (`UNPRUNED_DEADLINE_MS`, `src/engine/dircache.ts:8`);
completeness recompute (`daemon.ts:2862`) — the patch preserves the flag
(it introduces no unobserved paths); `scheduleWriteFinishRetry(deferred)`
(`daemon.ts:2863`) — the patch defers nothing; give-up accounting now lives
in `unsettledPaths`.

### Post-pull O(applied) patch

Under P with no fallback trigger:

- start from the captured trusted manifest;
- for each applied action: install the post-pull base entry from
  `base.lastSyncedManifest` (writes/renames), remove the entry (deletes);
- `keepLocalAs` conflict copies: add the path to `unsettledPaths` (entry
  unknown until hashed); the watcher event re-observes it and the next push
  publishes it — same lifecycle as any local edit;
- re-check P4, then install synchronously — JS is single-threaded, so a
  watcher callback cannot interleave between the re-check and the
  assignment; the race window exists only across `await`s, which the
  install has none of.

### Mass-delete guard: refuse, rescan once, never halt

The guard (`pull.ts:274-282`) counts planned deletes before file apply. An
incomplete local view inflates them, and the daemon never sets
`allowMassDelete`, so a false positive would halt background sync. Contract:

- when the main line consumed a trusted view and the guard trips, pull
  throws a NEW typed error (`TrustedViewRefusalError`) **before any file
  action executes** (the guard already sits pre-apply in the main line;
  `reconcileResolutionReceipt` runs earlier but never consumes the trusted
  view, so its mutations are out of scope by construction);
- `doPull` catches it — the same shape as the existing `ManifestChainError`
  arm (`daemon.ts:2105-2124`) — and re-runs the pull **scan-backed, at most
  once per pump op**; the retry's guard behavior is today's (a scan-backed
  trip halts as designed);
- the refusal is logged (`pull local=trusted refused=mass-delete`) so the
  fleet fallback rate is observable.

This refusal mechanism exists ONLY for the pre-action mass-delete guard.
There is no post-action retry of any kind: the oracle has no planning phase —
`oracleFromPull` is constructed after `applyActions` has mutated disk
(`pull.ts:347-356`) and its verdicts become per-repo outcomes inside
`applyGitSections`, not exceptions. A stale trusted entry inside a synced
repo therefore surfaces as that repo's apply deferring (no throw, no data
loss), healed by the next covering scan — see §Combined steady state for the
bound.

## Telemetry and observability

No wire changes. The daemon pull log line gains `local=trusted|scan` (+
`refused=…` on fallback), making trusted-vs-scan rate and fallback causes
greppable per device. Extending the AE `sync_phase` schema with a source enum
is deliberately deferred: the ingest worker drops unknown fields
(`unknown_field`), so a server-side schema deploy must precede any client
emission — follow-up, not this design.

## Combined steady state (joint contract with 203)

With 202 and 203 both on, a steady-state pull scans nothing and probes only
lazily; the remaining disk cross-checks are apply's per-mutation
`expectedLocal` guard and the oracle's per-repo verdicts. The maximum window
in which memory may diverge from disk without either noticing is bounded by
the safety tick — 60s with a live watcher, 5m idle backoff, 30m deep re-hash
(`src/cli/daemon/policy.ts:6`, `:19`) — which still runs
`replaceManifestFromScan` on the same install path and heals both designs'
state. P and 203's laziness are independent gates that never read each
other; their only shared artifact is the oracle (`pull.ts:347` →
`applyGitSections` `opts.oracle`), so a 202 staleness defect can present as a
203-shaped symptom (repos silently deferring) — bisect with the kill
switches, which MUST be independent. Required tests: each switch exercised
alone, plus a both-on integration pull asserting converged state.

## Failure containment (why stale trust cannot lose data)

Apply re-stats disk before every mutation: `writeEntry` moves the current
file aside as a conflict when it doesn't match `expectedLocal`
(`src/engine/apply.ts:280-286`); `deleteEntry` never deletes on mismatch
(`apply.ts:435-452`). A wrongly-trusted manifest therefore degrades to
spurious conflict copies or per-repo git deferrals — never silent loss.
Destructive outcomes additionally require the mass-delete guard, which on
the trusted path can only trigger a rescan.

## Kill switch

`RBOX_PULL_TRUST_WATCHER=0` disables the trusted path entirely (seam and
patch). Default ON. Independent of 203's switch.

## Tests the implementation MUST write

1. Each P-condition independently false ⇒ scan path (assert `scanManifest`
   called; trusted path asserts not).
2. Trusted pull with stale entry (disk mutated behind the manifest) ⇒
   conflict copy, no loss, base advances.
3. Mass-delete trip under trusted view ⇒ `TrustedViewRefusalError`, zero
   actions executed, exactly one scan-backed re-pull in the same op;
   scan-backed trip ⇒ `MassDeleteGuardError` (today's halt).
4. Unsettled-path stripping: watcher-deferred path present in
   `this.manifest` ⇒ absent from `local`, present in oracle exemptions; a
   concurrent remote delete of that path ⇒ no local delete planned
   (design-108 pin).
5. Write-finish give-up (15 retries) ⇒ path lands in `unsettledPaths` and
   stays stripped until a covering scan or clean re-observation.
6. Single-use: chain-repair iterations, the post-repair re-pull, and the
   resolution-receipt inner pull all scan even when the op started trusted.
7. Post-pull patch: write/delete/conflict each reflected; `keepLocalAs` path
   in `unsettledPaths`; follow-up push publishes nothing spurious.
8. F2: a pull materializing a git repo ⇒ fallback scan runs ⇒
   `gitRefRegistry` sees the repo immediately.
9. F1/P4: watcher drop mid-pull ⇒ post-pull scan.
10. Drift-audit accounting: deep-scan audit opened after the pre-pull drain
    does not misclassify drained-event paths as drift.
11. Kill-switch matrix incl. the both-on integration test (§Combined steady
    state).
12. `sync_phase` sample on trusted pull records `scan` ≈ 0; log line carries
    `local=trusted`.

## Non-goals

- No change to the push path, watcher internals, or trust-state machinery.
- No wire/protocol change; the WS frame stays a content-free doorbell; no AE
  schema change (deferred, server-first).
- No dircache stamping from the patch path; scan-cadence invariants
  (safety 60s / deep 30m) unchanged.
- CLI one-shots (`rbox pull`, `rbox sync`) always scan.
- Per-repo git reconciliation cost is design 203's scope.

## Resolved decisions

- **Trusted view as a call argument, not a deps field** — makes single-use
  structural; the r1 deps-field shape leaked the stale view into chain
  repair's historical-sequence loop (r2 blocker).
- **`ManifestUpdate` provenance type (partial vs full-workspace)** — folded
  from founder ideation; kept because three mechanisms already needed the
  distinction (P5, the completeness upgrade rule, log provenance). If review
  judges it over-typed, the fallback is the plain boolean — the contracts
  stand either way.
- **`unsettledPaths` is a new durable set** — r1 assumed an existing deferred
  source; there is none (`deferredRetryPaths` gives up and forgets). The set
  also closes the silent give-up gap that predates this design.
- **Refusal-not-halt only pre-action; no post-action retry** — the r1
  "oracle mismatch degrades to retry" claim was unimplementable (the oracle
  has no planning phase); bounded single rescan prevents an oscillating
  condition from looping a pump op forever.
- **Fallback on git-topology change (F2)** rather than replicating repo
  discovery in the patch — the scan already does it correctly; topology
  changes are rare; 203 makes their git lane cheap.
- **Default ON with kill switch** per standing rule; containment is the
  existing apply guard plus the guard-refusal contract, validated by tests
  2–4.
