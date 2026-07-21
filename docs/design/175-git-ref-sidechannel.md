# 175 — Linux git-ref side-channel (a.k.a. 172B): event-driven refs for repos that appear after daemon start

Status: DRAFT v3 (2026-07-21) — r1 parallel wave folded in v2 (codex 4B+10M +
opus 4M); r2 serial review folded here (codex xhigh: 2B+5M+1m+ed,
REVIEW-175-R2-CODEX.md — both blockers were v2-fold artifacts, now closed:
reftable detection moved from filesystem layout to `extensions.refStorage`
config authority; floor formula re-based on dir-backed ownership with pointer
shapes carved out honestly). Rulings cited inline as (C-n)/(O-n)/(R2-n).
Investigation record: `RECOMMENDATION-172B.md` + `PROBE-RESULTS.md` (v2
strengthened probe: PASS 3/3 incl. populated move-in + compiled run + real
Parcel pressure ≥100 delivered events). Prereq: design 172 (shipped, v1.7.13).

## Problem (field- and rig-proven; unchanged from v1)

Design 172 gives event-driven detection of `.git`-only changes — but ONLY for
repos present at the Parcel watcher's initial crawl. Any repo that appears
afterwards (`git init`, clone, atomic move-in, worktree add) never gets its
ref surface watched: pure-`.git` commits are scan-bound at the 60s floor until
daemon restart. Rig-diagnosed as GENERAL (3-file init = 6243-file clone; run
20260720-230123). Root cause pinned in Parcel 2.5.6 source: initial subscribe
does a full FTS crawl (`InotifyBackend.cc:66-79`, `fts.cc:19-47`); the live
`IN_CREATE|IN_MOVED_TO` path adds only the one reported dir — `watchDir` never
enumerates descendants (`:151-183`, `:81-94`); live add-watch failure is
silently swallowed (`:178-183`); `IN_Q_OVERFLOW` silently discarded
(`:96-123`). Parcel 2.6.0 unchanged. macOS unaffected (single FSEvents
full-path stream; field-verified 2026-07-21).

## Fix shape: bounded Bun `fs.watch` ref side-channel (Linux + Parcel only)

A registry of per-repo ref watches on Bun's `node:fs.watch`, fed by the
engine's git discovery, signaling into 172's `SignalDebouncer` →
`request("push")`. Bun's pinned watcher provides (source-verified at
bun-v1.3.14; behavior-contract-probed):

- dynamic descendant walk of a newly-arriving dir under a recursive root
  (`path_watcher.zig:663-670`, `walkAndAdd :526-533`);
- a separate process-global inotify fd + reader thread (`:454-466`) — Parcel
  working-tree storms cannot flood the ref queue.

**Empirical gate (C-10):** the v1 probe proved arming/latency under churn but
NOT the populated-move-in descendant re-crawl, and its "flood" never actually
pressured Parcel (5–7 delivered events for 7–10k ops — it hit Parcel's own
no-recrawl blindspot). The STRENGTHENED probe (populated multi-level move-in +
mutate a pre-existing deepest descendant; pre-established Parcel dirs with a
delivered-event lower bound; root delete/recreate with (dev,ino)-reuse loop,
report-only; compiled `--compile` execution) MUST pass on Linux before the
registry implementation unit starts. Until it does, the recrawl claim rests on
verified source only.

## The classifier (C-1, O-1): semantic classes, not a boolean

`isGitRefSignal(relPath)` cannot serve the side-channel: it rejects every
`*.lock` (deliberately, 172), knows nothing of structural names, takes a
workspace relPath while `fs.watch` delivers root-relative basenames, and a
pointer repo's control dir (`repoCtxFromDisk` allows arbitrary in-tree names,
`git/shared.ts:299-328`) may contain no `.git` segment at all.

New shared classifier over `(role, tail)` where role ∈ {gitDir, commonDir,
refsRoot, refsNamespace} and tail is target-relative:

`classifyRefEvent(role, tail) → "target" | "lockPreSignal" | "structure" | "none"`

- `target`: the committed-state names per role (HEAD; packed-refs;
  refs/stash; anything under heads/ or tags/ not otherwise excluded) — SAME
  tail table as `isSignalTail` (one shared exported table constant; an
  equivalence test proves the non-lock subset matches `isGitRefSignal`
  behavior).
- `lockPreSignal`: `<target>.lock` only (see next section).
- `structure`: creation/replacement of `refs`, `heads`, `tags` under the
  owning role → registry re-arm input, never a push signal by itself.
- Everything else (`reftable` — see below, `refs/remotes`, `refs/rbox-*`)
  → `none`.

Separately, the **repo-candidate lifecycle classifier** runs in the main
watcher event path (ahead of the matcher, same seam as 172's classifier):
ANY event kind — create, update, AND delete (C-8) — on an exact path-segment
`.git` entry (dir or pointer file; exact `=== ".git"` match, same as
`git-discover.ts:39` — never `startsWith`, O-5) is a signal-only lifecycle
input: create/update request discovery; update/delete DIRTY the owning
registry generation (pointer retarget via in-place rewrite is an `update`;
delete invalidates ownership even if a recreate coalesces).

**The debouncer carries payload (R2-7):** the shared seam becomes
`SignalDebouncer.push(reason, candidate?)` — reason bits OR-accumulate, and
a BOUNDED per-owner `{dirty, discover}` map records candidate paths;
update/delete dirtiness is monotonic across a coalesced recreate. Flush
atomically snapshots and clears both, hands candidate work to targeted
registry discovery, and only THEN merges the reasons into the queued push
provenance (raising provenance at raw-event time is wrong: an already-queued
unrelated file push could dequeue first and be falsely attributed).
Candidate-map overflow requests ordinary full-plan discovery and remains
signal-only. Discovery-negative candidates are cheap no-ops.

**Backend policy (normative):** all backends keep today's `isGitRefSignal`
main-path behavior UNCHANGED (locks stay rejected there — macOS and the
Linux main path do not change; invariant 6). Only the Linux side-channel
consumes `lockPreSignal`/`structure`. Repo-candidate classification is
platform-neutral; its registry consumption exists only where the registry
exists (Linux+Parcel).

## Lock events are pre-signals — with the busy-retry that makes them sufficient (C-7)

Bun coalesces same-type events within ~1ms per handler, more broadly than its
own doc comment claims (`shouldEmit :133-144` vs comment `:124-127` — code
verified): the final `refs/heads/X` rename may be swallowed right after
`X.lock`. So an accepted lock wakes the debouncer. But a lock is only proof a
transaction STARTED: if the debounced push (quiet 400ms / max-wait 3s) reaches
planning while the lock is still held, the planner defers on `isGitBusy`
(`plan.ts:458-478`) — and today the daemon's prompt-retry machinery keys ONLY
on file deferrals. Without more, a max-wait flush can consume the only usable
pre-signal and strand the capture until the safety scan.

**Normative (R2-4, decision-complete):** `packed-refs.lock` participates in
BOTH `gitBusy` (`git/shared.ts:562-572` currently omits it) and fingerprint
invalidation (`fingerprint.ts:204-224` currently omits it) — otherwise a
trusted fast-path probe carries old packed refs without ever reaching
`isGitBusy`, reports no deferral, and schedules no retry.
`SyncDeps.onGitBusyDeferred` is the SOLE reporting seam; it is invoked
non-throwingly immediately after each completed `planGitSections` result and
before later state-save/upload/commit work (a terminal-result field would be
lost to later failures — rejected for the same reason as terminal discovery
threading). The first report opens ONE workspace episode with absolute +2s
and +8s retries; reports from those retries do not reset or extend the
episode; close cancels it; the episode resets after the second retry
(surrender to the floor). Test: transaction held past debounce AND max-wait
with the final target callback suppressed — specifically for
`packed-refs.lock` as well as a branch-ref lock — the pre-signal +
busy-retry alone must capture.

## Registry: generations, roles, and the ownership graph (C-2, C-5, C-12, O-2)

**Watch roots per unique physical repo** (unchanged from v1): shallow
`gitDir` (HEAD), shallow `commonDir` (packed-refs; notices `refs`), shallow
`commonDir/refs` (stash; notices `heads`/`tags`), recursive
`commonDir/refs/{heads,tags}`. Never watched: objects, logs, remotes,
rbox scratch, reftable, anything outside the sync root.

**Identity and replacement (C-2 — experimentally proven):** `(dev, ino)`
equality is NOT a liveness fence — codex reproduced inode reuse on this
filesystem (identical tuple after rm/recreate; only callback `rename,
filename=null`; new writes invisible). Therefore: a root-self rename or
null-filename callback, and every structure/candidate update/delete touching
a root, marks that handle's GENERATION dirty and forces detach + re-attach
regardless of stat equality. `(dev, ino)`+`ctimeNs` are diagnostics only.
Contract test: recreate until tuple reuse, then prove a mutation below the
replaced root is observed post-re-arm.

**Ownership (C-12):** contributors are stable `(repoOwner, role)` records;
accepted-name filters aggregate by refcount per `(canonicalRoot, mode)` — a
normal repo (`gitDir === commonDir`) contributes BOTH roles to one physical
handle; a linked worktree contributes only the commonDir role. Reconcile
builds the ENTIRE next desired graph before mutating the current one,
publishes newly-armed handles before retiring superseded ones, and closes a
physical handle only when its last next-generation contributor is gone.
Tests: normal+linked sharing, either owner removed, simultaneous transfer,
filter union on `gitDir===commonDir`, replacement mid-reconcile.

**Close fencing (C-5):** a monotonic `closed` bit set before the first await
in `close()`; every reconcile/attach path re-checks it after EVERY await; a
handle created after closure is closed before publication; late discovery
results arriving after close are no-ops (tested explicitly — `stop()` drains
an in-flight pump AFTER `watcher.close()`, so late results WILL happen).

**Input serialization and snapshot horizon (R2-6):** all registry inputs
enter ONE serialized reconcile pump with a monotonic input epoch; only the
latest generation may publish, and a superseded run closes any handles it
created. The safety-scan snapshot — the sole SHRINKING input — carries its
start epoch and a COMPLETENESS bit: it may remove only owners not touched by
post-start inputs, and any discovery I/O failure (note: `discoverGitRepos`
converts `readdir` failures into empty listings, `git-discover.ts:35-52` —
"completed" is not "complete") or relevant epoch advance makes the snapshot
non-shrinking and preserves the floor until a later complete snapshot.
Tests: stale attach completing after a newer generation published;
candidate-armed-repo racing an older in-flight safety snapshot (must NOT be
erased).

**Bounds (C-11, honest form per R2-3):** repo count capped at the existing
`gitRepoCap()` ceiling with deterministic selection: ALL admitted repos (dir
AND pointer) in stable path order; over-cap repos are floor-eligible, logged
once per composition. JS handles: ≤4/repo for `gitDir === commonDir`, 5 for
a pointer whose `gitDir !== commonDir`. Descriptor exposure: the strict
"bounded" claim is WITHDRAWN — Bun performs its own recursive walk after any
pre-check (`path_watcher.zig:469-477`) and a post-arm populated move-in
installs wds before JS sees anything (`:659-675`), so no pre-count bounds
lifetime descriptors. What ships instead:
- an ADMISSION heuristic: pre-arm streaming walk of `refs/{heads,tags}` —
  `opendir` streaming, no symlink following, combined heads+tags accounting,
  visited-entry ceiling (dirs default 512, entries default 8192), stop
  immediately at budget+1, any read fault ⇒ no-recursive-roots for that repo
  + pending/floor;
- a DOCUMENTED exception: growth between count and attach, or a post-arm
  populated move-in, can exceed the heuristic — the exposure is inotify wd
  exhaustion, whose failure surfaces on the NEXT attach attempt (visible,
  retried, floor-pinned) while existing watches keep working. Test both
  count-to-attach growth and post-arm move-in above budget.

**Retry/backoff (C-11), executable semantics:** per-target exponential —
base 1s, ×2, cap 60s, ±20% jitter, reset on successful attach; ONE timer
armed for the earliest pending target; a candidate/structure event before
`nextAttemptAt` marks dirty but does not preempt the timer; failures keep
desired ownership and floor eligibility. Fake-clock tests.

**Bun reader death is process-fatal (C-9):** Bun's watcher manager is
process-global, created once, never recreated; a fatal reader error emits
errors and the thread exits (`path_watcher.zig:27-70, 568-585`). On it:
close all handles, latch floor eligibility for the daemon lifetime, suppress
all further attach attempts. Recovery is daemon restart. Root attach
failures (visible, C-verified) remain retryable; reader death is not.

## Discovery and arming: three inputs, one authority (C-5, O-4 — hybrid)

v1's "thread contexts through the terminal PushResult" is DROPPED: the
terminal result misses genesis (early return, `plan.ts:217-227`), arrives
only after capture/upload/commit success, and races `stop()`.

1. **Initial:** the watcher-start `discoverGitRepos` walk (already exists,
   `watcher.ts:270`) feeds the first reconcile.
2. **Every plan (R2-5, settlement normative):**
   `SyncDeps.onGitReposDiscovered?: (repos: readonly DiscoveredGitRepo[]) =>
   Promise<void>` — the exact source contract type (`git-discover.ts:5-12`,
   `{relPath, kind}`) — is AWAITED immediately after BOTH discovery calls in
   `planGitSections` (the ordinary path AND the genesis branch, before its
   early return). It never rejects into planning; it resolves only after
   each input repo is either published as armed or recorded pending/floor
   and any arm-handshake push is queued; a closed registry resolves as a
   no-op. Initial/plan/candidate inputs are ADDITIVE UPSERTS — they never
   shrink ownership. The REGISTRY resolves contexts itself via
   `repoCtxFromDisk` (per-repo resolution failure → pending + floor, not a
   thrown plan). No `GitPushPlan` field is added; `SyncDeps` already carries
   daemon-owned observers (`deps.ts:31-75`).
3. **Candidates:** debounced targeted discovery of the candidate subtree
   only.
4. **Safety-scan completion:** full re-discovery — the ONLY input that may
   SHRINK the eligible set / clear the floor (authoritative snapshot, C-6).

**Arm-then-push handshake (O-7, normative):** after all roots for a newly
discovered or generation-replaced repo are armed, push the SignalDebouncer
once; the handshake push MUST be a real `planGitSections` push (fresh
fingerprints — a coalesced manifest-only push would reopen the gap).
Mutation-before-arming is captured by that plan; after arming, by the watch;
no gap.

## The floor: imperative, backend-independent, snapshot-cleared (C-6, O-3)

Two separate states:
- `gitSafetyFloorRequired` (backend-independent, R2-2): true iff the latest
  authoritative snapshot contains ANY in-tree repo of kind `dir`, OR any
  **dir-owned** registry root is armed/attaching/failed, OR reader-death
  latched. ONLY dir-backed ownership pins. Pointer-only and out-of-root
  pointer workspaces do NOT pin — exactly 172's shipped semantics (O-3) —
  and are therefore EXPLICITLY CARVED OUT of invariant 4 and the
  event-driven guarantee (a linked worktree whose main clone is in-root is
  covered via that clone's dir ownership; the pointer-only carve is the rare
  main-clone-outside-root case, which is scan-carried today and stays so).
  In-root pointer repos still get best-effort side-channel arming; their
  root states never feed the floor formula. Maintained from plan/scan
  snapshots, so Linux+Chokidar (no `gitRefWatchActive`, prunes `.git`) now
  gets the floor it was promised.
- `gitSidechannelActive/Pending`: handle states, for logs/telemetry only.

**Containment (R2-2):** every candidate watch root is realpath-canonicalized
and containment-checked against the sync root before attach —
`repoCtxFromDisk` is lexical-only (`git/shared.ts:299-328`) and does not
enforce invariant 5 by itself.

**Imperative pin (C-6):** the tick-time `pinToFloor` read is not enough — a
quiet tick may have armed a 120–300s timer already. Every false→true
transition of `gitSafetyFloorRequired` calls the existing `pinSafetyFloor()`
(`daemon.ts:639-656`) immediately. Transition sites enumerated: initial
discovery, plan-observer discovery, candidate-driven discovery, attach
failure, over-cap/namespace-budget disposition, reader-death latch, backend
fallback. Only the scan-completion snapshot clears it; zero-repo workspaces
release the pin (test).

## Reftable is refused, not "bounded" (C-3)

Invariant-4-as-v1 was FALSE for reftable: the common-dir fingerprint reads
`packed-refs` + loose `refs` only (`fingerprint.ts:204-224,266-295`) — a
reftable repo's safety scan can carry a stale trusted fingerprint FOREVER.
That is silent unboundedness shipping TODAY (pre-dates 175; 172 §"reftable"
recorded the exception).

**Detection authority is the repository CONFIG, not filesystem layout
(R2-1):** real reftable (`git init --ref-format=reftable`, reproduced on git
2.54) creates `.git/reftable/` AND `.git/refs/heads` as a regular sentinel
FILE — a layout predicate ("refs/heads absent") admits the exact shape it
must refuse. Normative: a single helper, used by BOTH `gitPreflight` and the
registry before attach, reads `extensions.refStorage` through the repository
and structurally refuses the exact value `reftable` for dir and pointer
repos; filesystem layout is never the authority. Because the trusted carry
path accepts a cached `preflightOk` without re-running live preflight
(`plan.ts:671-688`, `divergence-cache.ts:254-273`) and the cache file version
is the fingerprint version, this change INCREMENTS
`GIT_FINGERPRINT_SCHEMA_VERSION`, invalidating the divergence cache before
the refusal ships. Regression test: seed an old-version trusted `preflightOk`
entry for a reftable repo and prove refusal. The refusal uses the teachable
defer-message pattern (design 43 shallow precedent); reftable-aware
fingerprinting stays a non-goal. Invariant 4 then holds honestly for every
ADMITTED shape.

## Telemetry rider `git_capture` — cross-surface or not at all (C-4, C-13, O-2)

The v1 client-only rider would self-destruct: the deployed ingest normalizes
unknown kinds to `unknown_kind`, DROPS them, and still returns 202
(`telemetry-ingest.ts:142-148,216-236`), upon which the client deletes the
samples (`queue.ts:115-128`). Normative scope:

- **Provenance (boundaries per R2-8):** a pending-reason bitset {signal,
  candidate, scan, other}. EVERY enqueue flows through `requestPush(reason)`
  — the direct `want.push`/`requestPush()` sites (scan completion, pull
  completion, startup, `daemon.ts:515-516,1009-1017,1038-1042`) are
  converted: debounced ref/lock = signal, debounced `.git` lifecycle =
  candidate, completed full/deep scan = scan, startup/file/pull/retry/
  handshake = other. SNAPSHOT + cleared where `want.push` is consumed
  (`daemon.ts:998-1005`), retained across that push's internal retries
  (409/epoch recovery); reasons arriving during an active push stay pending
  for the next one. Attribution mutually exclusive by precedence
  signal > candidate > scan > other. "Successful" = every normal
  `pushManifest` return INCLUDING `committed:false`; thrown and
  terminal-blocked operations do not increment and discard only their active
  snapshot. `other` emits no `git_capture` counter. Recording happens
  immediately after the normal `pushManifest` return, before later daemon
  bookkeeping. Unit = terminal pushes, counted exactly once.
- **Client:** `git_capture { signalPushes, candidatePushes, scanPushes }`
  additive accumulator in contract.ts + queue (snapshot/removal like
  ws_health) + queue tests.
- **Server:** mirrored kind in `apps/api` telemetry contract + normalization
  + AE doubles layout + the exact-equality drift test
  (`telemetry-ingest.test.ts:61-79`) + ingest test.
- **Consumer:** the admin AE query for the chart (one documented query;
  panel wiring may follow later).
Sizing includes `apps/api/**`; deployment rides the normal dev-first flow.

## Gates and evidence matrix (C-10, C-14)

- **Bun behavior contract:** new REQUIRED CI job `bun-refwatch-contract` —
  ubuntu runner, the repo's pinned Bun (engines `^1.3.14`), runs the
  strengthened probe from SOURCE; plus `bun build --compile` execution of the
  probe wired into the two native Linux release smoke legs (linux-x64,
  linux-arm64, `release.yml:86-114`); the darwin-arm64 leg asserts ZERO
  side-channel handles instead (the probe on macOS exercises kqueue/FSEvents
  and proves nothing about inotify — the gate is Linux-only by definition).
  Any Bun version bump must pass this gate before release — this is the
  Rust-rewrite insurance: the dependency is the CONTRACT, not zig source.
- **Platform matrix (real targets):** side-channel ON: linux-x64-glibc +
  linux-arm64-glibc with Parcel available. OFF: any Parcel-unavailable
  fallback (chokidar — shares Bun's fs.watch queue with the whole tree),
  unsupported arches, darwin-arm64. Every OFF-Linux shape still gets the
  60s floor via backend-independent eligibility.
- **Rig:** `git-commit-propagation` rounds `small-repo-empty` +
  `big-repo-empty` tighten from `degrade-bounded` to `event-driven` (<30s
  ceiling). HONESTY (C-14): the scenario is not in FAST_SUITE and the e2e
  workflow has no operational self-hosted runner — this is EXPLICIT MANUAL
  VALIDATION (session-run via `sg docker` pre-merge), not a nightly gate;
  recorded as such in the PR. Rig Dockerfile Bun pin 1.3.5 → 1.3.14 first
  (comment updated — `package.json` DOES declare engines `^1.3.14`, C-15).

## Invariants (revised)

1. Ref/lock/structure/candidate signals NEVER enter `pendingEvents`,
   `onRawEvent`, the manifest, or upload. Signal-only, all of them.
2. Scanner/manifest `.git` exclusion untouched; receiver repos fsck-clean
   (rig-asserted).
3. ONE shared tail table is the classification truth: `isGitRefSignal`
   (unchanged, main path, all platforms) and `classifyRefEvent` (side-
   channel) both derive from it; equivalence on the non-lock subset is
   test-pinned. File-plane exclusion is owned by the hard-exclude
   independently of both.
4. Every failure mode of an ADMITTED, DIR-BACKED repo shape degrades toward
   the 60s floor, never silence: visible failures via retry+floor, silent
   inotify modes via floor retention, reader death via latched floor.
   Reftable is refused (config-authority, not admitted). Pointer-only and
   out-of-root pointer workspaces are EXPLICITLY outside this guarantee
   (R2-2 carve): they keep today's scan-carried behavior, best-effort
   side-channel arming, and no floor pin — 172 parity.
5. No watch authority outside the sync root.
6. macOS: implementation MUST keep the `process.platform === "linux"` gate
   on registry construction AND floor eligibility; zero side-channel handles
   on darwin (release-leg asserted); `isGitRefSignal` main-path behavior
   unchanged on every platform.

## Tests the implementation MUST write

1. Watcher-first `git init` → empty commit → signal <10s; no git path in
   `settled`/raw/`pendingEvents`.
2. `git init` in existing dir AND at workspace root → candidate → discovery
   → arm → handshake push (real plan).
3. Atomic populated move-in → converge → empty commit event-driven.
4. Nested namespace creation storm; lock pre-signals; no `.lock` in file
   plane; busy-retry captures with final rename suppressed (C-7 test).
5. Pointer repos (incl. control dirs with no `.git` segment), detached +
   linked-worktree HEAD, packed-refs, stash, branch/tag delete,
   missing-then-created namespaces, shared-common-dir role union + either
   owner removed + simultaneous transfer, out-of-root refusal.
6. Replacement: delete/recreate until (dev,ino) reuse → generation-dirty →
   re-arm → mutation observed (C-2 contract + product test).
7. Injected failures: root attach fail (backoff schedule, fake clock),
   reader-death latch (no further attempts, floor latched), over-cap,
   namespace budget exceeded, reconcile race, close-during-attach, LATE
   result after close (C-5).
8. Floor: imperative pin on each transition site; scan-snapshot clear;
   zero-repo release; pointer-only does NOT pin (172 parity); chokidar
   backend gets the floor.
9. Reftable: config-authority refusal (`extensions.refStorage`) in preflight
   AND registry pre-attach; the seeded old-version trusted `preflightOk`
   cache entry is refused post-schema-bump (R2-1); teachable message.
10. Telemetry: provenance precedence + snapshot/retention across retries +
    exactly-once terminal counting; client accumulator; server drift +
    ingest tests.
11. Strengthened probe: source-run in CI job; compiled run in release legs;
    macOS zero-handle assertion.
12. Rig (manual gate): both empty-commit rounds event-driven <30s.
13. Product-level integration flood test (F8 ruling, restored per R2-9):
    registry + debouncer + daemon seam under real Parcel churn — the
    standalone probe has no product imports and is not a substitute for
    wiring/floor-retention proof.
14. Provenance enqueue conversion: every former direct `want.push` site
    flows through `requestPush(reason)` (site-enumerated test).

## Non-goals

No macOS side-channel; no chokidar side-channel; no reftable fingerprint
support (refusal only); no Watchman; no Parcel fork; no polling; no changes
to capture/bundle/encrypt/upload/apply/purge/identity; 173/174 untouched.

## Sizing (revised, C-15)

~450–650 production lines: `src/cli/daemon/git-ref-watch.ts` (~250–320,
registry+classifier+backoff), watcher.ts (~60–100), SyncDeps observer +
plan hook (~30–50), daemon wiring + provenance (~60–90), preflight reftable
config-authority + fingerprint schema bump (~20–35), telemetry client
(~40–60), `apps/api` telemetry (~40–60), CI/release workflow edits,
Dockerfile pin, and the REQUIRED same-PR `docs/CODEMAP.md` entry for the new
module (ownership + never-own boundary, R2-9). Tests ~400–600 lines +
probe v2 (already landed).
